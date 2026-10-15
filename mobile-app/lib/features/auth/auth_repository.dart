import 'package:dio/dio.dart';

import '../../core/network/dio_client.dart';

class UserProfile {
  const UserProfile({required this.id, this.username, this.fullName, this.avatarUrl});

  final String id;
  final String? username;
  final String? fullName;
  final String? avatarUrl;

  String get displayName => (fullName?.isNotEmpty ?? false) ? fullName! : (username ?? 'User');

  factory UserProfile.fromJson(Map<String, dynamic> json) => UserProfile(
        id: json['id'] as String,
        username: json['username'] as String?,
        fullName: json['full_name'] as String?,
        avatarUrl: json['avatar_url'] as String?,
      );
}

class RegisterResult {
  const RegisterResult({required this.signedIn, required this.needsConfirmation});

  final bool signedIn;
  final bool needsConfirmation;
}

class AuthRepository {
  AuthRepository(this._api, this._sessions);

  final ApiClient _api;
  final SessionStore _sessions;

  Future<AuthSession?> restore() => _sessions.load();

  Future<AuthSession> login(String email, String password) async {
    try {
      final response = await _api.dio.post<Map<String, dynamic>>(
        '/api/v1/auth/login',
        data: <String, dynamic>{'email': email, 'password': password},
        options: Options(extra: <String, dynamic>{'auth': false}),
      );
      final session = AuthSession.fromApi(response.data!['session'] as Map<String, dynamic>);
      await _sessions.save(session);
      return session;
    } on DioException catch (e) {
      throw ApiException.from(e);
    }
  }

  Future<RegisterResult> register({
    required String email,
    required String password,
    String? fullName,
    String? username,
  }) async {
    try {
      final response = await _api.dio.post<Map<String, dynamic>>(
        '/api/v1/auth/register',
        data: <String, dynamic>{
          'email': email,
          'password': password,
          if (fullName != null && fullName.isNotEmpty) 'full_name': fullName,
          if (username != null && username.isNotEmpty) 'username': username.toLowerCase(),
        },
        options: Options(extra: <String, dynamic>{'auth': false}),
      );
      final session = response.data!['session'];
      if (session is Map<String, dynamic>) {
        await _sessions.save(AuthSession.fromApi(session));
        return const RegisterResult(signedIn: true, needsConfirmation: false);
      }
      return const RegisterResult(signedIn: false, needsConfirmation: true);
    } on DioException catch (e) {
      throw ApiException.from(e);
    }
  }

  Future<UserProfile?> fetchProfile() async {
    try {
      final response = await _api.dio.get<Map<String, dynamic>>('/api/v1/auth/me');
      final profile = response.data!['profile'];
      return profile is Map<String, dynamic> ? UserProfile.fromJson(profile) : null;
    } on DioException {
      return null;
    }
  }

  Future<void> logout() async {
    try {
      await _api.dio.post<void>('/api/v1/auth/logout', data: <String, dynamic>{'scope': 'local'});
    } on DioException {
      // the local session is cleared regardless
    }
    await _sessions.clear();
  }
}
