import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/network/dio_client.dart';
import 'streaming_repository.dart';

class UploadScreen extends StatefulWidget {
  const UploadScreen({super.key});

  @override
  State<UploadScreen> createState() => _UploadScreenState();
}

class _UploadScreenState extends State<UploadScreen> {
  final _title = TextEditingController();
  final _description = TextEditingController();
  File? _file;
  double? _progress;
  String? _processingId;
  String? _error;
  Timer? _poll;

  @override
  void dispose() {
    _poll?.cancel();
    _title.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _pick() async {
    final result = await FilePicker.platform.pickFiles(type: FileType.video);
    final path = result?.files.single.path;
    if (path == null) return;
    setState(() {
      _file = File(path);
      if (_title.text.isEmpty) _title.text = path.split(Platform.pathSeparator).last.replaceAll(RegExp(r'\.[^.]+$'), '');
    });
  }

  Future<void> _start() async {
    final file = _file;
    if (file == null || _title.text.trim().isEmpty) return;
    final repository = context.read<StreamingRepository>();
    setState(() {
      _error = null;
      _progress = 0;
    });
    try {
      final videoId = await repository.upload(
        file: file,
        title: _title.text.trim(),
        description: _description.text.trim(),
        onProgress: (fraction) {
          if (mounted) setState(() => _progress = fraction);
        },
      );
      if (!mounted) return;
      setState(() => _processingId = videoId);
      _poll = Timer.periodic(const Duration(seconds: 4), (_) => _checkStatus(repository, videoId));
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _progress = null;
        });
      }
    }
  }

  Future<void> _checkStatus(StreamingRepository repository, String videoId) async {
    try {
      final details = await repository.details(videoId);
      if (!mounted) return;
      if (details.video.status == 'ready') {
        _poll?.cancel();
        Navigator.of(context).pop(true);
      } else if (details.video.status == 'failed') {
        _poll?.cancel();
        setState(() {
          _error = 'Processing failed. Please try another file.';
          _progress = null;
          _processingId = null;
        });
      }
    } on ApiException {
      // keep polling
    }
  }

  @override
  Widget build(BuildContext context) {
    final busy = _progress != null;
    return Scaffold(
      appBar: AppBar(title: const Text('Upload video')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: <Widget>[
          OutlinedButton.icon(onPressed: busy ? null : _pick, icon: const Icon(Icons.video_file_outlined), label: Text(_file == null ? 'Choose a video' : _file!.path.split(Platform.pathSeparator).last)),
          const SizedBox(height: 16),
          TextField(controller: _title, enabled: !busy, maxLength: 150, decoration: const InputDecoration(labelText: 'Title')),
          const SizedBox(height: 8),
          TextField(controller: _description, enabled: !busy, maxLines: 3, maxLength: 5000, decoration: const InputDecoration(labelText: 'Description')),
          if (_progress != null) ...<Widget>[
            const SizedBox(height: 12),
            LinearProgressIndicator(value: _processingId != null ? null : _progress),
            const SizedBox(height: 6),
            Text(_processingId != null ? 'Upload complete. Processing into multiple qualities…' : 'Uploading ${(_progress! * 100).round()}%'),
          ],
          if (_error != null) ...<Widget>[const SizedBox(height: 12), Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))],
          const SizedBox(height: 16),
          FilledButton(onPressed: busy || _file == null || _title.text.trim().isEmpty && _file == null ? null : _start, child: const Text('Upload')),
        ],
      ),
    );
  }
}
