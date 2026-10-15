import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:image_picker/image_picker.dart';

import 'feed_cubit.dart';

class CreatePostScreen extends StatefulWidget {
  const CreatePostScreen({super.key});

  @override
  State<CreatePostScreen> createState() => _CreatePostScreenState();
}

class _CreatePostScreenState extends State<CreatePostScreen> {
  final _controller = TextEditingController();
  final List<XFile> _images = <XFile>[];

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _pick() async {
    final picked = await ImagePicker().pickMultiImage(maxWidth: 1600, imageQuality: 85, limit: 4);
    if (picked.isEmpty) return;
    setState(() {
      _images
        ..addAll(picked)
        ..removeRange(_images.length > 4 ? 4 : _images.length, _images.length);
    });
  }

  Future<void> _publish() async {
    final navigator = Navigator.of(context);
    final ok = await context.read<FeedCubit>().publish(_controller.text, _images);
    if (ok && mounted) navigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<FeedCubit, FeedState>(
      builder: (context, state) {
        return Scaffold(
          appBar: AppBar(
            title: const Text('New post'),
            actions: <Widget>[
              TextButton(
                onPressed: state.publishing ? null : _publish,
                child: state.publishing ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Post'),
              ),
            ],
          ),
          body: ListView(
            padding: const EdgeInsets.all(16),
            children: <Widget>[
              TextField(
                controller: _controller,
                maxLines: 6,
                maxLength: 5000,
                autofocus: true,
                decoration: const InputDecoration(hintText: "What's on your mind?"),
              ),
              if (_images.isNotEmpty)
                SizedBox(
                  height: 110,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    children: <Widget>[
                      for (var i = 0; i < _images.length; i++)
                        Stack(
                          children: <Widget>[
                            Padding(
                              padding: const EdgeInsets.only(right: 8),
                              child: ClipRRect(borderRadius: BorderRadius.circular(10), child: Image.file(File(_images[i].path), width: 110, height: 110, fit: BoxFit.cover)),
                            ),
                            Positioned(
                              right: 12,
                              top: 4,
                              child: GestureDetector(
                                onTap: () => setState(() => _images.removeAt(i)),
                                child: const CircleAvatar(radius: 11, backgroundColor: Colors.black54, child: Icon(Icons.close, size: 14, color: Colors.white)),
                              ),
                            ),
                          ],
                        ),
                    ],
                  ),
                ),
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton.icon(onPressed: _images.length >= 4 ? null : _pick, icon: const Icon(Icons.photo_library_outlined), label: const Text('Add photos')),
              ),
            ],
          ),
        );
      },
    );
  }
}
