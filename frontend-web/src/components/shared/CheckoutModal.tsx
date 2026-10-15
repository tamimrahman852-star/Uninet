'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { cartSubtotal, formatMoney, useCartStore } from '@/store/cartStore';
import { ApiError, apiFetch } from '@/utils/api';
import type { Order } from '@/utils/types';

type Provider = 'stripe' | 'bkash' | 'sslcommerz';

const PROVIDERS: Record<'BDT' | 'USD', { id: Provider; label: string; hint: string }[]> = {
  BDT: [
    { id: 'bkash', label: 'bKash', hint: 'Pay with your bKash wallet' },
    { id: 'sslcommerz', label: 'SSLCommerz', hint: 'Cards, mobile banking, net banking' },
  ],
  USD: [
    { id: 'stripe', label: 'Card (Stripe)', hint: 'Visa, Mastercard, Amex' },
    { id: 'sslcommerz', label: 'SSLCommerz', hint: 'International cards' },
  ],
};

interface CheckoutModalProps {
  open: boolean;
  onClose: () => void;
}

export function CheckoutModal({ open, onClose }: CheckoutModalProps) {
  const items = useCartStore((s) => s.items);
  const clear = useCartStore((s) => s.clear);
  const currency = items[0]?.currency ?? 'BDT';
  const options = PROVIDERS[currency];

  const [provider, setProvider] = useState<Provider | null>(null);
  const [form, setForm] = useState({ full_name: '', phone: '', line1: '', city: '', postal_code: '', country: 'BD' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;
  const selected = provider && options.some((o) => o.id === provider) ? provider : options[0].id;

  function update(field: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { order } = await apiFetch<{ order: Order }>('/api/v1/shop/orders', {
        method: 'POST',
        body: {
          items: items.map((i) => ({ product_id: i.productId, quantity: i.quantity })),
          shipping_address: { ...form, postal_code: form.postal_code || undefined },
        },
      });
      const payment = await apiFetch<{ redirect_url: string }>(`/api/v1/shop/orders/${order.id}/pay`, {
        method: 'POST',
        body: { provider: selected },
      });
      clear();
      window.location.assign(payment.redirect_url);
    } catch (err) {
      if (err instanceof ApiError) {
        const detail = Array.isArray(err.details) ? (err.details as { message?: string }[])[0]?.message : undefined;
        setError(detail ? `${err.message}: ${detail}` : err.message);
      } else {
        setError('Something went wrong, please try again.');
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Checkout">
      <button type="button" aria-label="Close checkout" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <form
        onSubmit={(e) => void submit(e)}
        className="relative max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-2xl bg-white p-6 shadow-xl dark:bg-slate-900"
      >
        <h2 className="text-xl font-bold">Checkout</h2>

        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-semibold text-slate-600">Shipping address</legend>
          <Input label="Full name" value={form.full_name} onChange={(e) => update('full_name', e.target.value)} required minLength={2} autoComplete="name" />
          <Input label="Phone" type="tel" value={form.phone} onChange={(e) => update('phone', e.target.value)} required minLength={6} autoComplete="tel" />
          <Input label="Address" value={form.line1} onChange={(e) => update('line1', e.target.value)} required minLength={3} autoComplete="street-address" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="City" value={form.city} onChange={(e) => update('city', e.target.value)} required minLength={2} autoComplete="address-level2" />
            <Input label="Postal code" value={form.postal_code} onChange={(e) => update('postal_code', e.target.value)} autoComplete="postal-code" />
          </div>
          <Input
            label="Country (2-letter code)"
            value={form.country}
            onChange={(e) => update('country', e.target.value.toUpperCase().slice(0, 2))}
            required
            minLength={2}
            maxLength={2}
          />
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold text-slate-600">Payment method</legend>
          {options.map((option) => (
            <label
              key={option.id}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 ${selected === option.id ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20' : 'border-slate-200 dark:border-slate-700'}`}
            >
              <input type="radio" name="provider" checked={selected === option.id} onChange={() => setProvider(option.id)} />
              <span>
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs text-slate-500">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="flex items-center justify-between border-t border-slate-200 pt-3 text-sm dark:border-slate-800">
          <span>Items subtotal</span>
          <strong>{formatMoney(cartSubtotal(items), currency)}</strong>
        </div>
        <p className="text-xs text-slate-500">Shipping is added to the total on the payment page. Your items are reserved for 15 minutes.</p>

        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={submitting}>
            Back
          </Button>
          <Button type="submit" className="flex-1" loading={submitting} disabled={items.length === 0}>
            Place order &amp; pay
          </Button>
        </div>
      </form>
    </div>
  );
}
