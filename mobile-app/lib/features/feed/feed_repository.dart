import 'package:image_picker/image_picker.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:uuid/uuid.dart';

import '../../core/constants/app_constants.dart';
import 'feed_models.dart';

/// Talks to Supabase directly (row level security protects the data); see infra/supabase/feed_schema.sql.
class FeedRepository {
  FeedRepository(this._supabase, this._userId);

  final SupabaseClient _supabase;
  final String _userId;

  static const String _postSelect = '*, author:profiles(username, full_name, avatar_url)';
  static const String _commentSelect = 'id, post_id, user_id, body, created_at, author:profiles(username, full_name, avatar_url)';

  Future<List<Post>> fetchPosts({DateTime? before, int limit = 10}) async {
    var query = _supabase.from('posts').select(_postSelect);
    if (before != null) query = query.lt('created_at', before.toUtc().toIso8601String());
    final rows = await query.order('created_at', ascending: false).limit(limit);
    if (rows.isEmpty) return <Post>[];

    final liked = await _supabase
        .from('post_likes')
        .select('post_id')
        .eq('user_id', _userId)
        .inFilter('post_id', rows.map((r) => r['id'] as String).toList());
    final likedIds = liked.map((r) => r['post_id'] as String).toSet();
    return rows.map((r) => Post.fromJson(r, likedByMe: likedIds.contains(r['id']))).toList();
  }

  Future<void> setLike(String postId, {required bool liked}) async {
    if (liked) {
      await _supabase.from('post_likes').insert(<String, dynamic>{'post_id': postId, 'user_id': _userId});
    } else {
      await _supabase.from('post_likes').delete().eq('post_id', postId).eq('user_id', _userId);
    }
  }

  Future<String> _upload(XFile file) async {
    final bytes = await file.readAsBytes();
    final name = file.name.toLowerCase();
    final ext = name.contains('.') ? name.split('.').last.replaceAll(RegExp('[^a-z0-9]'), '') : 'jpg';
    final contentType = file.mimeType ?? (ext == 'png' ? 'image/png' : 'image/jpeg');
    final path = '$_userId/${const Uuid().v4()}.${ext.isEmpty ? 'jpg' : ext}';
    await _supabase.storage.from(AppConstants.feedBucket).uploadBinary(path, bytes, fileOptions: FileOptions(contentType: contentType));
    return _supabase.storage.from(AppConstants.feedBucket).getPublicUrl(path);
  }

  Future<Post> createPost(String body, List<XFile> images) async {
    final urls = <String>[];
    for (final image in images.take(4)) {
      urls.add(await _upload(image));
    }
    final row = await _supabase
        .from('posts')
        .insert(<String, dynamic>{'user_id': _userId, 'body': body, 'media_urls': urls})
        .select(_postSelect)
        .single();
    return Post.fromJson(row);
  }

  Future<void> deletePost(String postId) async {
    await _supabase.from('posts').delete().eq('id', postId).eq('user_id', _userId);
  }

  Future<List<PostComment>> fetchComments(String postId) async {
    final rows = await _supabase.from('post_comments').select(_commentSelect).eq('post_id', postId).order('created_at', ascending: true).limit(100);
    return rows.map(PostComment.fromJson).toList();
  }

  Future<PostComment> addComment(String postId, String body) async {
    final row = await _supabase
        .from('post_comments')
        .insert(<String, dynamic>{'post_id': postId, 'user_id': _userId, 'body': body})
        .select(_commentSelect)
        .single();
    return PostComment.fromJson(row);
  }

  Future<List<Story>> fetchStories() async {
    final rows = await _supabase
        .from('stories')
        .select('id, user_id, media_url, caption, created_at, author:profiles(username, full_name, avatar_url)')
        .gt('expires_at', DateTime.now().toUtc().toIso8601String())
        .order('created_at', ascending: false)
        .limit(40);
    return rows.map(Story.fromJson).toList();
  }

  Future<void> createStory(XFile image, String caption) async {
    final url = await _upload(image);
    await _supabase.from('stories').insert(<String, dynamic>{
      'user_id': _userId,
      'media_url': url,
      if (caption.isNotEmpty) 'caption': caption,
    });
  }
}
