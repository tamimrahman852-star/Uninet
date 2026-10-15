import 'package:flutter/material.dart';

import 'app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final deps = AppDependencies.create();
  runApp(UninetApp(deps: deps));
}
