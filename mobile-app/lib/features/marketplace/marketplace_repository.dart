import 'package:dio/dio.dart';

import '../../core/network/dio_client.dart';
import 'marketplace_models.dart';

class ProductPage {
  const ProductPage({required this.items, required this.total});

  final List<Product> items;
  final int total;
}

class MarketplaceRepository {
  MarketplaceRepository(this._api);

  final ApiClient _api;

  Future<ProductPage> products({String? query, String sort = 'newest', int page = 1}) async {
    try {
      final response = await _api.dio.get<Map<String, dynamic>>(
        '/api/v1/shop/products',
        queryParameters: <String, dynamic>{
          if (query != null && query.isNotEmpty) 'q': query,
          'sort': sort,
          'page': page,
          'page_size': 20,
        },
      );
      final data = response.data!;
      return ProductPage(
        items: (data['items'] as List<dynamic>).map((p) => Product.fromJson(p as Map<String, dynamic>)).toList(),
        total: (data['total'] as num).toInt(),
      );
    } on DioException catch (e) {
      throw ApiException.from(e);
    }
  }

  /// Creates the order (reserving stock for a few minutes) and returns its id.
  Future<String> createOrder({required List<CartItem> items, required Map<String, String> address}) async {
    try {
      final response = await _api.dio.post<Map<String, dynamic>>(
        '/api/v1/shop/orders',
        data: <String, dynamic>{
          'items': items.map((i) => <String, dynamic>{'product_id': i.productId, 'quantity': i.quantity}).toList(),
          'shipping_address': address,
        },
      );
      return (response.data!['order'] as Map<String, dynamic>)['id'] as String;
    } on DioException catch (e) {
      throw ApiException.from(e);
    }
  }

  /// Starts a payment and returns the provider page to open.
  Future<Uri> pay(String orderId, String provider) async {
    try {
      final response = await _api.dio.post<Map<String, dynamic>>('/api/v1/shop/orders/$orderId/pay', data: <String, dynamic>{'provider': provider});
      return Uri.parse(response.data!['redirect_url'] as String);
    } on DioException catch (e) {
      throw ApiException.from(e);
    }
  }

  Future<List<Order>> orders() async {
    try {
      final response = await _api.dio.get<Map<String, dynamic>>('/api/v1/shop/orders', queryParameters: <String, dynamic>{'page_size': 30});
      return (response.data!['items'] as List<dynamic>).map((o) => Order.fromJson(o as Map<String, dynamic>)).toList();
    } on DioException catch (e) {
      throw ApiException.from(e);
    }
  }

  Future<void> cancelOrder(String orderId) async {
    try {
      await _api.dio.post<void>('/api/v1/shop/orders/$orderId/cancel');
    } on DioException catch (e) {
      throw ApiException.from(e);
    }
  }
}
