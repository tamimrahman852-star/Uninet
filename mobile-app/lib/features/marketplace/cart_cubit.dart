import 'dart:convert';

import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'marketplace_models.dart';

class CartState {
  const CartState({this.items = const <CartItem>[]});

  final List<CartItem> items;

  int get count => items.fold(0, (sum, i) => sum + i.quantity);
  int get subtotalMinor => items.fold(0, (sum, i) => sum + i.priceMinor * i.quantity);
  String get currency => items.isEmpty ? 'BDT' : items.first.currency;
}

class CartCubit extends Cubit<CartState> {
  CartCubit() : super(const CartState());

  static const String _key = 'uninet.cart';

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    if (raw == null) return;
    try {
      final list = (jsonDecode(raw) as List<dynamic>).map((e) => CartItem.fromJson(e as Map<String, dynamic>)).toList();
      emit(CartState(items: list));
    } on Object {
      await prefs.remove(_key);
    }
  }

  Future<void> _save() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, jsonEncode(state.items.map((i) => i.toJson()).toList()));
  }

  /// Returns an error message when the product cannot be added.
  String? add(Product product) {
    if (product.stock < 1) return 'This product is out of stock';
    if (state.items.isNotEmpty && state.items.first.currency != product.currency) {
      return 'Your cart has ${state.items.first.currency} items. Checkout or clear it first.';
    }
    final existing = state.items.where((i) => i.productId == product.id).toList();
    if (existing.isNotEmpty) {
      final item = existing.first;
      final quantity = (item.quantity + 1).clamp(1, product.stock < 50 ? product.stock : 50);
      emit(CartState(items: state.items.map((i) => i.productId == product.id ? i.copyWith(quantity: quantity, maxQuantity: product.stock) : i).toList()));
    } else {
      emit(CartState(items: <CartItem>[
        ...state.items,
        CartItem(
          productId: product.id,
          title: product.title,
          priceMinor: product.priceMinor,
          currency: product.currency,
          quantity: 1,
          maxQuantity: product.stock,
          image: product.images.isEmpty ? null : product.images.first,
        ),
      ]));
    }
    _save();
    return null;
  }

  void setQuantity(String productId, int quantity) {
    emit(CartState(
      items: state.items
          .map((i) => i.productId == productId ? i.copyWith(quantity: quantity.clamp(0, i.maxQuantity < 50 ? i.maxQuantity : 50)) : i)
          .where((i) => i.quantity > 0)
          .toList(),
    ));
    _save();
  }

  void remove(String productId) {
    emit(CartState(items: state.items.where((i) => i.productId != productId).toList()));
    _save();
  }

  void clear() {
    emit(const CartState());
    _save();
  }
}
