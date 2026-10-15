import 'dart:async';
import 'dart:convert';

import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import 'chat_models.dart';
import 'chat_repository.dart';

class ChatState {
  const ChatState({
    this.connected = false,
    this.peers = const <String, ChatPeer>{},
    this.messages = const <String, List<ChatMessage>>{},
    this.activePeerId,
    this.error,
    this.cursors = const <String, int?>{},
  });

  final bool connected;
  final Map<String, ChatPeer> peers;
  final Map<String, List<ChatMessage>> messages;
  final String? activePeerId;
  final String? error;

  /// Pagination cursor of stored history per peer (null = nothing older).
  final Map<String, int?> cursors;

  int get totalUnread => peers.values.fold(0, (sum, p) => sum + p.unread);

  List<ChatPeer> get sortedPeers {
    final list = peers.values.toList()..sort((a, b) => b.lastTs.compareTo(a.lastTs));
    return list;
  }

  ChatState copyWith({
    bool? connected,
    Map<String, ChatPeer>? peers,
    Map<String, List<ChatMessage>>? messages,
    String? activePeerId,
    bool clearActive = false,
    String? error,
    bool clearError = false,
    Map<String, int?>? cursors,
  }) {
    return ChatState(
      connected: connected ?? this.connected,
      peers: peers ?? this.peers,
      messages: messages ?? this.messages,
      activePeerId: clearActive ? null : (activePeerId ?? this.activePeerId),
      error: clearError ? null : (error ?? this.error),
      cursors: cursors ?? this.cursors,
    );
  }
}

class ChatCubit extends Cubit<ChatState> {
  ChatCubit(this._repository, this._userId) : super(const ChatState());

  static const int _maxMessagesPerPeer = 300;

  final ChatRepository _repository;
  final String _userId;
  StreamSubscription<ChatEvent>? _subscription;
  Timer? _saveTimer;
  Timer? _typingStop;
  final Map<String, Timer> _typingTimers = <String, Timer>{};
  final Set<String> _historyLoaded = <String>{};
  DateTime _typingSentAt = DateTime.fromMillisecondsSinceEpoch(0);

  String get _prefsKey => 'uninet.chat.$_userId';

  Future<void> start() async {
    await _restore();
    _subscription ??= _repository.events.listen(_onEvent);
    try {
      await _repository.start(_userId);
    } on Object {
      emit(state.copyWith(error: 'Could not start encrypted chat on this device.'));
    }
  }

  /* ------------------------------ persistence ------------------------------ */

  Future<void> _restore() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_prefsKey);
    if (raw == null) return;
    try {
      final data = jsonDecode(raw) as Map<String, dynamic>;
      final peers = <String, ChatPeer>{
        for (final p in (data['peers'] as List<dynamic>)) (p as Map<String, dynamic>)['id'] as String: ChatPeer.fromJson(p),
      };
      final messages = <String, List<ChatMessage>>{
        for (final entry in (data['messages'] as Map<String, dynamic>).entries)
          entry.key: (entry.value as List<dynamic>).map((m) => ChatMessage.fromJson(m as Map<String, dynamic>)).toList(),
      };
      emit(state.copyWith(peers: peers, messages: messages));
    } on Object {
      await prefs.remove(_prefsKey);
    }
  }

  void _scheduleSave() {
    _saveTimer?.cancel();
    _saveTimer = Timer(const Duration(milliseconds: 600), () async {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        _prefsKey,
        jsonEncode(<String, dynamic>{
          'peers': state.peers.values.map((p) => p.toJson()).toList(),
          'messages': state.messages.map((k, v) => MapEntry<String, dynamic>(k, v.map((m) => m.toJson()).toList())),
        }),
      );
    });
  }

  /// Removes the locally stored plaintext (used on sign-out).
  Future<void> wipeLocalData() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_prefsKey);
  }

  /* ------------------------------ events ------------------------------ */

  void _onEvent(ChatEvent event) {
    switch (event) {
      case IncomingMessageEvent(:final message):
        _addMessage(message);
        if (!message.mine && message.status == MessageStatus.received) {
          final active = state.activePeerId == message.peerId;
          _repository.sendReceipt(message.peerId, message.id, read: active);
          if (active) _setStatus(message.peerId, message.id, MessageStatus.read);
        }
      case ReceiptEvent(:final peerId, :final messageId, :final status):
        _setStatus(peerId, messageId, status);
      case TypingEvent(:final peerId, :final typing):
        _setTyping(peerId, typing);
      case ConnectionEvent(:final open):
        emit(state.copyWith(connected: open));
        final active = state.activePeerId;
        if (open && active != null) unawaited(_loadHistoryOnce(active));
    }
  }

  void _addMessage(ChatMessage message) {
    final existing = state.messages[message.peerId] ?? const <ChatMessage>[];
    if (existing.any((m) => m.id == message.id)) return;
    final list = <ChatMessage>[...existing, message]..sort((a, b) => a.ts.compareTo(b.ts));
    final trimmed = list.length > _maxMessagesPerPeer ? list.sublist(list.length - _maxMessagesPerPeer) : list;

    final peer = state.peers[message.peerId] ?? ChatPeer(id: message.peerId);
    final active = state.activePeerId == message.peerId;
    final updatedPeer = peer.copyWith(
      lastTs: message.ts > peer.lastTs ? message.ts : peer.lastTs,
      unread: (message.mine || active || message.status == MessageStatus.read) ? peer.unread : peer.unread + 1,
    );
    final isNewPeer = !state.peers.containsKey(message.peerId);
    emit(state.copyWith(
      messages: <String, List<ChatMessage>>{...state.messages, message.peerId: trimmed},
      peers: <String, ChatPeer>{...state.peers, message.peerId: updatedPeer},
    ));
    if (isNewPeer) unawaited(_resolvePeer(message.peerId));
    _scheduleSave();
  }

  void _setStatus(String peerId, String messageId, MessageStatus status) {
    final list = state.messages[peerId];
    if (list == null) return;
    emit(state.copyWith(
      messages: <String, List<ChatMessage>>{
        ...state.messages,
        peerId: list.map((m) => m.id == messageId ? m.copyWith(status: status) : m).toList(),
      },
    ));
    _scheduleSave();
  }

  void _setTyping(String peerId, bool typing) {
    final peer = state.peers[peerId];
    if (peer == null) return;
    emit(state.copyWith(peers: <String, ChatPeer>{...state.peers, peerId: peer.copyWith(typing: typing)}));
    _typingTimers.remove(peerId)?.cancel();
    if (typing) {
      _typingTimers[peerId] = Timer(const Duration(seconds: 5), () => _setTyping(peerId, false));
    }
  }

  Future<void> _resolvePeer(String peerId) async {
    try {
      final profile = await _repository.fetchProfile(peerId);
      if (profile == null) return;
      final peer = state.peers[peerId] ?? ChatPeer(id: peerId);
      emit(state.copyWith(
        peers: <String, ChatPeer>{
          ...state.peers,
          peerId: peer.copyWith(username: profile.username, fullName: profile.fullName, avatarUrl: profile.avatarUrl),
        },
      ));
      _scheduleSave();
    } on Object {
      // names are optional
    }
  }

  /* ------------------------------ actions ------------------------------ */

  void addPeer(ProfileResult profile) {
    final existing = state.peers[profile.id] ?? ChatPeer(id: profile.id);
    emit(state.copyWith(
      peers: <String, ChatPeer>{
        ...state.peers,
        profile.id: existing.copyWith(username: profile.username, fullName: profile.fullName, avatarUrl: profile.avatarUrl),
      },
    ));
    _scheduleSave();
  }

  Future<void> openPeer(String peerId) async {
    final peer = state.peers[peerId] ?? ChatPeer(id: peerId);
    emit(state.copyWith(
      activePeerId: peerId,
      clearError: true,
      peers: <String, ChatPeer>{...state.peers, peerId: peer.copyWith(unread: 0)},
    ));
    for (final message in state.messages[peerId] ?? const <ChatMessage>[]) {
      if (!message.mine && message.status == MessageStatus.received) {
        _repository.sendReceipt(peerId, message.id, read: true);
        _setStatus(peerId, message.id, MessageStatus.read);
      }
    }
    unawaited(_refreshPresence(peerId));
    unawaited(_loadHistoryOnce(peerId));
  }

  void closePeer() => emit(state.copyWith(clearActive: true));

  Future<void> _refreshPresence(String peerId) async {
    final online = await _repository.queryPresence(peerId);
    final peer = state.peers[peerId];
    if (peer != null && !isClosed) {
      emit(state.copyWith(peers: <String, ChatPeer>{...state.peers, peerId: peer.copyWith(online: online)}));
    }
  }

  Future<void> _loadHistoryOnce(String peerId) async {
    if (!state.connected || _historyLoaded.contains(peerId)) return;
    _historyLoaded.add(peerId);
    final cursor = await _repository.loadHistory(peerId);
    if (!isClosed) emit(state.copyWith(cursors: <String, int?>{...state.cursors, peerId: cursor}));
  }

  Future<void> loadOlder(String peerId) async {
    final cursor = state.cursors[peerId];
    if (cursor == null) return;
    final next = await _repository.loadHistory(peerId, before: cursor);
    if (!isClosed) emit(state.copyWith(cursors: <String, int?>{...state.cursors, peerId: next == cursor ? null : next}));
  }

  Future<void> sendText(String peerId, String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    final id = const Uuid().v4();
    _typingStop?.cancel();
    _repository.sendTyping(peerId, typing: false);
    _addMessage(ChatMessage(id: id, peerId: peerId, mine: true, text: trimmed, ts: DateTime.now().millisecondsSinceEpoch, status: MessageStatus.sending));
    try {
      final status = await _repository.sendText(messageId: id, peerId: peerId, text: trimmed);
      _setStatus(peerId, id, status == 'relayed' ? MessageStatus.sent : MessageStatus.queued);
    } on Object catch (error) {
      _setStatus(peerId, id, MessageStatus.failed);
      final message = error.toString().contains('keys_not_found')
          ? 'This user has not set up encrypted chat yet.'
          : 'Message could not be sent. Check your connection.';
      emit(state.copyWith(error: message));
    }
  }

  void onTextChanged(String peerId) {
    final now = DateTime.now();
    if (now.difference(_typingSentAt) > const Duration(seconds: 3)) {
      _typingSentAt = now;
      _repository.sendTyping(peerId, typing: true);
    }
    _typingStop?.cancel();
    _typingStop = Timer(const Duration(seconds: 2), () => _repository.sendTyping(peerId, typing: false));
  }

  Future<List<ProfileResult>> search(String query) => _repository.searchProfiles(query);

  Future<void> shutdown() async {
    await _repository.stop();
  }

  @override
  Future<void> close() async {
    _saveTimer?.cancel();
    _typingStop?.cancel();
    for (final timer in _typingTimers.values) {
      timer.cancel();
    }
    await _subscription?.cancel();
    await _repository.stop();
    return super.close();
  }
}
