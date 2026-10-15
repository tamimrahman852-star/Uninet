import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import 'ai_cubit.dart';
import 'ai_repository.dart';

class AiAssistantScreen extends StatefulWidget {
  const AiAssistantScreen({super.key});

  @override
  State<AiAssistantScreen> createState() => _AiAssistantScreenState();
}

class _AiAssistantScreenState extends State<AiAssistantScreen> {
  final _controller = TextEditingController();
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    context.read<AiCubit>().load();
  }

  @override
  void dispose() {
    _controller.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 150), curve: Curves.easeOut);
    });
  }

  Future<void> _send() async {
    final text = _controller.text;
    if (text.trim().isEmpty) return;
    _controller.clear();
    await context.read<AiCubit>().send(text);
  }

  Future<void> _showHistory() async {
    final cubit = context.read<AiCubit>();
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => BlocProvider<AiCubit>.value(
        value: cubit,
        child: BlocBuilder<AiCubit, AiState>(
          builder: (context, state) => state.conversations.isEmpty
              ? const SizedBox(height: 160, child: Center(child: Text('No conversations yet')))
              : ListView(
                  shrinkWrap: true,
                  children: state.conversations
                      .map(
                        (c) => ListTile(
                          title: Text(c.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                          trailing: IconButton(icon: const Icon(Icons.delete_outline), onPressed: () => cubit.deleteConversation(c.id)),
                          onTap: () {
                            cubit.openConversation(c.id);
                            Navigator.of(context).pop();
                          },
                        ),
                      )
                      .toList(),
                ),
        ),
      ),
    );
  }

  Future<void> _addDocument() async {
    final cubit = context.read<AiCubit>();
    final title = TextEditingController();
    final body = TextEditingController();
    final submit = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Add to knowledge base'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              TextField(controller: title, decoration: const InputDecoration(labelText: 'Title')),
              const SizedBox(height: 12),
              TextField(controller: body, maxLines: 8, decoration: const InputDecoration(labelText: 'Paste text')),
            ],
          ),
        ),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Add')),
        ],
      ),
    );
    final titleText = title.text.trim();
    final bodyText = body.text.trim();
    title.dispose();
    body.dispose();
    if ((submit ?? false) && titleText.isNotEmpty && bodyText.isNotEmpty) await cubit.addDocument(titleText, bodyText);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return BlocConsumer<AiCubit, AiState>(
      listenWhen: (a, b) => a.notice != b.notice && b.notice != null,
      listener: (context, state) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(state.notice!)));
        context.read<AiCubit>().clearNotice();
      },
      builder: (context, state) {
        _scrollToEnd();
        return Scaffold(
          appBar: AppBar(
            title: const Text('AI Assistant'),
            actions: <Widget>[
              IconButton(tooltip: 'New chat', icon: const Icon(Icons.add_comment_outlined), onPressed: () => context.read<AiCubit>().newChat()),
              IconButton(tooltip: 'History', icon: const Icon(Icons.history), onPressed: _showHistory),
              IconButton(tooltip: 'Knowledge base', icon: const Icon(Icons.library_add_outlined), onPressed: _addDocument),
            ],
          ),
          body: Column(
            children: <Widget>[
              if (state.documentCount > 0)
                SwitchListTile(
                  dense: true,
                  title: Text('Use my documents (${state.documentCount})'),
                  value: state.useRag,
                  onChanged: context.read<AiCubit>().setUseRag,
                ),
              Expanded(
                child: state.messages.isEmpty
                    ? const Center(
                        child: Padding(
                          padding: EdgeInsets.all(32),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              Text('✨', style: TextStyle(fontSize: 48)),
                              SizedBox(height: 8),
                              Text('How can I help you today?', style: TextStyle(fontWeight: FontWeight.w600)),
                            ],
                          ),
                        ),
                      )
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.all(12),
                        itemCount: state.messages.length,
                        itemBuilder: (context, index) {
                          final message = state.messages[index];
                          final mine = message.role == 'user';
                          return Align(
                            alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
                            child: Container(
                              constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.86),
                              margin: const EdgeInsets.symmetric(vertical: 4),
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                              decoration: BoxDecoration(
                                color: message.error ? scheme.errorContainer : (mine ? scheme.primary : scheme.surfaceContainerHighest),
                                borderRadius: BorderRadius.circular(16),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisSize: MainAxisSize.min,
                                children: <Widget>[
                                  if (message.content.isEmpty && message.pending)
                                    const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2))
                                  else
                                    SelectableText(
                                      message.content + (message.pending ? ' ▍' : ''),
                                      style: TextStyle(color: message.error ? scheme.onErrorContainer : (mine ? scheme.onPrimary : scheme.onSurface)),
                                    ),
                                  if (message.sources.isNotEmpty)
                                    Padding(
                                      padding: const EdgeInsets.only(top: 6),
                                      child: Text(
                                        'Sources: ${message.sources.map((s) => s.title).toSet().join(', ')}',
                                        style: TextStyle(fontSize: 11, color: scheme.outline),
                                      ),
                                    ),
                                ],
                              ),
                            ),
                          );
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
                          maxLength: 8000,
                          textCapitalization: TextCapitalization.sentences,
                          decoration: const InputDecoration(hintText: 'Message Uninet AI', counterText: ''),
                        ),
                      ),
                      const SizedBox(width: 8),
                      state.streaming
                          ? IconButton.filled(onPressed: context.read<AiCubit>().stop, icon: const Icon(Icons.stop))
                          : IconButton.filled(onPressed: _send, icon: const Icon(Icons.send)),
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
