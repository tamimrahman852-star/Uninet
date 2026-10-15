import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';

import '../../core/network/dio_client.dart';

class AiConversation {
  const AiConversation({required this.id, required this.title, required this.updatedAt});

  final String id;
  final String title;
  final DateTime updatedAt;

  factory AiConversation.fromJson(Map<String, dynamic> json) => AiConversation(
        id: json['id'] as String,
        title: json['title'] as String,
        updatedAt: DateTime.parse(json['updated_at'] as String),
      );
}

class AiSource {
  const AiSource({required this.title, required this.similarity});

  final String title;
  final double similarity;
}

class StoredMessage {
  const StoredMessage({required this.id, required this.role, required this.content});

  final String id;
  final String role;
  final String content;
}

/// Events of the server-sent-event stream of POST /api/v1/ai/chat/stream.
sealed class AiStreamEvent {
  const AiStreamEvent();
}

class AiMeta extends AiStreamEvent {
  const AiMeta({this.conversationId, this.sources = const <AiSource>[]});
  final String? conversationId;
  final List<AiSource> sources;
}

class AiToken extends AiStreamEvent {
  const AiToken(this.delta);
  final String delta;
}

class AiError extends AiStreamEvent {
  const AiError(this.message);
  final String message;
}

class AiDone extends AiStreamEvent {
  const AiDone();
}

class AiRepository {
  AiRepository(this._api);

  final ApiClient _api;

  Future<T> _guard<T>(Future<T> Function() action) async {
    try {
      return await action();
    } on DioException catch (e) {
      throw ApiException.from(e);
    }
  }

  Future<List<AiConversation>> conversations() => _guard(() async {
        final response = await _api.dio.get<Map<String, dynamic>>('/api/v1/ai/conversations', queryParameters: <String, dynamic>{'limit': 50});
        return (response.data!['conversations'] as List<dynamic>).map((c) => AiConversation.fromJson(c as Map<String, dynamic>)).toList();
      });

  Future<List<StoredMessage>> messages(String conversationId) => _guard(() async {
        final response = await _api.dio.get<Map<String, dynamic>>('/api/v1/ai/conversations/$conversationId/messages');
        return (response.data!['messages'] as List<dynamic>)
            .map((m) => StoredMessage(id: (m as Map<String, dynamic>)['id'] as String, role: m['role'] as String, content: m['content'] as String))
            .toList();
      });

  Future<void> deleteConversation(String id) => _guard(() => _api.dio.delete<void>('/api/v1/ai/conversations/$id'));

  Future<int> documentCount() async {
    try {
      final response = await _api.dio.get<Map<String, dynamic>>('/api/v1/ai/documents');
      return (response.data!['documents'] as List<dynamic>).length;
    } on DioException {
      return 0;
    }
  }

  Future<void> addDocument(String title, String content) =>
      _guard(() => _api.dio.post<void>('/api/v1/ai/documents', data: <String, dynamic>{'title': title, 'content': content}));

  /// Streams the assistant's answer token by token. Cancel through [cancelToken].
  Stream<AiStreamEvent> streamChat({
    required List<Map<String, String>> messages,
    String? conversationId,
    bool useRag = false,
    CancelToken? cancelToken,
  }) async* {
    final Response<ResponseBody> response;
    try {
      response = await _api.dio.post<ResponseBody>(
        '/api/v1/ai/chat/stream',
        data: <String, dynamic>{
          'messages': messages,
          if (conversationId != null) 'conversation_id': conversationId,
          'use_rag': useRag,
        },
        cancelToken: cancelToken,
        options: Options(
          responseType: ResponseType.stream,
          headers: <String, dynamic>{'Accept': 'text/event-stream'},
          receiveTimeout: const Duration(minutes: 5),
        ),
      );
    } on DioException catch (e) {
      if (CancelToken.isCancel(e)) return;
      yield AiError(await _errorMessage(e));
      return;
    }

    var event = 'message';
    final data = StringBuffer();
    final lines = utf8.decoder.bind(response.data!.stream).transform(const LineSplitter());
    try {
      await for (final line in lines) {
        if (line.isEmpty) {
          if (data.isNotEmpty) {
            final parsed = _parse(event, data.toString());
            if (parsed != null) yield parsed;
          }
          event = 'message';
          data.clear();
        } else if (line.startsWith(':')) {
          continue; // heartbeat
        } else if (line.startsWith('event:')) {
          event = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          if (data.isNotEmpty) data.write('\n');
          data.write(line.substring(5).trimLeft());
        }
      }
    } on DioException catch (e) {
      if (!CancelToken.isCancel(e)) yield const AiError('The connection was interrupted.');
    }
    yield const AiDone();
  }

  AiStreamEvent? _parse(String event, String raw) {
    final Map<String, dynamic> json;
    try {
      json = jsonDecode(raw) as Map<String, dynamic>;
    } on FormatException {
      return null;
    }
    switch (event) {
      case 'meta':
        final sources = ((json['sources'] as List<dynamic>?) ?? const <dynamic>[])
            .map((s) => AiSource(title: (s as Map<String, dynamic>)['title'] as String, similarity: (s['similarity'] as num).toDouble()))
            .toList();
        return AiMeta(conversationId: json['conversation_id'] as String?, sources: sources);
      case 'token':
        return AiToken((json['delta'] as String?) ?? '');
      case 'error':
        return AiError((json['message'] as String?) ?? 'The response failed.');
      default:
        return null;
    }
  }

  Future<String> _errorMessage(DioException e) async {
    final body = e.response?.data;
    if (body is ResponseBody) {
      try {
        final text = await utf8.decoder.bind(body.stream).join();
        final json = jsonDecode(text) as Map<String, dynamic>;
        final message = (json['error'] as Map<String, dynamic>?)?['message'];
        if (message is String) return message;
      } on Object {
        // fall through
      }
    }
    return ApiException.from(e).message;
  }
}
