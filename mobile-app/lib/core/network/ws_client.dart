import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../constants/app_constants.dart';

enum SocketStatus { idle, connecting, open, closed }

/// WebSocket client for the chat service: reconnect with exponential backoff and request/response correlation.
class ChatSocket {
  ChatSocket({required this.tokenProvider, required this.deviceId});

  final Future<String?> Function() tokenProvider;
  final String deviceId;

  final StreamController<Map<String, dynamic>> _frames = StreamController<Map<String, dynamic>>.broadcast();
  final StreamController<SocketStatus> _status = StreamController<SocketStatus>.broadcast();
  final Map<String, Completer<Map<String, dynamic>>> _pending = <String, Completer<Map<String, dynamic>>>{};
  static const Set<String> _replyTypes = <String>{'ack', 'keys.bundle', 'presence', 'error'};

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _reconnectTimer;
  int _attempts = 0;
  bool _closedByUser = false;
  SocketStatus _current = SocketStatus.idle;

  Stream<Map<String, dynamic>> get frames => _frames.stream;
  Stream<SocketStatus> get status => _status.stream;
  SocketStatus get currentStatus => _current;
  bool get isOpen => _current == SocketStatus.open;

  void _setStatus(SocketStatus value) {
    _current = value;
    if (!_status.isClosed) _status.add(value);
  }

  Future<void> connect() async {
    if (_current == SocketStatus.open || _current == SocketStatus.connecting) return;
    _closedByUser = false;
    _setStatus(SocketStatus.connecting);

    final token = await tokenProvider();
    if (token == null) {
      _setStatus(SocketStatus.closed);
      return;
    }
    final uri = Uri.parse('${AppConstants.wsUrl}/api/v1/chat/ws').replace(
      queryParameters: <String, String>{'device_id': deviceId, 'access_token': token},
    );
    final channel = WebSocketChannel.connect(uri);
    _channel = channel;

    try {
      await channel.ready;
    } on Object {
      _handleClosed(channel);
      return;
    }
    _attempts = 0;
    _setStatus(SocketStatus.open);

    _subscription = channel.stream.listen(
      _onData,
      onDone: () => _handleClosed(channel),
      onError: (Object _) => _handleClosed(channel),
      cancelOnError: true,
    );
  }

  void _onData(dynamic data) {
    if (data is! String) return;
    final Map<String, dynamic> frame;
    try {
      frame = jsonDecode(data) as Map<String, dynamic>;
    } on FormatException {
      return;
    }
    final correlationId = frame['message_id'] as String?;
    final type = frame['type'] as String?;
    if (correlationId != null && type != null && _replyTypes.contains(type)) {
      final pending = _pending.remove(correlationId);
      if (pending != null) {
        if (type == 'error') {
          final error = frame['error'] as Map<String, dynamic>?;
          pending.completeError(StateError((error?['code'] as String?) ?? 'error'));
        } else {
          pending.complete(frame);
        }
        return;
      }
    }
    _frames.add(frame);
  }

  void _handleClosed(WebSocketChannel channel) {
    if (!identical(_channel, channel)) return;
    _channel = null;
    unawaited(_subscription?.cancel());
    _subscription = null;
    for (final pending in _pending.values) {
      pending.completeError(StateError('connection_closed'));
    }
    _pending.clear();
    _setStatus(SocketStatus.closed);
    if (!_closedByUser) _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_reconnectTimer != null) return;
    final delayMs = min(30000, 1000 * pow(2, _attempts).toInt()) + Random().nextInt(500);
    _attempts += 1;
    _reconnectTimer = Timer(Duration(milliseconds: delayMs), () {
      _reconnectTimer = null;
      unawaited(connect());
    });
  }

  Future<void> close() async {
    _closedByUser = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    final channel = _channel;
    _channel = null;
    await _subscription?.cancel();
    _subscription = null;
    for (final pending in _pending.values) {
      pending.completeError(StateError('connection_closed'));
    }
    _pending.clear();
    await channel?.sink.close(1000, 'client closing');
    _setStatus(SocketStatus.closed);
  }

  bool send(Map<String, dynamic> frame) {
    final channel = _channel;
    if (channel == null || _current != SocketStatus.open) return false;
    channel.sink.add(jsonEncode(frame));
    return true;
  }

  /// Sends a frame and completes with the server reply that references its id.
  Future<Map<String, dynamic>> request(Map<String, dynamic> frame, {Duration timeout = const Duration(seconds: 8)}) {
    final id = (frame['id'] as String?) ?? const Uuid().v4();
    final completer = Completer<Map<String, dynamic>>();
    _pending[id] = completer;
    if (!send(<String, dynamic>{...frame, 'id': id})) {
      _pending.remove(id);
      completer.completeError(StateError('not_connected'));
    }
    return completer.future.timeout(timeout, onTimeout: () {
      _pending.remove(id);
      throw TimeoutException('timeout');
    });
  }

  Future<void> dispose() async {
    await close();
    await _frames.close();
    await _status.close();
  }
}
