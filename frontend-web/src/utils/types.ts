import type { Currency } from '@/store/cartStore';

export interface AuthorRef {
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
}

export interface Post {
  id: string;
  user_id: string;
  body: string;
  media_urls: string[];
  like_count: number;
  comment_count: number;
  created_at: string;
  author: AuthorRef | null;
  liked_by_me?: boolean;
}

export interface PostComment {
  id: string;
  post_id: string;
  user_id: string;
  body: string;
  created_at: string;
  author: AuthorRef | null;
}

export interface Story {
  id: string;
  user_id: string;
  media_url: string;
  caption: string | null;
  created_at: string;
  author: AuthorRef | null;
}

export interface Product {
  id: string;
  seller_id: string;
  category_id: string | null;
  title: string;
  description: string;
  price_minor: number;
  currency: Currency;
  stock: number;
  images: string[];
  rating_avg: number;
  rating_count: number;
  status: string;
  created_at: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
}

export interface OrderItem {
  id: string;
  product_id: string;
  title: string;
  unit_price_minor: number;
  quantity: number;
}

export interface Order {
  id: string;
  status: string;
  currency: Currency;
  subtotal_minor: number;
  shipping_minor: number;
  total_minor: number;
  payment_provider: string | null;
  expires_at: string;
  created_at: string;
  items?: OrderItem[];
}

export interface Video {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: string;
  duration_seconds: number | null;
  view_count: number;
  like_count: number;
  comment_count: number;
  created_at: string;
  hls_url: string | null;
  thumbnail_url: string | null;
  renditions?: string[];
  author?: AuthorRef | null;
}

export interface VideoComment {
  id: string;
  video_id: string;
  user_id: string;
  body: string;
  created_at: string;
  author: AuthorRef | null;
}

export function timeAgo(iso: string | number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

export function displayName(author: AuthorRef | null | undefined, fallback = 'User'): string {
  return author?.full_name || author?.username || fallback;
}
