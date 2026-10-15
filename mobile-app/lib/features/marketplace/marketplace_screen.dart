import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/network/dio_client.dart';
import 'cart_cubit.dart';
import 'cart_screen.dart';
import 'marketplace_models.dart';
import 'marketplace_repository.dart';

class MarketplaceScreen extends StatefulWidget {
  const MarketplaceScreen({super.key});

  @override
  State<MarketplaceScreen> createState() => _MarketplaceScreenState();
}

class _MarketplaceScreenState extends State<MarketplaceScreen> {
  final _search = TextEditingController();
  final _scroll = ScrollController();
  Timer? _debounce;

  List<Product> _products = <Product>[];
  int _total = 0;
  int _page = 1;
  String _sort = 'newest';
  bool _loading = true;
  bool _loadingMore = false;
  String? _error;

  late final MarketplaceRepository _repository = context.read<MarketplaceRepository>();

  @override
  void initState() {
    super.initState();
    _load();
    _scroll.addListener(() {
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 300) _loadMore();
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _page = 1;
    });
    try {
      final page = await _repository.products(query: _search.text.trim(), sort: _sort);
      if (!mounted) return;
      setState(() {
        _products = page.items;
        _total = page.total;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _loading = false;
        });
      }
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore || _products.length >= _total) return;
    setState(() => _loadingMore = true);
    try {
      final page = await _repository.products(query: _search.text.trim(), sort: _sort, page: _page + 1);
      if (!mounted) return;
      setState(() {
        _page += 1;
        _products = <Product>[..._products, ...page.items];
        _total = page.total;
      });
    } on ApiException {
      // keep what we have
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  void _addToCart(Product product) {
    final error = context.read<CartCubit>().add(product);
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(error ?? 'Added to cart'), duration: const Duration(seconds: 2)));
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Shop'),
        actions: <Widget>[
          IconButton(
            tooltip: 'My orders',
            icon: const Icon(Icons.receipt_long_outlined),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const OrdersScreen())),
          ),
          BlocBuilder<CartCubit, CartState>(
            builder: (context, cart) => IconButton(
              tooltip: 'Cart',
              icon: Badge(isLabelVisible: cart.count > 0, label: Text('${cart.count}'), child: const Icon(Icons.shopping_cart_outlined)),
              onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const CartScreen())),
            ),
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: TextField(
                    controller: _search,
                    textInputAction: TextInputAction.search,
                    onChanged: (_) {
                      _debounce?.cancel();
                      _debounce = Timer(const Duration(milliseconds: 450), _load);
                    },
                    onSubmitted: (_) => _load(),
                    decoration: const InputDecoration(hintText: 'Search products', prefixIcon: Icon(Icons.search), isDense: true),
                  ),
                ),
                const SizedBox(width: 8),
                PopupMenuButton<String>(
                  icon: const Icon(Icons.sort),
                  initialValue: _sort,
                  onSelected: (value) {
                    _sort = value;
                    _load();
                  },
                  itemBuilder: (_) => const <PopupMenuEntry<String>>[
                    PopupMenuItem<String>(value: 'newest', child: Text('Newest')),
                    PopupMenuItem<String>(value: 'price_asc', child: Text('Price: low to high')),
                    PopupMenuItem<String>(value: 'price_desc', child: Text('Price: high to low')),
                    PopupMenuItem<String>(value: 'rating', child: Text('Top rated')),
                  ],
                ),
              ],
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                    ? Center(child: Column(mainAxisSize: MainAxisSize.min, children: <Widget>[Text(_error!), TextButton(onPressed: _load, child: const Text('Retry'))]))
                    : _products.isEmpty
                        ? const Center(child: Text('No products found'))
                        : RefreshIndicator(
                            onRefresh: _load,
                            child: GridView.builder(
                              controller: _scroll,
                              padding: const EdgeInsets.all(12),
                              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 2, mainAxisSpacing: 12, crossAxisSpacing: 12, childAspectRatio: 0.62),
                              itemCount: _products.length + (_loadingMore ? 1 : 0),
                              itemBuilder: (context, index) {
                                if (index >= _products.length) return const Center(child: CircularProgressIndicator());
                                final product = _products[index];
                                final soldOut = product.stock < 1;
                                return Card(
                                  clipBehavior: Clip.antiAlias,
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: <Widget>[
                                      AspectRatio(
                                        aspectRatio: 1,
                                        child: product.images.isEmpty
                                            ? ColoredBox(color: scheme.surfaceContainerHighest, child: const Icon(Icons.shopping_bag_outlined, size: 40))
                                            : Image.network(product.images.first, fit: BoxFit.cover),
                                      ),
                                      Expanded(
                                        child: Padding(
                                          padding: const EdgeInsets.all(8),
                                          child: Column(
                                            crossAxisAlignment: CrossAxisAlignment.start,
                                            children: <Widget>[
                                              Text(product.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w500)),
                                              const Spacer(),
                                              Text(formatMoney(product.priceMinor, product.currency), style: TextStyle(fontWeight: FontWeight.bold, color: scheme.primary)),
                                              SizedBox(
                                                width: double.infinity,
                                                child: FilledButton.tonal(
                                                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(34)),
                                                  onPressed: soldOut ? null : () => _addToCart(product),
                                                  child: Text(soldOut ? 'Sold out' : 'Add to cart'),
                                                ),
                                              ),
                                            ],
                                          ),
                                        ),
                                      ),
                                    ],
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
