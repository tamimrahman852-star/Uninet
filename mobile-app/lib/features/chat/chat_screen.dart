import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:intl/intl.dart';

import 'chat_cubit.dart';
import 'chat_list_screen.dart';
import 'chat_models.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.peerId});

  final String peerId;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _controller = TextEditingController();
  late final ChatCubit _cubit;

  @override
  void initState() {
    super.initState();
    _cubit = context.read<ChatCubit>();
    _cubit.openPeer(widget.peerId);
  }

  @override
  void dispose() {
    _controller.dispose();
    _cubit.closePeer();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _controller.text;
    if (text.trim().isEmpty) return;
    _controller.clear();
    await _cubit.sendText(widget.peerId, text);
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<ChatCubit, ChatState>(
      listenWhen: (a, b) => a.error != b.error && b.error != null,
      listener: (context, state) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(state.error!))),
      builder: (context, state) {
        final peer = state.peers[widget.peerId] ?? ChatPeer(id: widget.peerId);
        final messages = state.messages[widget.peerId] ?? const <ChatMessage>[];
        final reversed = messages.reversed.toList();
        final hasOlder = state.cursors[widget.peerId] != null;
        return Scaffold(
          appBar: AppBar(
            titleSpacing: 0,
            title: Row(
              children: <Widget>[
                PeerAvatar(peer: peer, radius: 18),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(peer.displayName, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16)),
                      Text(
                        peer.typing ? 'typing…' : (peer.online ? 'online' : 'offline'),
                        style: Theme.of(context).textTheme.labelSmall,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          body: Column(
            children: <Widget>[
              Container(
                width: double.infinity,
                color: Colors.amber.shade50,
                padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 12),
                child: Text(
                  '🔒 Messages are end-to-end encrypted. Only the devices in this chat can read them.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 11, color: Colors.amber.shade900),
                ),
              ),
              Expanded(
                child: ListView.builder(
                  reverse: true,
                  padding: const EdgeInsets.all(12),
                  itemCount: reversed.length + (hasOlder ? 1 : 0),
                  itemBuilder: (context, index) {
                    if (index == reversed.length) {
                      return Center(
                        child: TextButton(onPressed: () => _cubit.loadOlder(widget.peerId), child: const Text('Load older messages')),
                      );
                    }
                    return _Bubble(message: reversed[index]);
                  },
                ),
              ),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: <Widget>[
                      Expanded(
                        child: TextField(
                          controller: _controller,
                          minLines: 1,
                          maxLines: 5,
                          maxLength: 4000,
                          textCapitalization: TextCapitalization.sentences,
                          onChanged: (_) => _cubit.onTextChanged(widget.peerId),
                          decoration: const InputDecoration(hintText: 'Message', counterText: ''),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton.filled(onPressed: state.connected ? _send : null, icon: const Icon(Icons.send)),
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.message});

  final ChatMessage message;

  String get _tick {
    switch (message.status) {
      case MessageStatus.sending:
        return '⏳';
      case MessageStatus.queued:
      case MessageStatus.sent:
        return '✓';
      case MessageStatus.delivered:
      case MessageStatus.read:
        return '✓✓';
      case MessageStatus.failed:
        return '⚠ failed';
      case MessageStatus.received:
        return '';
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final mine = message.mine;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
        margin: const EdgeInsets.symmetric(vertical: 2),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: mine ? scheme.primary : scheme.surfaceContainerHighest,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(16),
            topRight: const Radius.circular(16),
            bottomLeft: Radius.circular(mine ? 16 : 4),
            bottomRight: Radius.circular(mine ? 4 : 16),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(message.text, style: TextStyle(color: mine ? scheme.onPrimary : scheme.onSurface)),
            const SizedBox(height: 2),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (message.verified == false) Text('⚠ unverified  ', style: TextStyle(fontSize: 10, color: scheme.error)),
                Text(
                  DateFormat.Hm().format(DateTime.fromMillisecondsSinceEpoch(message.ts)),
                  style: TextStyle(fontSize: 10, color: (mine ? scheme.onPrimary : scheme.onSurface).withOpacity(0.7)),
                ),
                if (mine) ...<Widget>[
                  const SizedBox(width: 4),
                  Text(_tick, style: TextStyle(fontSize: 10, color: message.status == MessageStatus.read ? Colors.lightBlueAccent : scheme.onPrimary.withOpacity(0.8))),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}
