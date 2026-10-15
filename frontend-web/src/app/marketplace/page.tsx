'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { AppShell } from '@/components/layouts/AppShell';
import { ProductCard } from '@/components/shared/ProductCard';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { formatMoney, useCartStore } from '@/store/cartStore';
import { ApiError, apiFetch } from '@/utils/api';
import type { Category, Order, Product } from '@/utils/types';

type Sort = 'newest' | 'price_asc' | 'price_desc' | 'rating';

interface ProductList {
  items: Product[];
  page: number;
  page_size: number;
  total: number;
}

function StatusBanner() {
  const params = useSearchParams();
  const status = params.get('status');
  if (!status) return null;
  const styles: Record<string, string> = {
    success: 'bg-emerald-50 text-emerald-800',
    failed: 'bg-red-50 text-red-800',
    cancelled: 'bg-amber-50 text-amber-800',
  };
  const text: Record<string, string> = {
    success: 'Payment received. Thank you! Your order is being prepared.',
    failed: 'The payment could not be completed. You can retry from My orders.',
    cancelled: 'Payment cancelled. Your order stays reserved for a few minutes; retry from My orders.',
  };
  return <p className={`rounded-lg p-3 text-sm ${styles[status] ?? 'bg-slate-100'}`}>{text[status] ?? status}</p>;
}

function SellForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ title: '', description: '', price: '', currency: 'BDT', stock: '1', image: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/api/v1/shop/products', {
        method: 'POST',
        body: {
          title: form.title.trim(),
          description: form.description.trim(),
          price_minor: Math.round(Number(form.price) * 100),
          currency: form.currency,
          stock: Number(form.stock),
          images: form.image.trim() ? [form.image.trim()] : [],
        },
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the product');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <form onSubmit={(e) => void submit(e)} className="relative w-full max-w-md space-y-3 rounded-2xl bg-white p-6 shadow-xl dark:bg-slate-900">
        <h2 className="text-lg font-bold">List a product</h2>
        <Input label="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required minLength={2} maxLength={200} />
        <div>
          <label className="mb-1 block text-sm font-medium">Description</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={3}
            className="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Input label="Price" type="number" min="0" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required />
          <div>
            <label className="mb-1 block text-sm font-medium">Currency</label>
            <select
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value })}
              className="h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="BDT">BDT</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <Input label="Stock" type="number" min="0" step="1" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} required />
        </div>
        <Input label="Image URL (https)" type="url" value={form.image} onChange={(e) => setForm({ ...form, image: e.target.value })} placeholder="https://…" />
        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        <div className="flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            Publish
          </Button>
        </div>
      </form>
    </div>
  );
}

function OrdersPanel() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await apiFetch<{ items: Order[] }>('/api/v1/shop/orders', { query: { page_size: 20 } });
    setOrders(data.items);
  }, []);

  useEffect(() => {
    void load().catch(() => setOrders([]));
  }, [load]);

  async function pay(order: Order, provider: 'stripe' | 'bkash' | 'sslcommerz') {
    setBusy(order.id);
    setMessage(null);
    try {
      const payment = await apiFetch<{ redirect_url: string }>(`/api/v1/shop/orders/${order.id}/pay`, { method: 'POST', body: { provider } });
      window.location.assign(payment.redirect_url);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Could not start the payment');
      setBusy(null);
    }
  }

  async function cancel(order: Order) {
    setBusy(order.id);
    try {
      await apiFetch(`/api/v1/shop/orders/${order.id}/cancel`, { method: 'POST' });
      await load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Could not cancel the order');
    } finally {
      setBusy(null);
    }
  }

  if (orders === null) {
    return (
      <div className="flex justify-center py-10 text-brand-600">
        <Spinner className="h-7 w-7" />
      </div>
    );
  }
  if (orders.length === 0) return <p className="py-10 text-center text-slate-500">You have no orders yet.</p>;

  return (
    <div className="space-y-3">
      {message && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{message}</p>}
      {orders.map((order) => {
        const expired = new Date(order.expires_at).getTime() < Date.now();
        const payable = order.status === 'pending' && !expired;
        const providers = order.currency === 'BDT' ? (['bkash', 'sslcommerz'] as const) : (['stripe', 'sslcommerz'] as const);
        return (
          <article key={order.id} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-mono text-xs text-slate-500">#{order.id.slice(0, 8)}</p>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold capitalize dark:bg-slate-800">
                {order.status === 'pending' && expired ? 'expired' : order.status}
              </span>
            </div>
            <ul className="mt-2 text-sm text-slate-700 dark:text-slate-300">
              {(order.items ?? []).map((item) => (
                <li key={item.id}>
                  {item.quantity} × {item.title}
                </li>
              ))}
            </ul>
            <p className="mt-2 font-semibold">{formatMoney(order.total_minor, order.currency)}</p>
            {payable && (
              <div className="mt-3 flex flex-wrap gap-2">
                {providers.map((provider) => (
                  <Button key={provider} size="sm" loading={busy === order.id} onClick={() => void pay(order, provider)}>
                    Pay with {provider === 'sslcommerz' ? 'SSLCommerz' : provider === 'bkash' ? 'bKash' : 'card'}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" disabled={busy === order.id} onClick={() => void cancel(order)}>
                  Cancel
                </Button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function MarketplaceContent() {
  const add = useCartStore((s) => s.add);
  const setCartOpen = useCartStore((s) => s.setOpen);

  const [tab, setTab] = useState<'shop' | 'orders'>('shop');
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [selling, setSelling] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    void apiFetch<{ items: Category[] }>('/api/v1/shop/categories').then((d) => setCategories(d.items)).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<ProductList>('/api/v1/shop/products', { query: { q: query, category, sort, page, page_size: 24 } })
      .then((data) => {
        if (cancelled) return;
        setProducts(data.items);
        setTotal(data.total);
      })
      .catch(() => {
        if (!cancelled) setNotice('Could not load products.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, category, sort, page, reload]);

  function addToCart(product: Product) {
    const result = add({
      productId: product.id,
      title: product.title,
      priceMinor: product.price_minor,
      currency: product.currency,
      image: product.images[0],
      maxQuantity: product.stock,
    });
    if (!result.ok) setNotice(result.reason ?? 'Could not add to cart');
    else {
      setNotice(null);
      setCartOpen(true);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / 24));

  return (
    <AppShell>
      <div className="space-y-4">
        <Suspense fallback={null}>
          <StatusBanner />
        </Suspense>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-slate-200 p-1 dark:bg-slate-800">
            {(['shop', 'orders'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={`rounded-md px-4 py-1.5 text-sm font-medium ${tab === value ? 'bg-white shadow dark:bg-slate-700' : 'text-slate-600 dark:text-slate-300'}`}
              >
                {value === 'shop' ? 'Shop' : 'My orders'}
              </button>
            ))}
          </div>
          <Button variant="secondary" size="sm" className="ml-auto" onClick={() => setSelling(true)}>
            + Sell a product
          </Button>
        </div>

        {tab === 'orders' ? (
          <OrdersPanel />
        ) : (
          <>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setPage(1);
                setQuery(q.trim());
              }}
            >
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search products"
                className="h-10 min-w-[200px] flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900"
              />
              <select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setPage(1);
                }}
                className="h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                aria-label="Category"
              >
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value as Sort);
                  setPage(1);
                }}
                className="h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                aria-label="Sort"
              >
                <option value="newest">Newest</option>
                <option value="price_asc">Price: low to high</option>
                <option value="price_desc">Price: high to low</option>
                <option value="rating">Top rated</option>
              </select>
              <Button type="submit">Search</Button>
            </form>

            {notice && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{notice}</p>}

            {loading ? (
              <div className="flex justify-center py-16 text-brand-600">
                <Spinner className="h-8 w-8" />
              </div>
            ) : products.length === 0 ? (
              <p className="py-16 text-center text-slate-500">No products found.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {products.map((product) => (
                  <ProductCard key={product.id} product={product} onAdd={addToCart} />
                ))}
              </div>
            )}

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-3">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <span className="text-sm text-slate-600">
                  Page {page} of {totalPages}
                </span>
                <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      {selling && <SellForm onClose={() => setSelling(false)} onCreated={() => setReload((n) => n + 1)} />}
    </AppShell>
  );
}

export default function MarketplacePage() {
  return (
    <Suspense fallback={null}>
      <MarketplaceContent />
    </Suspense>
  );
}
