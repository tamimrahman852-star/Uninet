import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'core/constants/app_constants.dart';
import 'core/network/dio_client.dart';
import 'core/theme/app_theme.dart';
import 'features/ai_assistant/ai_assistant_screen.dart';
import 'features/ai_assistant/ai_cubit.dart';
import 'features/ai_assistant/ai_repository.dart';
import 'features/auth/auth_cubit.dart';
import 'features/auth/auth_repository.dart';
import 'features/auth/login_screen.dart';
import 'features/chat/chat_cubit.dart';
import 'features/chat/chat_list_screen.dart';
import 'features/chat/chat_repository.dart';
import 'features/chat/e2ee_service.dart';
import 'features/feed/feed_cubit.dart';
import 'features/feed/feed_repository.dart';
import 'features/feed/feed_screen.dart';
import 'features/marketplace/cart_cubit.dart';
import 'features/marketplace/marketplace_repository.dart';
import 'features/marketplace/marketplace_screen.dart';
import 'features/streaming/streaming_repository.dart';
import 'features/streaming/watch_screen.dart';

/// Hand-rolled dependency container (no service locator needed for an app of this size).
class AppDependencies {
  AppDependencies._({
    required this.sessions,
    required this.api,
    required this.supabase,
    required this.authRepository,
    required this.marketplaceRepository,
    required this.streamingRepository,
    required this.aiRepository,
  });

  final SessionStore sessions;
  final ApiClient api;
  final SupabaseClient supabase;
  final AuthRepository authRepository;
  final MarketplaceRepository marketplaceRepository;
  final StreamingRepository streamingRepository;
  final AiRepository aiRepository;

  factory AppDependencies.create() {
    final sessions = SessionStore();
    final api = ApiClient(sessions);
    // Supabase is used for the social feed; requests carry the same JWT the gateway issued.
    final supabase = SupabaseClient(
      AppConstants.supabaseUrl,
      AppConstants.supabaseAnonKey,
      accessToken: api.validToken,
    );
    return AppDependencies._(
      sessions: sessions,
      api: api,
      supabase: supabase,
      authRepository: AuthRepository(api, sessions),
      marketplaceRepository: MarketplaceRepository(api),
      streamingRepository: StreamingRepository(api),
      aiRepository: AiRepository(api),
    );
  }
}

class UninetApp extends StatelessWidget {
  const UninetApp({super.key, required this.deps});

  final AppDependencies deps;

  @override
  Widget build(BuildContext context) {
    return MultiRepositoryProvider(
      providers: [
        RepositoryProvider<MarketplaceRepository>.value(value: deps.marketplaceRepository),
        RepositoryProvider<StreamingRepository>.value(value: deps.streamingRepository),
      ],
      child: MultiBlocProvider(
        providers: [
          BlocProvider<AuthCubit>(create: (_) => AuthCubit(deps.authRepository, deps.sessions)..start()),
          BlocProvider<CartCubit>(create: (_) => CartCubit()..load()),
        ],
        child: MaterialApp(
          title: 'Uninet',
          debugShowCheckedModeBanner: false,
          theme: AppTheme.light(),
          darkTheme: AppTheme.dark(),
          themeMode: ThemeMode.system,
          home: AuthGate(deps: deps),
        ),
      ),
    );
  }
}

class AuthGate extends StatelessWidget {
  const AuthGate({super.key, required this.deps});

  final AppDependencies deps;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<AuthCubit, AuthState>(
      buildWhen: (a, b) => a.status != b.status || a.userId != b.userId,
      builder: (context, state) {
        switch (state.status) {
          case AuthStatus.unknown:
            return const Scaffold(body: Center(child: CircularProgressIndicator()));
          case AuthStatus.unauthenticated:
            return const LoginScreen();
          case AuthStatus.authenticated:
            // Keyed by user id so every account gets fresh per-user state (chat socket, feed, AI history).
            return _UserScope(key: ValueKey<String>(state.userId!), deps: deps, userId: state.userId!);
        }
      },
    );
  }
}

class _UserScope extends StatelessWidget {
  const _UserScope({super.key, required this.deps, required this.userId});

  final AppDependencies deps;
  final String userId;

  @override
  Widget build(BuildContext context) {
    return MultiBlocProvider(
      providers: [
        BlocProvider<ChatCubit>(
          create: (_) => ChatCubit(
            ChatRepository(api: deps.api, supabase: deps.supabase, e2ee: E2eeService()),
            userId,
          )..start(),
        ),
        BlocProvider<FeedCubit>(create: (_) => FeedCubit(FeedRepository(deps.supabase, userId))),
        BlocProvider<AiCubit>(create: (_) => AiCubit(deps.aiRepository)),
      ],
      child: HomeShell(userId: userId),
    );
  }
}

class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.userId});

  final String userId;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final unread = context.select<ChatCubit, int>((c) => c.state.totalUnread);
    final pages = <Widget>[
      FeedScreen(currentUserId: widget.userId),
      const ChatListScreen(),
      const MarketplaceScreen(),
      WatchScreen(currentUserId: widget.userId),
      const AiAssistantScreen(),
    ];
    return Scaffold(
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (value) => setState(() => _index = value),
        destinations: <NavigationDestination>[
          const NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Feed'),
          NavigationDestination(
            icon: Badge(isLabelVisible: unread > 0, label: Text('$unread'), child: const Icon(Icons.chat_bubble_outline)),
            selectedIcon: Badge(isLabelVisible: unread > 0, label: Text('$unread'), child: const Icon(Icons.chat_bubble)),
            label: 'Chat',
          ),
          const NavigationDestination(icon: Icon(Icons.storefront_outlined), selectedIcon: Icon(Icons.storefront), label: 'Shop'),
          const NavigationDestination(icon: Icon(Icons.play_circle_outline), selectedIcon: Icon(Icons.play_circle), label: 'Watch'),
          const NavigationDestination(icon: Icon(Icons.auto_awesome_outlined), selectedIcon: Icon(Icons.auto_awesome), label: 'AI'),
        ],
      ),
    );
  }
}
