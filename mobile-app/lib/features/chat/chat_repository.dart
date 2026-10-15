import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:uuid/uuid.dart';

import '../../core/network/dio_client.dart';
import '../../core/network/ws_client.dart';
import 'chat_models.dart';
import 'e2ee_service.dart';

class ProfileResult {
  const ProfileResult({required this.id, this.username, this.fullName, this.avatarUrl});

  final String id;
  final String? username;
  final String? fullName;
  final String? avatarUrl;

  factory ProfileResult.fromJson(Map<String, dynamic> json) => ProfileResult(
        id: json['id'] as String,
        username: json['username'] as String?,
        fullName: json['full_name'] as String?,
        avatarUrl: json['avatar_url'] as String?,
      );
}

/// Owns the WebSocket and the E2EE layer. All plaintext handling stays in this class.
class ChatRepository {
  ChatRepository({
    required this.api,
    required this.supabase,
    required this.e2ee,
  });

  final ApiClient api;
  final SupabaseClient supabase;
  final E2eeService e2ee;

  final StreamController<ChatEvent> _events = StreamController<ChatEvent>.broadcast();
  final Map<String, ({PeerBundle bundle, DateTime fetchedAt})> _bundles = <String, ({PeerBundle bundle, DateTime fetchedAt})>{};
  static const Duration _bundleTtl = Duration(minutes: 10);

  ChatSocket? _socket;
  StreamSubscription<Map<String, dynamic>>? _frameSub;
  StreamSubscription<SocketStatus>? _statusSub;
  String? _userId;

  Stream<ChatEvent> get events => _events.stream;
  bool get isStarted => _socket != null;

  Future<void> start(String userId) async {
    if (_userId == userId && _socket != null) return;
    await stop();
    _userId = userId;
    await e2ee.init(userId);

    final prefs = await SharedPreferences.getInstance();
    var deviceId = prefs.getString('uninet.device_id');
    if (deviceId == null) {
      deviceId = const Uuid().v4();
      await prefs.setString('uninet.device_id', deviceId);
    }

    final socket = ChatSocket(tokenProvider: api.validToken, deviceId: deviceId);
    _socket = socket;
    _frameSub = socket.frames.listen((frame) => unawaited(_onFrame(frame)));
    _statusSub = socket.status.listen((status) {
      _events.add(ConnectionEvent(status == SocketStatus.open));
      if (status == SocketStatus.open) unawaited(_publishKeys());
    });
    await socket.connect();
  }

  Future<void> stop() async {
    await _frameSub?.cancel();
    await _statusSub?.cancel();
    await _socket?.dispose();
    _frameSub = null;
    _statusSub = null;
    _socket = null;
    _userId = null;
    _bundles.clear();
    _events.add(const ConnectionEvent(false));
  }

  Future<void> _publishKeys() async {
    final bundle = e2ee.publicBundle;
    try {
      await _socket?.request(<String, dynamic>{
        'type': 'keys.publish',
        'keys': <String, dynamic>{
          'identity_key': bundle.identityKey,
          'signed_prekey': bundle.signedPrekey,
          'signed_prekey_signature': bundle.signedPrekeySignature,
        },
      });
    } on Object {
      // retried on the next reconnect
    }
  }

  Future<PeerBundle> _bundleFor(String peerId) async {
    final cached = _bundles[peerId];
    if (cached != null && DateTime.now().difference(cached.fetchedAt) < _bundleTtl) return cached.bundle;
    final socket = _socket;
    if (socket == null) throw StateError('not_connected');
    final reply = await socket.request(<String, dynamic>{'type': 'keys.fetch', 'user_id': peerId});
    final keys = reply['keys'] as Map<String, dynamic>?;
    if (keys == null) throw StateError('keys_not_found');
    final bundle = PeerBundle(
      identityKey: keys['identity_key'] as String,
      signedPrekey: keys['signed_prekey'] as String,
      signedPrekeySignature: keys['signed_prekey_signature'] as String,
    );
    _bundles[peerId] = (bundle: bundle, fetchedAt: DateTime.now());
    return bundle;
  }

  /* ---------------------------- outgoing ---------------------------- */

  /// Encrypts and sends. Returns the server status ("relayed" | "queued").
  Future<String> sendText({required String messageId, required String peerId, required String text}) async {
    final socket = _socket;
    final userId = _userId;
    if (socket == null || userId == null) throw StateError('not_connected');
    final bundle = await _bundleFor(peerId);
    final payload = await e2ee.encryptFor(myId: userId, peerId: peerId, bundle: bundle, plaintext: jsonEncode(<String, dynamic>{'t': text}));
    final ack = await socket.request(
      <String, dynamic>{'type': 'message', 'id': messageId, 'to': peerId, 'header': payload.header, 'ciphertext': payload.ciphertext},
      timeout: const Duration(seconds: 10),
    );
    return (ack['status'] as String?) ?? 'queued';
  }

  void sendTyping(String peerId, {required bool typing}) {
    _socket?.send(<String, dynamic>{'type': 'typing', 'to': peerId, 'status': typing ? 'start' : 'stop'});
  }

  void sendReceipt(String peerId, String messageId, {required bool read}) {
    _socket?.send(<String, dynamic>{'type': 'receipt', 'to': peerId, 'message_id': messageId, 'status': read ? 'read' : 'delivered'});
  }

  /// Requests an older page of stored ciphertext (arrives as message frames); returns the next cursor.
  Future<int?> loadHistory(String peerId, {int? before}) async {
    final socket = _socket;
    if (socket == null) return null;
    try {
      final reply = await socket.request(
        <String, dynamic>{'type': 'history.fetch', 'user_id': peerId, if (before != null) 'server_ts': before, 'limit': 50},
        timeout: const Duration(seconds: 15),
      );
      final cursor = (reply['server_ts'] as num?)?.toInt();
      return (cursor == null || cursor == 0) ? null : cursor;
    } on Object {
      return null;
    }
  }

  Future<bool> queryPresence(String peerId) async {
    try {
      final reply = await _socket?.request(<String, dynamic>{'type': 'presence.query', 'user_id': peerId});
      return (reply?['online'] as bool?) ?? false;
    } on Object {
      return false;
    }
  }

  /* ---------------------------- profiles ---------------------------- */

  Future<ProfileResult?> fetchProfile(String id) async {
    final row = await supabase.from('profiles').select('id, username, full_name, avatar_url').eq('id', id).maybeSingle();
    return row == null ? null : ProfileResult.fromJson(row);
  }

  Future<List<ProfileResult>> searchProfiles(String query) async {
    final q = query.replaceAll(RegExp(r'[%,()*]'), ' ').trim();
    if (q.length < 2) return <ProfileResult>[];
    final rows = await supabase
        .from('profiles')
        .select('id, username, full_name, avatar_url')
        .or('username.ilike.%$q%,full_name.ilike.%$q%')
        .neq('id', _userId ?? '')
        .limit(10);
    return rows.map(ProfileResult.fromJson).toList();
  }

  /* ---------------------------- incoming ---------------------------- */

  Future<void> _onFrame(Map<String, dynamic> frame) async {
    switch (frame['type']) {
      case 'message':
        await _onMessage(frame);
      case 'receipt':
        final from = frame['from'] as String?;
        final messageId = frame['message_id'] as String?;
        if (from != null && messageId != null) {
          _events.add(ReceiptEvent(
            peerId: from,
            messageId: messageId,
            status: frame['status'] == 'read' ? MessageStatus.read : MessageStatus.delivered,
          ));
        }
      case 'typing':
        final from = frame['from'] as String?;
        if (from != null) _events.add(TypingEvent(peerId: from, typing: frame['status'] == 'start'));
    }
  }

  Future<void> _onMessage(Map<String, dynamic> frame) async {
    final userId = _userId;
    final from = frame['from'] as String?;
    final id = frame['id'] as String?;
    final header = frame['header'] as String?;
    final ciphertext = frame['ciphertext'] as String?;
    if (userId == null || from == null || id == null || header == null || ciphertext == null) return;
    final ts = (frame['server_ts'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch;
    final isHistory = frame['status'] == 'history';

    if (from == userId) {
      // Our own message replayed from history: only the recipient can decrypt it.
      final to = frame['to'] as String?;
      if (to != null) {
        _events.add(IncomingMessageEvent(ChatMessage(id: id, peerId: to, mine: true, text: '[Sent from another session]', ts: ts, status: MessageStatus.sent)));
      }
      return;
    }

    var text = '[Unable to decrypt this message]';
    bool? verified;
    try {
      String? senderIdentity;
      try {
        senderIdentity = (await _bundleFor(from)).identityKey;
      } on Object {
        senderIdentity = null;
      }
      final result = await e2ee.decryptFrom(
        myId: userId,
        senderId: from,
        header: header,
        ciphertext: ciphertext,
        senderIdentityKey: senderIdentity,
      );
      text = _extractText(result.text);
      verified = result.verified;
    } on Object {
      // keep the placeholder
    }

    _events.add(IncomingMessageEvent(ChatMessage(
      id: id,
      peerId: from,
      mine: false,
      text: text,
      ts: ts,
      status: isHistory ? MessageStatus.read : MessageStatus.received,
      verified: verified,
    )));
  }

  String _extractText(String json) {
    try {
      final decoded = jsonDecode(json);
      if (decoded is Map<String, dynamic> && decoded['t'] is String) return decoded['t'] as String;
    } on FormatException {
      // fall through
    }
    return json;
  }
}
