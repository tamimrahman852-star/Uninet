'use client';

import { useState } from 'react';
import { CartDrawer } from '@/components/shared/CartDrawer';
import { CheckoutModal } from '@/components/shared/CheckoutModal';
import { useAuthStore } from '@/store/authStore';
import { useCartStore } from '@/store/cartStore';

/** Mounted once in the root layout so the cart drawer and checkout work from every page. */
export function CartHost() {
  const session = useAuthStore((s) => s.session);
  const setOpen = useCartStore((s) => s.setOpen);
  const [checkout, setCheckout] = useState(false);

  if (!session) return null;
  return (
    <>
      <CartDrawer
        onCheckout={() => {
          setOpen(false);
          setCheckout(true);
        }}
      />
      <CheckoutModal open={checkout} onClose={() => setCheckout(false)} />
    </>
  );
}
