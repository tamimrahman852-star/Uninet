class Author {
  const Author({this.username, this.fullName, this.avatarUrl});

  final String? username;
  final String? fullName;
  final String? avatarUrl;

  String get displayName {
    if (fullName != null && fullName!.isNotEmpty) return fullName!;
    return username ?? 'User';
  }

  factory Author.fromJson(Map<String, dynamic>? json) => json == null
      ? const Author()
      : Author(username: json['username'] as String?, fullName: json['full_name'] as String?, avatarUrl: json['avatar_url'] as String?);
}

class Post {
  const Post({
    required this.id,
    required this.userId,
    required this.body,
    required this.mediaUrls,
    required this.likeCount,
    required this.commentCount,
    required this.createdAt,
    required this.author,
    this.likedByMe = false,
  });

  final String id;
  final String userId;
  final String body;
  final List<String> mediaUrls;
  final int likeCount;
  final int commentCount;
  final DateTime createdAt;
  final Author author;
  final bool likedByMe;

  Post copyWith({int? likeCount, int? commentCount, bool? likedByMe}) => Post(
        id: id,
        userId: userId,
        body: body,
        mediaUrls: mediaUrls,
        likeCount: likeCount ?? this.likeCount,
        commentCount: commentCount ?? this.commentCount,
        createdAt: createdAt,
        author: author,
        likedByMe: likedByMe ?? this.likedByMe,
      );

  factory Post.fromJson(Map<String, dynamic> json, {bool likedByMe = false}) => Post(
        id: json['id'] as String,
        userId: json['user_id'] as String,
        body: (json['body'] as String?) ?? '',
        mediaUrls: ((json['media_urls'] as List<dynamic>?) ?? const <dynamic>[]).cast<String>(),
        likeCount: (json['like_count'] as num?)?.toInt() ?? 0,
        commentCount: (json['comment_count'] as num?)?.toInt() ?? 0,
        createdAt: DateTime.parse(json['created_at'] as String),
        author: Author.fromJson(json['author'] as Map<String, dynamic>?),
        likedByMe: likedByMe,
      );
}

class PostComment {
  const PostComment({required this.id, required this.body, required this.createdAt, required this.author});

  final String id;
  final String body;
  final DateTime createdAt;
  final Author author;

  factory PostComment.fromJson(Map<String, dynamic> json) => PostComment(
        id: json['id'] as String,
        body: json['body'] as String,
        createdAt: DateTime.parse(json['created_at'] as String),
        author: Author.fromJson(json['author'] as Map<String, dynamic>?),
      );
}

class Story {
  const Story({required this.id, required this.mediaUrl, required this.createdAt, required this.author, this.caption});

  final String id;
  final String mediaUrl;
  final String? caption;
  final DateTime createdAt;
  final Author author;

  factory Story.fromJson(Map<String, dynamic> json) => Story(
        id: json['id'] as String,
        mediaUrl: json['media_url'] as String,
        caption: json['caption'] as String?,
        createdAt: DateTime.parse(json['created_at'] as String),
        author: Author.fromJson(json['author'] as Map<String, dynamic>?),
      );
}

String timeAgo(DateTime time) {
  final diff = DateTime.now().difference(time);
  if (diff.inSeconds < 60) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m';
  if (diff.inHours < 24) return '${diff.inHours}h';
  if (diff.inDays < 30) return '${diff.inDays}d';
  return '${time.day}/${time.month}/${time.year}';
}
