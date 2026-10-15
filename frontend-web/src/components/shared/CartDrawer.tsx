'use client';

import { Button } from '@/components/ui/Button';
import { cartCount, cartSubtotal, formatMoney, useCartStore } from '@/store/cartStore';

export function CartDrawer({ onCheckout }: { onCheckout: () => void }) {
  const { items, open, setOpen, setQuantity, remove, clear } = useCartStore();
  if (!open) return null;

  const currency = items[0]?.currency ?? 'BDT';
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Shopping cart">
      <button type="button" aria-label="Close cart" className="absolute inset-0 animate-fade-in bg-black/40" onClick={() => setOpen(false)} />
      <aside className="relative flex h-full w-full max-w-md animate-slide-in flex-col bg-white shadow-xl dark:bg-slate-900">
        <header className="flex items-center justify-between border-b border-slate-200 p-4 dark:border-slate-800">
          <h2 className="text-lg font-semibold">Your cart ({cartCount(items)})</h2>
          <button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-xl hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {items.length === 0 && <p className="py-16 text-center text-slate-500">Your cart is empty.</p>}
          {items.map((item) => (
            <div key={item.productId} className="flex gap-3 rounded-lg border border-slate-200 p-2 dark:border-slate-800">
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
                {item.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.image} alt="" className="h-full w-full object-cover" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm font-medium">{item.title}</p>
                <p className="text-sm text-brand-700">{formatMoney(item.priceMinor, item.currency)}</p>
                <div className="mt-1 flex items-center gap-2">
                  <button type="button" className="h-6 w-6 rounded bg-slate-100 dark:bg-slate-800" onClick={() => setQuantity(item.productId, item.quantity - 1)} aria-label="Decrease">
                    −
                  </button>
                  <span className="w-6 text-center text-sm">{item.quantity}</span>
                  <button
                    type="button"
                    className="h-6 w-6 rounded bg-slate-100 disabled:opacity-40 dark:bg-slate-800"
                    disabled={item.quantity >= item.maxQuantity}
                    onClick={() => setQuantity(item.productId, item.quantity + 1)}
                    aria-label="Increase"
                  >
                    +
                  </button>
                  <button type="button" className="ml-auto text-xs text-red-600" onClick={() => remove(item.productId)}>
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {items.length > 0 && (
          <footer className="space-y-3 border-t border-slate-200 p-4 dark:border-slate-800">
            <div className="flex justify-between text-base font-semibold">
              <span>Subtotal</span>
              <span>{formatMoney(cartSubtotal(items), currency)}</span>
            </div>
            <p className="text-xs text-slate-500">Shipping is calculated at checkout.</p>
            <Button className="w-full" size="lg" onClick={onCheckout}>
              Checkout
            </Button>
            <Button className="w-full" variant="ghost" size="sm" onClick={clear}>
              Clear cart
            </Button>
          </footer>
        )}
      </aside>
    </div>
  );
}
