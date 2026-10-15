import 'package:chewie/chewie.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:video_player/video_player.dart';

import '../../core/network/dio_client.dart';
import '../feed/feed_models.dart';
import 'streaming_repository.dart';

class VideoPlayerScreen extends StatefulWidget {
  const VideoPlayerScreen({super.key, required this.videoId, required this.currentUserId});

  final String videoId;
  final String currentUserId;

  @override
  State<VideoPlayerScreen> createState() => _VideoPlayerScreenState();
}

class _VideoPlayerScreenState extends State<VideoPlayerScreen> {
  late final StreamingRepository _repository = context.read<StreamingRepository>();
  final _commentController = TextEditingController();

  VideoItem? _video;
  bool _liked = false;
  List<VideoComment> _comments = <VideoComment>[];
  String? _error;
  VideoPlayerController? _controller;
  ChewieController? _chewie;
  bool _viewReported = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _controller?.removeListener(_onPlayerTick);
    _chewie?.dispose();
    _controller?.dispose();
    _commentController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final details = await _repository.details(widget.videoId);
      final comments = await _repository.comments(widget.videoId);
      if (!mounted) return;
      setState(() {
        _video = details.video;
        _liked = details.likedByMe;
        _comments = comments;
      });
      final url = details.video.hlsUrl;
      if (url != null && details.video.status == 'ready') await _initPlayer(url);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _initPlayer(String url) async {
    // video_player uses ExoPlayer / AVPlayer, which pick the HLS rendition adaptively.
    final controller = VideoPlayerController.networkUrl(Uri.parse(url), formatHint: VideoFormat.hls);
    try {
      await controller.initialize();
    } on Object {
      await controller.dispose();
      if (mounted) setState(() => _error = 'This video could not be played.');
      return;
    }
    if (!mounted) {
      await controller.dispose();
      return;
    }
    controller.addListener(_onPlayerTick);
    setState(() {
      _controller = controller;
      _chewie = ChewieController(videoPlayerController: controller, autoPlay: true, aspectRatio: controller.value.aspectRatio, allowFullScreen: true);
    });
  }

  void _onPlayerTick() {
    final controller = _controller;
    if (controller == null || _viewReported) return;
    if (controller.value.isPlaying) {
      _viewReported = true;
      _repository.recordView(widget.videoId).catchError((Object _) {});
    }
  }

  Future<void> _toggleLike() async {
    final video = _video;
    if (video == null) return;
    final next = !_liked;
    setState(() {
      _liked = next;
      _video = video.copyWith(likeCount: (video.likeCount + (next ? 1 : -1)).clamp(0, 1 << 30));
    });
    try {
      await _repository.setLike(video.id, liked: next);
    } on ApiException {
      if (mounted) {
        setState(() {
          _liked = !next;
          _video = video;
        });
      }
    }
  }

  Future<void> _postComment() async {
    final text = _commentController.text.trim();
    if (text.isEmpty) return;
    try {
      final comment = await _repository.addComment(widget.videoId, text);
      if (!mounted) return;
      setState(() {
        _comments = <VideoComment>[comment, ..._comments];
        _commentController.clear();
      });
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _delete() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this video?'),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Delete')),
        ],
      ),
    );
    if (!(confirmed ?? false)) return;
    try {
      await _repository.deleteVideo(widget.videoId);
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final video = _video;
    return Scaffold(
      appBar: AppBar(title: Text(video?.title ?? 'Video', maxLines: 1, overflow: TextOverflow.ellipsis)),
      body: _error != null && video == null
          ? Center(child: Text(_error!))
          : video == null
              ? const Center(child: CircularProgressIndicator())
              : ListView(
                  children: <Widget>[
                    AspectRatio(
                      aspectRatio: 16 / 9,
                      child: _chewie != null
                          ? Chewie(controller: _chewie!)
                          : ColoredBox(
                              color: Colors.black,
                              child: Center(
                                child: _error != null
                                    ? Text(_error!, style: const TextStyle(color: Colors.white))
                                    : video.status == 'ready'
                                        ? const CircularProgressIndicator()
                                        : const Text('This video is still processing…', style: TextStyle(color: Colors.white)),
                              ),
                            ),
                    ),
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(video.title, style: Theme.of(context).textTheme.titleLarge),
                          Text('${video.viewCount} views · ${timeAgo(video.createdAt)}', style: Theme.of(context).textTheme.bodySmall),
                          const SizedBox(height: 8),
                          Wrap(
                            spacing: 8,
                            children: <Widget>[
                              FilledButton.tonalIcon(
                                style: FilledButton.styleFrom(minimumSize: const Size(0, 36)),
                                onPressed: _toggleLike,
                                icon: Icon(_liked ? Icons.thumb_up : Icons.thumb_up_outlined, size: 18),
                                label: Text('${video.likeCount}'),
                              ),
                              if (video.userId == widget.currentUserId)
                                OutlinedButton.icon(
                                  style: OutlinedButton.styleFrom(minimumSize: const Size(0, 36)),
                                  onPressed: _delete,
                                  icon: const Icon(Icons.delete_outline, size: 18),
                                  label: const Text('Delete'),
                                ),
                            ],
                          ),
                          if (video.description.isNotEmpty) ...<Widget>[const SizedBox(height: 12), Text(video.description)],
                          const Divider(height: 32),
                          Text('${_comments.length} comments', style: Theme.of(context).textTheme.titleMedium),
                          const SizedBox(height: 8),
                          Row(
                            children: <Widget>[
                              Expanded(child: TextField(controller: _commentController, maxLength: 2000, decoration: const InputDecoration(hintText: 'Add a comment…', counterText: ''))),
                              const SizedBox(width: 8),
                              IconButton.filled(onPressed: _postComment, icon: const Icon(Icons.send)),
                            ],
                          ),
                          for (final comment in _comments)
                            ListTile(
                              contentPadding: EdgeInsets.zero,
                              leading: CircleAvatar(
                                radius: 16,
                                backgroundImage: comment.author.avatarUrl != null ? NetworkImage(comment.author.avatarUrl!) : null,
                                child: comment.author.avatarUrl == null ? Text(comment.author.displayName[0].toUpperCase()) : null,
                              ),
                              title: Text('${comment.author.displayName} · ${timeAgo(comment.createdAt)}', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                              subtitle: Text(comment.body),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
    );
  }
}
