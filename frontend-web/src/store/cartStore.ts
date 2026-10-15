'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Currency = 'BDT' | 'USD';

export interface CartItem {
  productId: string;
  title: string;
  priceMinor: number;
  currency: Currency;
  image?: string;
  quantity: number;
  maxQuantity: number;
}

interface CartState {
  items: CartItem[];
  open: boolean;
  add: (item: Omit<CartItem, 'quantity'>, quantity?: number) => { ok: boolean; reason?: string };
  setQuantity: (productId: string, quantity: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
  setOpen: (open: boolean) => void;
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      open: false,

      add: (item, quantity = 1) => {
        const { items } = get();
        if (items.length > 0 && items[0].currency !== item.currency) {
          return { ok: false, reason: `Your cart contains ${items[0].currency} items. Checkout or clear it before adding ${item.currency} items.` };
        }
        if (item.maxQuantity < 1) return { ok: false, reason: 'This product is out of stock' };
        const existing = items.find((i) => i.productId === item.productId);
        if (existing) {
          set({
            items: items.map((i) =>
              i.productId === item.productId
                ? { ...i, maxQuantity: item.maxQuantity, quantity: Math.min(i.quantity + quantity, Math.min(item.maxQuantity, 50)) }
                : i,
            ),
          });
        } else {
          set({ items: [...items, { ...item, quantity: Math.min(quantity, item.maxQuantity, 50) }] });
        }
        return { ok: true };
      },

      setQuantity: (productId, quantity) =>
        set((state) => ({
          items: state.items
            .map((i) => (i.productId === productId ? { ...i, quantity: Math.max(0, Math.min(quantity, i.maxQuantity, 50)) } : i))
            .filter((i) => i.quantity > 0),
        })),

      remove: (productId) => set((state) => ({ items: state.items.filter((i) => i.productId !== productId) })),
      clear: () => set({ items: [] }),
      setOpen: (open) => set({ open }),
    }),
    {
      name: 'uninet-cart',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ items: state.items }),
    },
  ),
);

export const cartCount = (items: CartItem[]): number => items.reduce((n, i) => n + i.quantity, 0);
export const cartSubtotal = (items: CartItem[]): number => items.reduce((sum, i) => sum + i.priceMinor * i.quantity, 0);

export function formatMoney(minor: number, currency: Currency): string {
  const major = minor / 100;
  if (currency === 'BDT') return `৳${major.toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
