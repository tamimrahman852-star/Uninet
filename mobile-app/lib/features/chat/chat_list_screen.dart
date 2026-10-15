import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:intl/intl.dart';

import 'chat_cubit.dart';
import 'chat_models.dart';
import 'chat_screen.dart';
import 'chat_repository.dart';

class PeerAvatar extends StatelessWidget {
  const PeerAvatar({super.key, required this.peer, this.radius = 22});

  final ChatPeer peer;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final initials = peer.displayName.replaceAll('@', '').trim().isEmpty ? '?' : peer.displayName.replaceAll('@', '').trim()[0].toUpperCase();
    return Stack(
      children: <Widget>[
        CircleAvatar(
          radius: radius,
          backgroundImage: peer.avatarUrl != null ? NetworkImage(peer.avatarUrl!) : null,
          child: peer.avatarUrl == null ? Text(initials) : null,
        ),
        if (peer.online)
          Positioned(
            right: 0,
            bottom: 0,
            child: Container(
              width: 11,
              height: 11,
              decoration: BoxDecoration(
                color: Colors.green,
                shape: BoxShape.circle,
                border: Border.all(color: Theme.of(context).colorScheme.surface, width: 2),
              ),
            ),
          ),
      ],
    );
  }
}

class ChatListScreen extends StatelessWidget {
  const ChatListScreen({super.key});

  Future<void> _newChat(BuildContext context) async {
    final cubit = context.read<ChatCubit>();
    final result = await showModalBottomSheet<ProfileResult>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _SearchSheet(cubit: cubit),
    );
    if (result == null || !context.mounted) return;
    cubit.addPeer(result);
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ChatScreen(peerId: result.id)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Chats'),
        actions: <Widget>[
          BlocBuilder<ChatCubit, ChatState>(
            buildWhen: (a, b) => a.connected != b.connected,
            builder: (context, state) => Padding(
              padding: const EdgeInsets.only(right: 12),
              child: Chip(
                label: Text(state.connected ? 'Connected' : 'Connecting…', style: const TextStyle(fontSize: 11)),
                visualDensity: VisualDensity.compact,
                backgroundColor: state.connected ? Colors.green.shade100 : Colors.amber.shade100,
              ),
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _newChat(context),
        child: const Icon(Icons.edit),
      ),
      body: BlocBuilder<ChatCubit, ChatState>(
        builder: (context, state) {
          final peers = state.sortedPeers;
          if (peers.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(32),
                child: Text('No chats yet. Tap the pencil to find someone and start an end-to-end encrypted chat.', textAlign: TextAlign.center),
              ),
            );
          }
          return ListView.separated(
            itemCount: peers.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (context, index) {
              final peer = peers[index];
              final messages = state.messages[peer.id] ?? const <ChatMessage>[];
              final last = messages.isEmpty ? null : messages.last;
              return ListTile(
                leading: PeerAvatar(peer: peer),
                title: Text(peer.displayName, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text(peer.typing ? 'typing…' : (last?.text ?? 'No messages yet'), maxLines: 1, overflow: TextOverflow.ellipsis),
                trailing: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: <Widget>[
                    if (last != null)
                      Text(DateFormat.Hm().format(DateTime.fromMillisecondsSinceEpoch(last.ts)), style: Theme.of(context).textTheme.labelSmall),
                    if (peer.unread > 0)
                      Container(
                        margin: const EdgeInsets.only(top: 4),
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(color: Theme.of(context).colorScheme.primary, borderRadius: BorderRadius.circular(10)),
                        child: Text('${peer.unread}', style: TextStyle(color: Theme.of(context).colorScheme.onPrimary, fontSize: 11)),
                      ),
                  ],
                ),
                onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ChatScreen(peerId: peer.id))),
              );
            },
          );
        },
      ),
    );
  }
}

class _SearchSheet extends StatefulWidget {
  const _SearchSheet({required this.cubit});

  final ChatCubit cubit;

  @override
  State<_SearchSheet> createState() => _SearchSheetState();
}

class _SearchSheetState extends State<_SearchSheet> {
  final _controller = TextEditingController();
  List<ProfileResult> _results = const <ProfileResult>[];
  bool _loading = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    setState(() => _loading = true);
    try {
      final results = await widget.cubit.search(_controller.text);
      if (mounted) setState(() => _results = results);
    } on Object {
      if (mounted) setState(() => _results = const <ProfileResult>[]);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom, left: 16, right: 16),
      child: SizedBox(
        height: 420,
        child: Column(
          children: <Widget>[
            TextField(
              controller: _controller,
              autofocus: true,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _search(),
              decoration: InputDecoration(
                hintText: 'Search by name or @username',
                suffixIcon: IconButton(icon: const Icon(Icons.search), onPressed: _search),
              ),
            ),
            if (_loading) const LinearProgressIndicator(),
            Expanded(
              child: ListView(
                children: _results
                    .map(
                      (r) => ListTile(
                        leading: CircleAvatar(
                          backgroundImage: r.avatarUrl != null ? NetworkImage(r.avatarUrl!) : null,
                          child: r.avatarUrl == null ? Text((r.fullName ?? r.username ?? '?')[0].toUpperCase()) : null,
                        ),
                        title: Text(r.fullName ?? r.username ?? 'User'),
                        subtitle: r.username != null ? Text('@${r.username}') : null,
                        onTap: () => Navigator.of(context).pop(r),
                      ),
                    )
                    .toList(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
