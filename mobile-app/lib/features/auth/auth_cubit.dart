import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/network/dio_client.dart';
import 'auth_repository.dart';

enum AuthStatus { unknown, authenticated, unauthenticated }

class AuthState extends Equatable {
  const AuthState({
    this.status = AuthStatus.unknown,
    this.userId,
    this.email,
    this.profile,
    this.loading = false,
    this.error,
    this.info,
  });

  final AuthStatus status;
  final String? userId;
  final String? email;
  final UserProfile? profile;
  final bool loading;
  final String? error;
  final String? info;

  AuthState copyWith({
    AuthStatus? status,
    String? userId,
    String? email,
    UserProfile? profile,
    bool? loading,
    String? error,
    String? info,
    bool clearError = false,
    bool clearInfo = false,
  }) {
    return AuthState(
      status: status ?? this.status,
      userId: userId ?? this.userId,
      email: email ?? this.email,
      profile: profile ?? this.profile,
      loading: loading ?? this.loading,
      error: clearError ? null : (error ?? this.error),
      info: clearInfo ? null : (info ?? this.info),
    );
  }

  @override
  List<Object?> get props => <Object?>[status, userId, email, profile, loading, error, info];
}

class AuthCubit extends Cubit<AuthState> {
  AuthCubit(this._repository, this._sessions) : super(const AuthState()) {
    _subscription = _sessions.changes.listen((session) {
      if (session == null && state.status == AuthStatus.authenticated) {
        emit(const AuthState(status: AuthStatus.unauthenticated)); // refresh token rejected
      }
    });
  }

  final AuthRepository _repository;
  final SessionStore _sessions;
  late final StreamSubscription<AuthSession?> _subscription;

  Future<void> start() async {
    final session = await _repository.restore();
    if (session == null) {
      emit(const AuthState(status: AuthStatus.unauthenticated));
      return;
    }
    _emitAuthenticated(session);
    unawaited(_loadProfile());
  }

  void _emitAuthenticated(AuthSession session) {
    emit(AuthState(status: AuthStatus.authenticated, userId: session.userId, email: session.email));
  }

  Future<void> _loadProfile() async {
    final profile = await _repository.fetchProfile();
    if (profile != null && !isClosed) emit(state.copyWith(profile: profile));
  }

  Future<bool> login(String email, String password) async {
    emit(state.copyWith(loading: true, clearError: true, clearInfo: true));
    try {
      final session = await _repository.login(email.trim(), password);
      _emitAuthenticated(session);
      unawaited(_loadProfile());
      return true;
    } on ApiException catch (e) {
      emit(state.copyWith(loading: false, error: e.message));
      return false;
    }
  }

  Future<bool> register({required String email, required String password, String? fullName, String? username}) async {
    emit(state.copyWith(loading: true, clearError: true, clearInfo: true));
    try {
      final result = await _repository.register(email: email.trim(), password: password, fullName: fullName?.trim(), username: username?.trim());
      if (result.signedIn) {
        final session = _sessions.current;
        if (session != null) _emitAuthenticated(session);
        unawaited(_loadProfile());
      } else {
        emit(state.copyWith(loading: false, info: 'Check your email to confirm your account, then sign in.'));
      }
      return true;
    } on ApiException catch (e) {
      emit(state.copyWith(loading: false, error: e.message));
      return false;
    }
  }

  Future<void> logout() async {
    await _repository.logout();
    emit(const AuthState(status: AuthStatus.unauthenticated));
  }

  void clearMessages() => emit(state.copyWith(clearError: true, clearInfo: true));

  @override
  Future<void> close() async {
    await _subscription.cancel();
    return super.close();
  }
}
