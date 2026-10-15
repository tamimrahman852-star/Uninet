import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../chat/chat_cubit.dart';
import 'auth_cubit.dart';

/// App bar action showing the signed-in user with a sign-out entry.
class ProfileMenuButton extends StatelessWidget {
  const ProfileMenuButton({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthCubit>().state;
    final name = auth.profile?.displayName ?? auth.email ?? 'Account';
    return PopupMenuButton<String>(
      tooltip: 'Account',
      icon: CircleAvatar(
        radius: 14,
        backgroundImage: auth.profile?.avatarUrl != null ? NetworkImage(auth.profile!.avatarUrl!) : null,
        child: auth.profile?.avatarUrl == null ? Text(name.isEmpty ? '?' : name[0].toUpperCase(), style: const TextStyle(fontSize: 13)) : null,
      ),
      onSelected: (value) async {
        if (value != 'logout') return;
        final authCubit = context.read<AuthCubit>();
        final chatCubit = context.read<ChatCubit>();
        await chatCubit.shutdown();
        await chatCubit.wipeLocalData(); // plaintext history is kept on-device only
        await authCubit.logout();
      },
      itemBuilder: (_) => <PopupMenuEntry<String>>[
        PopupMenuItem<String>(enabled: false, child: Text(name, style: const TextStyle(fontWeight: FontWeight.w600))),
        const PopupMenuDivider(),
        const PopupMenuItem<String>(value: 'logout', child: Text('Sign out')),
      ],
    );
  }
}
