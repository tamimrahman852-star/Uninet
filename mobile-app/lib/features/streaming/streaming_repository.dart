import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../../core/constants/app_constants.dart';
import '../../core/network/dio_client.dart';
import '../feed/feed_models.dart';

class VideoItem {
  const VideoItem({
    required this.id,
    required this.userId,
    required this.title,
    required this.description,
    required this.status,
    required this.viewCount,
    required this.likeCount,
    required this.commentCount,
    required this.createdAt,
    this.durationSeconds,
    this.hlsUrl,
    this.thumbnailUrl,
  });

  final String id;
  final String userId;
  final String title;
  final String description;
  final String status;
  final int viewCount;
  final int likeCount;
  final int commentCount;
  final DateTime createdAt;
  final double? durationSeconds;
  final String? hlsUrl;
  final String? thumbnailUrl;

  VideoItem copyWith({int? likeCount}) => VideoItem(
        id: id,
        userId: userId,
        title: title,
        description: description,
        status: status,
        viewCount: viewCount,
        likeCount: likeCount ?? this.likeCount,
        commentCount: commentCount,
        createdAt: createdAt,
        durationSeconds: durationSeconds,
        hlsUrl: hlsUrl,
        thumbnailUrl: thumbnailUrl,
      );

  factory VideoItem.fromJson(Map<String, dynamic> json) => VideoItem(
        id: json['id'] as String,
        userId: json['user_id'] as String,
        title: json['title'] as String,
        description: (json['description'] as String?) ?? '',
        status: json['status'] as String,
        viewCount: (json['view_count'] as num?)?.toInt() ?? 0,
        likeCount: (json['like_count'] as num?)?.toInt() ?? 0,
        commentCount: (json['comment_count'] as num?)?.toInt() ?? 0,
        createdAt: DateTime.parse(json['created_at'] as String),
        durationSeconds: (json['duration_seconds'] as num?)?.toDouble(),
        hlsUrl: json['hls_url'] as String?,
        thumbnailUrl: json['thumbnail_url'] as String?,
      );
}

class VideoDetails {
  const VideoDetails({required this.video, required this.likedByMe});

  final VideoItem video;
  final bool likedByMe;
}

class VideoComment {
  const VideoComment({required this.id, required this.body, required this.createdAt, required this.author});

  final String id;
  final String body;
  final DateTime createdAt;
  final Author author;

  factory VideoComment.fromJson(Map<String, dynamic> json) => VideoComment(
        id: json['id'] as String,
        body: json['body'] as String,
        createdAt: DateTime.parse(json['created_at'] as String),
        author: Author.fromJson(json['author'] as Map<String, dynamic>?),
      );
}

class StreamingRepository {
  StreamingRepository(this._api);

  final ApiClient _api;

  Future<T> _guard<T>(Future<T> Function() action) async {
    try {
      return await action();
    } on DioException catch (e) {
      throw ApiException.from(e);
    }
  }

  Future<List<VideoItem>> videos({String? query, int page = 1}) => _guard(() async {
        final response = await _api.dio.get<Map<String, dynamic>>(
          '/api/v1/media/videos',
          queryParameters: <String, dynamic>{if (query != null && query.isNotEmpty) 'q': query, 'page': page, 'page_size': 30},
        );
        return (response.data!['items'] as List<dynamic>).map((v) => VideoItem.fromJson(v as Map<String, dynamic>)).toList();
      });

  Future<VideoDetails> details(String id) => _guard(() async {
        final response = await _api.dio.get<Map<String, dynamic>>('/api/v1/media/videos/$id');
        return VideoDetails(
          video: VideoItem.fromJson(response.data!['video'] as Map<String, dynamic>),
          likedByMe: (response.data!['liked_by_me'] as bool?) ?? false,
        );
      });

  Future<void> recordView(String id) => _guard(() => _api.dio.post<void>('/api/v1/media/videos/$id/view'));

  Future<void> setLike(String id, {required bool liked}) =>
      _guard(() => liked ? _api.dio.post<void>('/api/v1/media/videos/$id/like') : _api.dio.delete<void>('/api/v1/media/videos/$id/like'));

  Future<List<VideoComment>> comments(String id) => _guard(() async {
        final response = await _api.dio.get<Map<String, dynamic>>('/api/v1/media/videos/$id/comments');
        return (response.data!['items'] as List<dynamic>).map((c) => VideoComment.fromJson(c as Map<String, dynamic>)).toList();
      });

  Future<VideoComment> addComment(String id, String body) => _guard(() async {
        final response = await _api.dio.post<Map<String, dynamic>>('/api/v1/media/videos/$id/comments', data: <String, dynamic>{'body': body});
        return VideoComment.fromJson(response.data!['comment'] as Map<String, dynamic>);
      });

  Future<void> deleteVideo(String id) => _guard(() => _api.dio.delete<void>('/api/v1/media/videos/$id'));

  /// Resumable chunked upload. Returns the new video id (processing continues on the server).
  Future<String> upload({
    required File file,
    required String title,
    required String description,
    required void Function(double fraction) onProgress,
  }) =>
      _guard(() async {
        final size = await file.length();
        final name = file.path.split(Platform.pathSeparator).last;
        final lower = name.toLowerCase();
        final contentType = lower.endsWith('.mov')
            ? 'video/quicktime'
            : lower.endsWith('.webm')
                ? 'video/webm'
                : lower.endsWith('.mkv')
                    ? 'video/x-matroska'
                    : 'video/mp4';

        final init = (await _api.dio.post<Map<String, dynamic>>(
          '/api/v1/media/uploads',
          data: <String, dynamic>{'title': title, 'description': description, 'filename': name, 'size_bytes': size, 'content_type': contentType},
        ))
            .data!;
        final uploadId = init['upload_id'] as String;
        final chunkSize = (init['chunk_size'] as num).toInt();
        final totalChunks = (init['total_chunks'] as num).toInt();

        final pending = List<int>.generate(totalChunks, (i) => i);
        var sentBytes = 0;

        // Every worker owns its file handle, so chunks can be read and sent in parallel.
        Future<void> worker() async {
          final raf = await file.open();
          try {
            while (pending.isNotEmpty) {
              final index = pending.removeAt(0);
              final start = index * chunkSize;
              final length = (start + chunkSize > size) ? size - start : chunkSize;
              await raf.setPosition(start);
              final Uint8List bytes = await raf.read(length);
              for (var attempt = 1;; attempt++) {
                try {
                  await _api.dio.put<void>(
                    '/api/v1/media/uploads/$uploadId/chunks/$index',
                    data: Stream<List<int>>.value(bytes),
                    options: Options(headers: <String, dynamic>{Headers.contentLengthHeader: bytes.length}, contentType: 'application/octet-stream'),
                  );
                  sentBytes += bytes.length;
                  onProgress(sentBytes / size);
                  break;
                } on DioException catch (e) {
                  final status = e.response?.statusCode ?? 0;
                  final retryable = status == 0 || status >= 500 || status == 429;
                  if (!retryable || attempt >= 3) rethrow;
                  await Future<void>.delayed(Duration(milliseconds: 500 * (1 << attempt)));
                }
              }
            }
          } finally {
            await raf.close();
          }
        }

        final workers = totalChunks < AppConstants.maxUploadParallelism ? totalChunks : AppConstants.maxUploadParallelism;
        await Future.wait(List<Future<void>>.generate(workers, (_) => worker()));

        await _api.dio.post<void>('/api/v1/media/uploads/$uploadId/complete');
        return init['video_id'] as String;
      });
}
