import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:image_picker/image_picker.dart';

import '../auth/profile_menu.dart';
import 'create_post_screen.dart';
import 'feed_cubit.dart';
import 'feed_models.dart';

class FeedScreen extends StatefulWidget {
  const FeedScreen({super.key, required this.currentUserId});

  final String currentUserId;

  @override
  State<FeedScreen> createState() => _FeedScreenState();
}

class _FeedScreenState extends State<FeedScreen> {
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    context.read<FeedCubit>().load();
    _scroll.addListener(() {
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 400) context.read<FeedCubit>().loadMore();
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _addStory() async {
    final cubit = context.read<FeedCubit>();
    final image = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1600, imageQuality: 85);
    if (image == null || !mounted) return;
    final captionController = TextEditingController();
    final caption = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Add a caption'),
        content: TextField(controller: captionController, maxLength: 200, decoration: const InputDecoration(hintText: 'Optional')),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.of(context).pop(''), child: const Text('Skip')),
          FilledButton(onPressed: () => Navigator.of(context).pop(captionController.text.trim()), child: const Text('Share')),
        ],
      ),
    );
    captionController.dispose();
    if (caption == null) return;
    await cubit.addStory(image, caption);
  }

  void _openStory(Story story) {
    showDialog<void>(
      context: context,
      builder: (context) => Dialog.fullscreen(
        backgroundColor: Colors.black,
        child: GestureDetector(
          onTap: () => Navigator.of(context).pop(),
          child: Stack(
            fit: StackFit.expand,
            children: <Widget>[
              InteractiveViewer(child: Image.network(story.mediaUrl, fit: BoxFit.contain)),
              Positioned(
                left: 16,
                right: 16,
                bottom: 32,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(story.author.displayName, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
                    if (story.caption != null) Text(story.caption!, style: const TextStyle(color: Colors.white)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _showComments(Post post) async {
    final cubit = context.read<FeedCubit>();
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _CommentsSheet(cubit: cubit, post: post),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Feed'), actions: const <Widget>[ProfileMenuButton(), SizedBox(width: 8)]),
      floatingActionButton: FloatingActionButton(
        onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => BlocProvider<FeedCubit>.value(value: context.read<FeedCubit>(), child: const CreatePostScreen()))),
        child: const Icon(Icons.add),
      ),
      body: BlocConsumer<FeedCubit, FeedState>(
        listenWhen: (a, b) => a.error != b.error && b.error != null,
        listener: (context, state) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(state.error!)));
          context.read<FeedCubit>().clearError();
        },
        builder: (context, state) {
          if (state.loading && state.posts.isEmpty) return const Center(child: CircularProgressIndicator());
          return RefreshIndicator(
            onRefresh: () => context.read<FeedCubit>().load(),
            child: ListView.builder(
              controller: _scroll,
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(12),
              itemCount: state.posts.length + 2,
              itemBuilder: (context, index) {
                if (index == 0) return _StoryRow(stories: state.stories, onAdd: _addStory, onOpen: _openStory);
                if (index == state.posts.length + 1) {
                  return state.loadingMore
                      ? const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()))
                      : (state.posts.isEmpty ? const Padding(padding: EdgeInsets.all(40), child: Center(child: Text('No posts yet. Share the first one!'))) : const SizedBox(height: 72));
                }
                final post = state.posts[index - 1];
                return Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: _PostCard(
                    post: post,
                    mine: post.userId == widget.currentUserId,
                    onLike: () => context.read<FeedCubit>().toggleLike(post),
                    onComments: () => _showComments(post),
                    onDelete: () => context.read<FeedCubit>().delete(post),
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

class _StoryRow extends StatelessWidget {
  const _StoryRow({required this.stories, required this.onAdd, required this.onOpen});

  final List<Story> stories;
  final VoidCallback onAdd;
  final void Function(Story) onOpen;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      height: 92,
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: <Widget>[
          GestureDetector(
            onTap: onAdd,
            child: Padding(
              padding: const EdgeInsets.only(right: 12),
              child: Column(
                children: <Widget>[
                  CircleAvatar(radius: 30, backgroundColor: scheme.primaryContainer, child: Icon(Icons.add, color: scheme.primary)),
                  const SizedBox(height: 4),
                  const Text('Your story', style: TextStyle(fontSize: 11)),
                ],
              ),
            ),
          ),
          for (final story in stories)
            GestureDetector(
              onTap: () => onOpen(story),
              child: Padding(
                padding: const EdgeInsets.only(right: 12),
                child: Column(
                  children: <Widget>[
                    Container(
                      padding: const EdgeInsets.all(2),
                      decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: scheme.primary, width: 2)),
                      child: CircleAvatar(
                        radius: 27,
                        backgroundImage: NetworkImage(story.author.avatarUrl ?? story.mediaUrl),
                      ),
                    ),
                    const SizedBox(height: 4),
                    SizedBox(width: 64, child: Text(story.author.displayName, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: const TextStyle(fontSize: 11))),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _PostCard extends StatelessWidget {
  const _PostCard({required this.post, required this.mine, required this.onLike, required this.onComments, required this.onDelete});

  final Post post;
  final bool mine;
  final VoidCallback onLike;
  final VoidCallback onComments;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                CircleAvatar(
                  backgroundImage: post.author.avatarUrl != null ? NetworkImage(post.author.avatarUrl!) : null,
                  child: post.author.avatarUrl == null ? Text(post.author.displayName[0].toUpperCase()) : null,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(post.author.displayName, style: const TextStyle(fontWeight: FontWeight.w600)),
                      Text(timeAgo(post.createdAt), style: Theme.of(context).textTheme.labelSmall),
                    ],
                  ),
                ),
                if (mine)
                  IconButton(
                    icon: const Icon(Icons.delete_outline),
                    onPressed: () async {
                      final confirmed = await showDialog<bool>(
                        context: context,
                        builder: (context) => AlertDialog(
                          title: const Text('Delete post?'),
                          actions: <Widget>[
                            TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
                            TextButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Delete')),
                          ],
                        ),
                      );
                      if (confirmed ?? false) onDelete();
                    },
                  ),
              ],
            ),
            if (post.body.isNotEmpty) ...<Widget>[const SizedBox(height: 10), Text(post.body)],
            if (post.mediaUrls.isNotEmpty) ...<Widget>[
              const SizedBox(height: 10),
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: post.mediaUrls.length == 1
                    ? Image.network(post.mediaUrls.first, fit: BoxFit.cover, width: double.infinity, height: 260)
                    : GridView.count(
                        crossAxisCount: 2,
                        shrinkWrap: true,
                        physics: const NeverScrollableScrollPhysics(),
                        mainAxisSpacing: 2,
                        crossAxisSpacing: 2,
                        children: post.mediaUrls.map((u) => Image.network(u, fit: BoxFit.cover)).toList(),
                      ),
              ),
            ],
            const Divider(height: 24),
            Row(
              children: <Widget>[
                TextButton.icon(
                  onPressed: onLike,
                  icon: Icon(post.likedByMe ? Icons.thumb_up : Icons.thumb_up_outlined, size: 18, color: post.likedByMe ? scheme.primary : null),
                  label: Text('${post.likeCount}'),
                ),
                TextButton.icon(onPressed: onComments, icon: const Icon(Icons.mode_comment_outlined, size: 18), label: Text('${post.commentCount}')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _CommentsSheet extends StatefulWidget {
  const _CommentsSheet({required this.cubit, required this.post});

  final FeedCubit cubit;
  final Post post;

  @override
  State<_CommentsSheet> createState() => _CommentsSheetState();
}

class _CommentsSheetState extends State<_CommentsSheet> {
  final _controller = TextEditingController();
  List<PostComment>? _comments;
  bool _posting = false;

  @override
  void initState() {
    super.initState();
    widget.cubit.comments(widget.post.id).then((c) {
      if (mounted) setState(() => _comments = c);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    setState(() => _posting = true);
    final created = await widget.cubit.addComment(widget.post, text);
    if (!mounted) return;
    setState(() {
      _posting = false;
      if (created != null) {
        _comments = <PostComment>[...?_comments, created];
        _controller.clear();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.6,
        child: Column(
          children: <Widget>[
            Expanded(
              child: _comments == null
                  ? const Center(child: CircularProgressIndicator())
                  : ListView(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      children: _comments!
                          .map(
                            (c) => ListTile(
                              contentPadding: EdgeInsets.zero,
                              leading: CircleAvatar(
                                radius: 16,
                                backgroundImage: c.author.avatarUrl != null ? NetworkImage(c.author.avatarUrl!) : null,
                                child: c.author.avatarUrl == null ? Text(c.author.displayName[0].toUpperCase()) : null,
                              ),
                              title: Text(c.author.displayName, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                              subtitle: Text(c.body),
                            ),
                          )
                          .toList(),
                    ),
            ),
            Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: <Widget>[
                  Expanded(child: TextField(controller: _controller, maxLength: 1000, decoration: const InputDecoration(hintText: 'Write a comment…', counterText: ''))),
                  const SizedBox(width: 8),
                  IconButton.filled(onPressed: _posting ? null : _submit, icon: const Icon(Icons.send)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
