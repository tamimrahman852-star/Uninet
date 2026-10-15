import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { formatMoney } from '@/store/cartStore';
import type { Product } from '@/utils/types';

interface ProductCardProps {
  product: Product;
  onAdd: (product: Product) => void;
}

export function ProductCard({ product, onAdd }: ProductCardProps) {
  const soldOut = product.stock < 1;
  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
      <div className="relative aspect-square bg-slate-100 dark:bg-slate-800">
        {product.images[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.images[0]} alt={product.title} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-4xl text-slate-300">🛍️</div>
        )}
        {soldOut && <span className="absolute left-2 top-2 rounded bg-slate-900/80 px-2 py-0.5 text-xs font-semibold text-white">Sold out</span>}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="line-clamp-2 text-sm font-medium text-slate-900 dark:text-slate-100">{product.title}</h3>
        {product.rating_count > 0 && (
          <p className="text-xs text-amber-600">
            ★ {product.rating_avg.toFixed(1)} <span className="text-slate-400">({product.rating_count})</span>
          </p>
        )}
        <p className="mt-auto text-lg font-bold text-brand-700 dark:text-brand-300">{formatMoney(product.price_minor, product.currency)}</p>
        {!soldOut && product.stock <= 5 && <p className="text-xs text-orange-600">Only {product.stock} left</p>}
        <Button size="sm" disabled={soldOut} onClick={() => onAdd(product)}>
          {soldOut ? 'Out of stock' : 'Add to cart'}
        </Button>
        <Link href={`/marketplace?product=${product.id}`} className="sr-only">
          View {product.title}
        </Link>
      </div>
    </article>
  );
}
