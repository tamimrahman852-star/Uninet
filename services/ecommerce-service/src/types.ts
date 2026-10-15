export type Currency = 'BDT' | 'USD';
export type PaymentProvider = 'stripe' | 'bkash' | 'sslcommerz';
export type OrderStatus = 'pending' | 'paid' | 'cancelled' | 'expired' | 'shipped' | 'delivered' | 'refunded';

export interface ShippingAddress {
  full_name: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postal_code?: string;
  country: string;
}

export interface OrderItemRecord {
  id: string;
  order_id: string;
  product_id: string;
  title: string;
  unit_price_minor: number;
  quantity: number;
}

export interface OrderRecord {
  id: string;
  user_id: string;
  status: OrderStatus;
  currency: Currency;
  subtotal_minor: number;
  shipping_minor: number;
  total_minor: number;
  payment_provider: PaymentProvider | null;
  payment_ref: string | null;
  transaction_id: string | null;
  shipping_address: ShippingAddress;
  expires_at: string;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductRecord {
  id: string;
  seller_id: string;
  category_id: string | null;
  title: string;
  description: string;
  price_minor: number;
  currency: Currency;
  stock: number;
  images: string[];
  attributes: Record<string, unknown>;
  status: 'active' | 'draft' | 'archived';
  rating_avg: number;
  rating_count: number;
  created_at: string;
  updated_at: string;
}

export interface RequestUser {
  id: string;
  role: string;
  email?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: RequestUser;
    }
  }
}
