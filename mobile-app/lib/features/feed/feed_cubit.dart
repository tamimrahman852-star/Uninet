import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:image_picker/image_picker.dart';

import 'feed_models.dart';
import 'feed_repository.dart';

class FeedState {
  const FeedState({
    this.posts = const <Post>[],
    this.stories = const <Story>[],
    this.loading = true,
    this.loadingMore = false,
    this.hasMore = true,
    this.publishing = false,
    this.error,
  });

  final List<Post> posts;
  final List<Story> stories;
  final bool loading;
  final bool loadingMore;
  final bool hasMore;
  final bool publishing;
  final String? error;

  FeedState copyWith({
    List<Post>? posts,
    List<Story>? stories,
    bool? loading,
    bool? loadingMore,
    bool? hasMore,
    bool? publishing,
    String? error,
    bool clearError = false,
  }) {
    return FeedState(
      posts: posts ?? this.posts,
      stories: stories ?? this.stories,
      loading: loading ?? this.loading,
      loadingMore: loadingMore ?? this.loadingMore,
      hasMore: hasMore ?? this.hasMore,
      publishing: publishing ?? this.publishing,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

class FeedCubit extends Cubit<FeedState> {
  FeedCubit(this._repository) : super(const FeedState());

  static const int _pageSize = 10;
  final FeedRepository _repository;

  Future<void> load() async {
    emit(state.copyWith(loading: true, clearError: true));
    try {
      final results = await Future.wait<Object>(<Future<Object>>[_repository.fetchPosts(limit: _pageSize), _repository.fetchStories()]);
      final posts = results[0] as List<Post>;
      emit(state.copyWith(
        posts: posts,
        stories: results[1] as List<Story>,
        loading: false,
        hasMore: posts.length == _pageSize,
      ));
    } on Object {
      emit(state.copyWith(loading: false, error: 'Could not load the feed.'));
    }
  }

  Future<void> loadMore() async {
    if (state.loadingMore || !state.hasMore || state.posts.isEmpty) return;
    emit(state.copyWith(loadingMore: true));
    try {
      final more = await _repository.fetchPosts(before: state.posts.last.createdAt, limit: _pageSize);
      emit(state.copyWith(posts: <Post>[...state.posts, ...more], loadingMore: false, hasMore: more.length == _pageSize));
    } on Object {
      emit(state.copyWith(loadingMore: false, error: 'Could not load more posts.'));
    }
  }

  Future<bool> publish(String body, List<XFile> images) async {
    if (body.trim().isEmpty && images.isEmpty) return false;
    emit(state.copyWith(publishing: true, clearError: true));
    try {
      final post = await _repository.createPost(body.trim(), images);
      emit(state.copyWith(posts: <Post>[post, ...state.posts], publishing: false));
      return true;
    } on Object {
      emit(state.copyWith(publishing: false, error: 'Could not publish the post.'));
      return false;
    }
  }

  Future<void> toggleLike(Post post) async {
    final liked = !post.likedByMe;
    _replace(post.copyWith(likedByMe: liked, likeCount: (post.likeCount + (liked ? 1 : -1)).clamp(0, 1 << 30)));
    try {
      await _repository.setLike(post.id, liked: liked);
    } on Object {
      _replace(post); // roll back
    }
  }

  void _replace(Post updated) {
    emit(state.copyWith(posts: state.posts.map((p) => p.id == updated.id ? updated : p).toList()));
  }

  Future<void> delete(Post post) async {
    try {
      await _repository.deletePost(post.id);
      emit(state.copyWith(posts: state.posts.where((p) => p.id != post.id).toList()));
    } on Object {
      emit(state.copyWith(error: 'Could not delete the post.'));
    }
  }

  Future<List<PostComment>> comments(String postId) async {
    try {
      return await _repository.fetchComments(postId);
    } on Object {
      return <PostComment>[];
    }
  }

  Future<PostComment?> addComment(Post post, String body) async {
    try {
      final comment = await _repository.addComment(post.id, body);
      _replace(post.copyWith(commentCount: post.commentCount + 1));
      return comment;
    } on Object {
      return null;
    }
  }

  Future<void> addStory(XFile image, String caption) async {
    try {
      await _repository.createStory(image, caption);
      emit(state.copyWith(stories: await _repository.fetchStories()));
    } on Object {
      emit(state.copyWith(error: 'Could not publish the story.'));
    }
  }

  void clearError() => emit(state.copyWith(clearError: true));
}
