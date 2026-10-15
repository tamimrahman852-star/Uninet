class Product {
  const Product({
    required this.id,
    required this.title,
    required this.description,
    required this.priceMinor,
    required this.currency,
    required this.stock,
    required this.images,
    required this.ratingAvg,
    required this.ratingCount,
  });

  final String id;
  final String title;
  final String description;
  final int priceMinor;
  final String currency;
  final int stock;
  final List<String> images;
  final double ratingAvg;
  final int ratingCount;

  factory Product.fromJson(Map<String, dynamic> json) => Product(
        id: json['id'] as String,
        title: json['title'] as String,
        description: (json['description'] as String?) ?? '',
        priceMinor: (json['price_minor'] as num).toInt(),
        currency: json['currency'] as String,
        stock: (json['stock'] as num).toInt(),
        images: ((json['images'] as List<dynamic>?) ?? const <dynamic>[]).cast<String>(),
        ratingAvg: (json['rating_avg'] as num?)?.toDouble() ?? 0,
        ratingCount: (json['rating_count'] as num?)?.toInt() ?? 0,
      );
}

class CartItem {
  const CartItem({
    required this.productId,
    required this.title,
    required this.priceMinor,
    required this.currency,
    required this.quantity,
    required this.maxQuantity,
    this.image,
  });

  final String productId;
  final String title;
  final int priceMinor;
  final String currency;
  final int quantity;
  final int maxQuantity;
  final String? image;

  CartItem copyWith({int? quantity, int? maxQuantity}) => CartItem(
        productId: productId,
        title: title,
        priceMinor: priceMinor,
        currency: currency,
        quantity: quantity ?? this.quantity,
        maxQuantity: maxQuantity ?? this.maxQuantity,
        image: image,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'productId': productId,
        'title': title,
        'priceMinor': priceMinor,
        'currency': currency,
        'quantity': quantity,
        'maxQuantity': maxQuantity,
        'image': image,
      };

  factory CartItem.fromJson(Map<String, dynamic> json) => CartItem(
        productId: json['productId'] as String,
        title: json['title'] as String,
        priceMinor: json['priceMinor'] as int,
        currency: json['currency'] as String,
        quantity: json['quantity'] as int,
        maxQuantity: json['maxQuantity'] as int,
        image: json['image'] as String?,
      );
}

class OrderItem {
  const OrderItem({required this.title, required this.quantity, required this.unitPriceMinor});

  final String title;
  final int quantity;
  final int unitPriceMinor;

  factory OrderItem.fromJson(Map<String, dynamic> json) => OrderItem(
        title: json['title'] as String,
        quantity: (json['quantity'] as num).toInt(),
        unitPriceMinor: (json['unit_price_minor'] as num).toInt(),
      );
}

class Order {
  const Order({
    required this.id,
    required this.status,
    required this.currency,
    required this.totalMinor,
    required this.expiresAt,
    required this.items,
  });

  final String id;
  final String status;
  final String currency;
  final int totalMinor;
  final DateTime expiresAt;
  final List<OrderItem> items;

  bool get payable => status == 'pending' && expiresAt.isAfter(DateTime.now());

  factory Order.fromJson(Map<String, dynamic> json) => Order(
        id: json['id'] as String,
        status: json['status'] as String,
        currency: json['currency'] as String,
        totalMinor: (json['total_minor'] as num).toInt(),
        expiresAt: DateTime.parse(json['expires_at'] as String),
        items: ((json['items'] as List<dynamic>?) ?? const <dynamic>[]).map((i) => OrderItem.fromJson(i as Map<String, dynamic>)).toList(),
      );
}

String formatMoney(int minor, String currency) {
  final major = (minor / 100).toStringAsFixed(2);
  return currency == 'BDT' ? '৳$major' : '\$$major';
}
