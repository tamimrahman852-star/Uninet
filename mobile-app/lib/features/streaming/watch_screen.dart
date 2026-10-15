import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/network/dio_client.dart';
import '../feed/feed_models.dart';
import 'streaming_repository.dart';
import 'upload_screen.dart';
import 'video_player_screen.dart';

String formatDuration(double? seconds) {
  if (seconds == null || seconds <= 0) return '';
  final total = seconds.round();
  final h = total ~/ 3600;
  final m = (total % 3600) ~/ 60;
  final s = total % 60;
  final mm = m.toString().padLeft(h > 0 ? 2 : 1, '0');
  final ss = s.toString().padLeft(2, '0');
  return h > 0 ? '$h:$mm:$ss' : '$mm:$ss';
}

class WatchScreen extends StatefulWidget {
  const WatchScreen({super.key, required this.currentUserId});

  final String currentUserId;

  @override
  State<WatchScreen> createState() => _WatchScreenState();
}

class _WatchScreenState extends State<WatchScreen> {
  final _search = TextEditingController();
  Timer? _debounce;
  List<VideoItem>? _videos;
  String? _error;

  late final StreamingRepository _repository = context.read<StreamingRepository>();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final videos = await _repository.videos(query: _search.text.trim());
      if (mounted) {
        setState(() {
          _videos = videos;
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Watch')),
      floatingActionButton: FloatingActionButton.extended(
        icon: const Icon(Icons.upload),
        label: const Text('Upload'),
        onPressed: () async {
          final uploaded = await Navigator.of(context).push<bool>(MaterialPageRoute<bool>(builder: (_) => const UploadScreen()));
          if (uploaded ?? false) await _load();
        },
      ),
      body: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
            child: TextField(
              controller: _search,
              textInputAction: TextInputAction.search,
              onChanged: (_) {
                _debounce?.cancel();
                _debounce = Timer(const Duration(milliseconds: 450), _load);
              },
              decoration: const InputDecoration(hintText: 'Search videos', prefixIcon: Icon(Icons.search), isDense: true),
            ),
          ),
          Expanded(
            child: _error != null
                ? Center(child: Column(mainAxisSize: MainAxisSize.min, children: <Widget>[Text(_error!), TextButton(onPressed: _load, child: const Text('Retry'))]))
                : _videos == null
                    ? const Center(child: CircularProgressIndicator())
                    : _videos!.isEmpty
                        ? const Center(child: Text('No videos yet. Upload the first one!'))
                        : RefreshIndicator(
                            onRefresh: _load,
                            child: ListView.builder(
                              padding: const EdgeInsets.fromLTRB(12, 8, 12, 88),
                              itemCount: _videos!.length,
                              itemBuilder: (context, index) {
                                final video = _videos![index];
                                return Padding(
                                  padding: const EdgeInsets.only(bottom: 16),
                                  child: InkWell(
                                    borderRadius: BorderRadius.circular(12),
                                    onTap: () async {
                                      await Navigator.of(context).push<void>(
                                        MaterialPageRoute<void>(builder: (_) => VideoPlayerScreen(videoId: video.id, currentUserId: widget.currentUserId)),
                                      );
                                      await _load();
                                    },
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: <Widget>[
                                        AspectRatio(
                                          aspectRatio: 16 / 9,
                                          child: Stack(
                                            fit: StackFit.expand,
                                            children: <Widget>[
                                              ClipRRect(
                                                borderRadius: BorderRadius.circular(12),
                                                child: video.thumbnailUrl == null
                                                    ? const ColoredBox(color: Colors.black26, child: Icon(Icons.play_circle_outline, size: 48))
                                                    : Image.network(video.thumbnailUrl!, fit: BoxFit.cover),
                                              ),
                                              if (video.durationSeconds != null)
                                                Positioned(
                                                  right: 8,
                                                  bottom: 8,
                                                  child: Container(
                                                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                                    decoration: BoxDecoration(color: Colors.black87, borderRadius: BorderRadius.circular(4)),
                                                    child: Text(formatDuration(video.durationSeconds), style: const TextStyle(color: Colors.white, fontSize: 12)),
                                                  ),
                                                ),
                                            ],
                                          ),
                                        ),
                                        const SizedBox(height: 8),
                                        Text(video.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
                                        Text('${video.viewCount} views · ${timeAgo(video.createdAt)}', style: Theme.of(context).textTheme.bodySmall),
                                      ],
                                    ),
                                  ),
                                );
                              },
                            ),
                          ),
          ),
        ],
      ),
    );
  }
}
