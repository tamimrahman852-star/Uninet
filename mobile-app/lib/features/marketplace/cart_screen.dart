import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/network/dio_client.dart';
import 'cart_cubit.dart';
import 'marketplace_models.dart';
import 'marketplace_repository.dart';

class CartScreen extends StatelessWidget {
  const CartScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<CartCubit, CartState>(
      builder: (context, cart) {
        final cubit = context.read<CartCubit>();
        return Scaffold(
          appBar: AppBar(
            title: Text('Cart (${cart.count})'),
            actions: <Widget>[if (cart.items.isNotEmpty) TextButton(onPressed: cubit.clear, child: const Text('Clear'))],
          ),
          body: cart.items.isEmpty
              ? const Center(child: Text('Your cart is empty'))
              : ListView.separated(
                  padding: const EdgeInsets.all(12),
                  itemCount: cart.items.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 8),
                  itemBuilder: (context, index) {
                    final item = cart.items[index];
                    return Card(
                      child: ListTile(
                        leading: SizedBox(
                          width: 56,
                          height: 56,
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(8),
                            child: item.image == null ? const ColoredBox(color: Colors.black12) : Image.network(item.image!, fit: BoxFit.cover),
                          ),
                        ),
                        title: Text(item.title, maxLines: 2, overflow: TextOverflow.ellipsis),
                        subtitle: Text(formatMoney(item.priceMinor, item.currency)),
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: <Widget>[
                            IconButton(icon: const Icon(Icons.remove_circle_outline), onPressed: () => cubit.setQuantity(item.productId, item.quantity - 1)),
                            Text('${item.quantity}'),
                            IconButton(
                              icon: const Icon(Icons.add_circle_outline),
                              onPressed: item.quantity >= item.maxQuantity ? null : () => cubit.setQuantity(item.productId, item.quantity + 1),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
          bottomNavigationBar: cart.items.isEmpty
              ? null
              : SafeArea(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: <Widget>[
                            const Text('Subtotal', style: TextStyle(fontWeight: FontWeight.w600)),
                            Text(formatMoney(cart.subtotalMinor, cart.currency), style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                          ],
                        ),
                        const SizedBox(height: 8),
                        FilledButton(
                          onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const CheckoutScreen())),
                          child: const Text('Checkout'),
                        ),
                      ],
                    ),
                  ),
                ),
        );
      },
    );
  }
}

class CheckoutScreen extends StatefulWidget {
  const CheckoutScreen({super.key});

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends State<CheckoutScreen> {
  final _formKey = GlobalKey<FormState>();
  final Map<String, TextEditingController> _fields = <String, TextEditingController>{
    'full_name': TextEditingController(),
    'phone': TextEditingController(),
    'line1': TextEditingController(),
    'city': TextEditingController(),
    'postal_code': TextEditingController(),
    'country': TextEditingController(text: 'BD'),
  };
  String? _provider;
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    for (final c in _fields.values) {
      c.dispose();
    }
    super.dispose();
  }

  List<(String, String, String)> _providers(String currency) => currency == 'BDT'
      ? const <(String, String, String)>[('bkash', 'bKash', 'Pay with your bKash wallet'), ('sslcommerz', 'SSLCommerz', 'Cards, mobile & net banking')]
      : const <(String, String, String)>[('stripe', 'Card (Stripe)', 'Visa, Mastercard, Amex'), ('sslcommerz', 'SSLCommerz', 'International cards')];

  Future<void> _submit(CartState cart) async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final provider = _provider ?? _providers(cart.currency).first.$1;
    final repository = context.read<MarketplaceRepository>();
    final cartCubit = context.read<CartCubit>();
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final address = <String, String>{
        for (final entry in _fields.entries)
          if (entry.value.text.trim().isNotEmpty) entry.key: entry.key == 'country' ? entry.value.text.trim().toUpperCase() : entry.value.text.trim(),
      };
      final orderId = await repository.createOrder(items: cart.items, address: address);
      final url = await repository.pay(orderId, provider);
      cartCubit.clear();
      final opened = await launchUrl(url, mode: LaunchMode.externalApplication);
      if (!mounted) return;
      if (!opened) {
        setState(() => _error = 'Could not open the payment page. Find your order under "My orders" to retry.');
        return;
      }
      Navigator.of(context).popUntil((route) => route.isFirst);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Widget _field(String key, String label, {TextInputType? type, bool required = true, int? maxLength}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextFormField(
        controller: _fields[key],
        keyboardType: type,
        maxLength: maxLength,
        decoration: InputDecoration(labelText: label, counterText: ''),
        validator: required ? (v) => (v == null || v.trim().length < (key == 'country' ? 2 : 2)) ? 'Required' : null : null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final cart = context.watch<CartCubit>().state;
    final providers = _providers(cart.currency);
    final selected = providers.any((p) => p.$1 == _provider) ? _provider! : providers.first.$1;
    return Scaffold(
      appBar: AppBar(title: const Text('Checkout')),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: <Widget>[
            Text('Shipping address', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            _field('full_name', 'Full name'),
            _field('phone', 'Phone', type: TextInputType.phone),
            _field('line1', 'Address'),
            _field('city', 'City'),
            _field('postal_code', 'Postal code', required: false),
            _field('country', 'Country (2-letter code)', maxLength: 2),
            const SizedBox(height: 8),
            Text('Payment method', style: Theme.of(context).textTheme.titleMedium),
            for (final p in providers)
              RadioListTile<String>(
                value: p.$1,
                groupValue: selected,
                onChanged: (value) => setState(() => _provider = value),
                title: Text(p.$2),
                subtitle: Text(p.$3),
                contentPadding: EdgeInsets.zero,
              ),
            const Divider(),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: <Widget>[
                const Text('Items subtotal'),
                Text(formatMoney(cart.subtotalMinor, cart.currency), style: const TextStyle(fontWeight: FontWeight.bold)),
              ],
            ),
            const SizedBox(height: 4),
            Text('Shipping is added on the payment page. Items are reserved for 15 minutes.', style: Theme.of(context).textTheme.bodySmall),
            if (_error != null) ...<Widget>[
              const SizedBox(height: 12),
              Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ],
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _submitting || cart.items.isEmpty ? null : () => _submit(cart),
              child: _submitting ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Place order & pay'),
            ),
          ],
        ),
      ),
    );
  }
}

class OrdersScreen extends StatefulWidget {
  const OrdersScreen({super.key});

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
  List<Order>? _orders;
  String? _error;
  String? _busy;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final orders = await context.read<MarketplaceRepository>().orders();
      if (mounted) setState(() => _orders = orders);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _pay(Order order, String provider) async {
    setState(() => _busy = order.id);
    try {
      final url = await context.read<MarketplaceRepository>().pay(order.id, provider);
      await launchUrl(url, mode: LaunchMode.externalApplication);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _cancel(Order order) async {
    setState(() => _busy = order.id);
    try {
      await context.read<MarketplaceRepository>().cancelOrder(order.id);
      await _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('My orders')),
      body: _error != null
          ? Center(child: Text(_error!))
          : _orders == null
              ? const Center(child: CircularProgressIndicator())
              : _orders!.isEmpty
                  ? const Center(child: Text('You have no orders yet'))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        padding: const EdgeInsets.all(12),
                        itemCount: _orders!.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 8),
                        itemBuilder: (context, index) {
                          final order = _orders![index];
                          final providers = order.currency == 'BDT' ? const <String>['bkash', 'sslcommerz'] : const <String>['stripe', 'sslcommerz'];
                          return Card(
                            child: Padding(
                              padding: const EdgeInsets.all(12),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: <Widget>[
                                  Row(
                                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                    children: <Widget>[
                                      Text('#${order.id.substring(0, 8)}', style: const TextStyle(fontFamily: 'monospace')),
                                      Chip(label: Text(order.status == 'pending' && !order.payable ? 'expired' : order.status), visualDensity: VisualDensity.compact),
                                    ],
                                  ),
                                  for (final item in order.items) Text('${item.quantity} × ${item.title}'),
                                  const SizedBox(height: 6),
                                  Text(formatMoney(order.totalMinor, order.currency), style: const TextStyle(fontWeight: FontWeight.bold)),
                                  if (order.payable)
                                    Wrap(
                                      spacing: 8,
                                      children: <Widget>[
                                        for (final p in providers)
                                          FilledButton.tonal(
                                            style: FilledButton.styleFrom(minimumSize: const Size(0, 36)),
                                            onPressed: _busy == order.id ? null : () => _pay(order, p),
                                            child: Text('Pay with ${p == 'bkash' ? 'bKash' : p == 'stripe' ? 'card' : 'SSLCommerz'}'),
                                          ),
                                        TextButton(onPressed: _busy == order.id ? null : () => _cancel(order), child: const Text('Cancel')),
                                      ],
                                    ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}
