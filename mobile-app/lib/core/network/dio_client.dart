import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../constants/app_constants.dart';

/// Tokens of the signed-in user.
class AuthSession {
  const AuthSession({
    required this.accessToken,
    required this.refreshToken,
    required this.expiresAt,
    required this.userId,
    this.email,
  });

  final String accessToken;
  final String refreshToken;

  /// Unix seconds.
  final int expiresAt;
  final String userId;
  final String? email;

  bool get isExpiringSoon => expiresAt - DateTime.now().millisecondsSinceEpoch ~/ 1000 < 60;

  factory AuthSession.fromApi(Map<String, dynamic> json) {
    final user = (json['user'] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    final expiresIn = (json['expires_in'] as num?)?.toInt() ?? 3600;
    return AuthSession(
      accessToken: json['access_token'] as String,
      refreshToken: json['refresh_token'] as String,
      expiresAt: (json['expires_at'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch ~/ 1000 + expiresIn,
      userId: user['id'] as String,
      email: user['email'] as String?,
    );
  }

  factory AuthSession.fromJson(Map<String, dynamic> json) => AuthSession(
        accessToken: json['accessToken'] as String,
        refreshToken: json['refreshToken'] as String,
        expiresAt: json['expiresAt'] as int,
        userId: json['userId'] as String,
        email: json['email'] as String?,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'accessToken': accessToken,
        'refreshToken': refreshToken,
        'expiresAt': expiresAt,
        'userId': userId,
        'email': email,
      };
}

/// Persists the session in the platform keystore / keychain.
class SessionStore {
  SessionStore([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  static const String _key = 'uninet.session';
  final FlutterSecureStorage _storage;
  final StreamController<AuthSession?> _changes = StreamController<AuthSession?>.broadcast();

  AuthSession? current;

  Stream<AuthSession?> get changes => _changes.stream;

  Future<AuthSession?> load() async {
    final raw = await _storage.read(key: _key);
    if (raw == null) return null;
    try {
      current = AuthSession.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } on Object {
      await _storage.delete(key: _key);
      current = null;
    }
    return current;
  }

  Future<void> save(AuthSession session) async {
    current = session;
    await _storage.write(key: _key, value: jsonEncode(session.toJson()));
    _changes.add(session);
  }

  Future<void> clear() async {
    current = null;
    await _storage.delete(key: _key);
    _changes.add(null);
  }
}

/// Error with the gateway's `{error: {code, message}}` shape already unpacked.
class ApiException implements Exception {
  const ApiException(this.message, {this.code = 'error', this.statusCode});

  final String message;
  final String code;
  final int? statusCode;

  factory ApiException.from(Object error) {
    if (error is ApiException) return error;
    if (error is DioException) {
      final data = error.response?.data;
      if (data is Map<String, dynamic> && data['error'] is Map<String, dynamic>) {
        final e = data['error'] as Map<String, dynamic>;
        final details = e['details'];
        var message = (e['message'] as String?) ?? 'Request failed';
        if (details is List && details.isNotEmpty && details.first is Map<String, dynamic>) {
          final first = (details.first as Map<String, dynamic>)['message'];
          if (first is String) message = first;
        }
        return ApiException(message, code: (e['code'] as String?) ?? 'error', statusCode: error.response?.statusCode);
      }
      if (error.type == DioExceptionType.connectionError || error.type == DioExceptionType.connectionTimeout) {
        return const ApiException('Cannot reach the server. Check your connection.', code: 'network');
      }
      return ApiException(error.message ?? 'Request failed', statusCode: error.response?.statusCode);
    }
    return ApiException(error.toString());
  }

  @override
  String toString() => message;
}

/// Dio client for the API gateway: adds the bearer token and transparently refreshes it once on 401.
class ApiClient {
  ApiClient(this.sessions)
      : dio = Dio(
          BaseOptions(
            baseUrl: AppConstants.apiUrl,
            connectTimeout: const Duration(seconds: 15),
            receiveTimeout: const Duration(seconds: 60),
            sendTimeout: const Duration(minutes: 5),
            headers: <String, String>{'Accept': 'application/json'},
          ),
        ),
        _plain = Dio(BaseOptions(baseUrl: AppConstants.apiUrl, connectTimeout: const Duration(seconds: 15))) {
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          if (options.extra['auth'] != false) {
            final token = await validToken();
            if (token != null) options.headers['Authorization'] = 'Bearer $token';
          }
          handler.next(options);
        },
        onError: (error, handler) async {
          final request = error.requestOptions;
          final canRetry = error.response?.statusCode == 401 &&
              request.extra['retried'] != true &&
              request.extra['auth'] != false &&
              request.data is! Stream &&
              sessions.current != null;
          if (!canRetry) {
            handler.next(error);
            return;
          }
          final refreshed = await refresh();
          if (refreshed == null) {
            handler.next(error);
            return;
          }
          try {
            request.extra['retried'] = true;
            request.headers['Authorization'] = 'Bearer ${refreshed.accessToken}';
            handler.resolve(await dio.fetch<dynamic>(request));
          } on DioException catch (retryError) {
            handler.next(retryError);
          }
        },
      ),
    );
  }

  final SessionStore sessions;
  final Dio dio;
  final Dio _plain;
  Completer<AuthSession?>? _refreshing;

  Future<String?> validToken() async {
    final session = sessions.current;
    if (session == null) return null;
    if (!session.isExpiringSoon) return session.accessToken;
    return (await refresh())?.accessToken;
  }

  /// Exchanges the refresh token for a new session; concurrent callers share one request.
  Future<AuthSession?> refresh() async {
    final inFlight = _refreshing;
    if (inFlight != null) return inFlight.future;
    final current = sessions.current;
    if (current == null) return null;

    final completer = Completer<AuthSession?>();
    _refreshing = completer;
    try {
      final response = await _plain.post<Map<String, dynamic>>(
        '/api/v1/auth/refresh',
        data: <String, dynamic>{'refresh_token': current.refreshToken},
      );
      final session = AuthSession.fromApi((response.data!['session'] as Map<String, dynamic>));
      await sessions.save(session);
      completer.complete(session);
    } on DioException catch (e) {
      final status = e.response?.statusCode;
      if (status == 401 || status == 400) {
        await sessions.clear(); // refresh token revoked or expired
        completer.complete(null);
      } else {
        completer.complete(current); // transient failure: keep going with what we have
      }
    } finally {
      _refreshing = null;
    }
    return completer.future;
  }
}
