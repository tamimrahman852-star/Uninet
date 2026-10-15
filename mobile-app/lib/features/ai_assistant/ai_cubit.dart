import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:uuid/uuid.dart';

import '../../core/network/dio_client.dart';
import 'ai_repository.dart';

class AiMessage {
  const AiMessage({required this.id, required this.role, required this.content, this.pending = false, this.error = false, this.sources = const <AiSource>[]});

  final String id;
  final String role;
  final String content;
  final bool pending;
  final bool error;
  final List<AiSource> sources;

  AiMessage copyWith({String? content, bool? pending, bool? error, List<AiSource>? sources}) => AiMessage(
        id: id,
        role: role,
        content: content ?? this.content,
        pending: pending ?? this.pending,
        error: error ?? this.error,
        sources: sources ?? this.sources,
      );
}

class AiState {
  const AiState({
    this.messages = const <AiMessage>[],
    this.conversationId,
    this.conversations = const <AiConversation>[],
    this.streaming = false,
    this.useRag = false,
    this.documentCount = 0,
    this.notice,
  });

  final List<AiMessage> messages;
  final String? conversationId;
  final List<AiConversation> conversations;
  final bool streaming;
  final bool useRag;
  final int documentCount;
  final String? notice;

  AiState copyWith({
    List<AiMessage>? messages,
    String? conversationId,
    bool clearConversation = false,
    List<AiConversation>? conversations,
    bool? streaming,
    bool? useRag,
    int? documentCount,
    String? notice,
    bool clearNotice = false,
  }) {
    return AiState(
      messages: messages ?? this.messages,
      conversationId: clearConversation ? null : (conversationId ?? this.conversationId),
      conversations: conversations ?? this.conversations,
      streaming: streaming ?? this.streaming,
      useRag: useRag ?? this.useRag,
      documentCount: documentCount ?? this.documentCount,
      notice: clearNotice ? null : (notice ?? this.notice),
    );
  }
}

class AiCubit extends Cubit<AiState> {
  AiCubit(this._repository) : super(const AiState());

  final AiRepository _repository;
  CancelToken? _cancel;

  Future<void> load() async {
    try {
      final results = await Future.wait<Object>(<Future<Object>>[_repository.conversations(), _repository.documentCount()]);
      emit(state.copyWith(conversations: results[0] as List<AiConversation>, documentCount: results[1] as int));
    } on ApiException {
      // history is optional
    }
  }

  void setUseRag(bool value) => emit(state.copyWith(useRag: value));

  void newChat() {
    _cancel?.cancel();
    emit(state.copyWith(messages: const <AiMessage>[], clearConversation: true, streaming: false));
  }

  Future<void> openConversation(String id) async {
    try {
      final stored = await _repository.messages(id);
      emit(state.copyWith(
        conversationId: id,
        messages: stored.map((m) => AiMessage(id: m.id, role: m.role, content: m.content)).toList(),
      ));
    } on ApiException catch (e) {
      emit(state.copyWith(notice: e.message));
    }
  }

  Future<void> deleteConversation(String id) async {
    try {
      await _repository.deleteConversation(id);
      if (state.conversationId == id) newChat();
      await load();
    } on ApiException catch (e) {
      emit(state.copyWith(notice: e.message));
    }
  }

  Future<void> addDocument(String title, String content) async {
    try {
      await _repository.addDocument(title, content);
      emit(state.copyWith(documentCount: state.documentCount + 1, useRag: true, notice: 'Added to your knowledge base'));
    } on ApiException catch (e) {
      emit(state.copyWith(notice: e.message));
    }
  }

  void clearNotice() => emit(state.copyWith(clearNotice: true));

  void stop() => _cancel?.cancel();

  Future<void> send(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty || state.streaming) return;

    final userMessage = AiMessage(id: const Uuid().v4(), role: 'user', content: trimmed);
    final assistantId = const Uuid().v4();
    final history = <AiMessage>[...state.messages.where((m) => !m.error), userMessage];
    emit(state.copyWith(
      messages: <AiMessage>[...history, AiMessage(id: assistantId, role: 'assistant', content: '', pending: true)],
      streaming: true,
      clearNotice: true,
    ));

    void patch(AiMessage Function(AiMessage) change) {
      emit(state.copyWith(messages: state.messages.map((m) => m.id == assistantId ? change(m) : m).toList()));
    }

    final cancel = CancelToken();
    _cancel = cancel;
    try {
      await for (final event in _repository.streamChat(
        messages: history.map((m) => <String, String>{'role': m.role, 'content': m.content}).toList(),
        conversationId: state.conversationId,
        useRag: state.useRag,
        cancelToken: cancel,
      )) {
        switch (event) {
          case AiMeta(:final conversationId, :final sources):
            if (conversationId != null) emit(state.copyWith(conversationId: conversationId));
            if (sources.isNotEmpty) patch((m) => m.copyWith(sources: sources));
          case AiToken(:final delta):
            patch((m) => m.copyWith(content: m.content + delta));
          case AiError(:final message):
            patch((m) => m.copyWith(pending: false, error: true, content: m.content.isEmpty ? message : m.content));
          case AiDone():
            patch((m) => m.copyWith(pending: false));
        }
      }
    } finally {
      if (!isClosed) {
        patch((m) => m.copyWith(pending: false));
        emit(state.copyWith(streaming: false));
        unawaited(load());
      }
      _cancel = null;
    }
  }

  @override
  Future<void> close() {
    _cancel?.cancel();
    return super.close();
  }
}
