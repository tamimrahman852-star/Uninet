/// Build-time configuration, e.g.
/// flutter run --dart-define=API_URL=http://10.0.2.2:8080 --dart-define=WS_URL=ws://10.0.2.2:8080 \
///   --dart-define=SUPABASE_URL=https://xyz.supabase.co --dart-define=SUPABASE_ANON_KEY=...
class AppConstants {
  AppConstants._();

  static const String apiUrl = String.fromEnvironment('API_URL', defaultValue: 'http://10.0.2.2:8080');
  static const String wsUrl = String.fromEnvironment('WS_URL', defaultValue: 'ws://10.0.2.2:8080');
  static const String supabaseUrl = String.fromEnvironment('SUPABASE_URL', defaultValue: 'http://10.0.2.2:54321');
  static const String supabaseAnonKey = String.fromEnvironment('SUPABASE_ANON_KEY', defaultValue: 'anon-key-not-configured');

  static const String feedBucket = 'feed-media';
  static const int maxUploadParallelism = 3;
}
