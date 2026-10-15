import { z } from 'zod';
import { db } from '../db';
import type { RedisLockService } from '../services/redis-lock.service';
import { asyncHandler, HttpError, isUuid } from '../utils/http';

const setStockSchema = z.object({ stock: z.number().int().min(0).max(1_000_000) }).strict();

export class InventoryController {
  constructor(private readonly locks: RedisLockService) {}

  private async loadOwned(productId: string, user: { id: string; role: string }): Promise<{ id: string; stock: number }> {
    if (!isUuid(productId)) throw new HttpError(404, 'not_found', 'Product not found');
    let query = db.from('products').select('id, stock, seller_id').eq('id', productId);
    if (user.role !== 'admin') query = query.eq('seller_id', user.id);
    const { data, error } = await query.maybeSingle();
    if (error) throw new HttpError(500, 'database_error', 'Could not load inventory');
    if (!data) throw new HttpError(404, 'not_found', 'Product not found');
    return { id: data.id as string, stock: data.stock as number };
  }

  /** GET /inventory/:productId (seller of the product or admin) */
  get = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'unauthorized', 'Authentication required');
    const product = await this.loadOwned(req.params.productId, user);
    await this.locks.seedStock(product.id, product.stock);
    const available = await this.locks.getAvailable(product.id);
    res.json({
      product_id: product.id,
      stock: product.stock,
      available: available ?? product.stock,
      reserved: Math.max(0, product.stock - (available ?? product.stock)),
    });
  });

  /** PUT /inventory/:productId  { stock } */
  set = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'unauthorized', 'Authentication required');
    const { stock } = setStockSchema.parse(req.body);
    const product = await this.loadOwned(req.params.productId, user);

    await this.locks.withLock(`inventory:${product.id}`, 10_000, async () => {
      const { error } = await db
        .from('products')
        .update({ stock, updated_at: new Date().toISOString() })
        .eq('id', product.id);
      if (error) throw new HttpError(500, 'database_error', 'Could not update inventory');
      await this.locks.adjustStock(product.id, stock - product.stock, stock);
    });
    res.json({ product_id: product.id, stock });
  });

  /** POST /inventory/reap (admin): release expired reservations right now. */
  reap = asyncHandler(async (_req, res) => {
    const released = await this.reapExpired();
    res.json({ released_orders: released.length });
  });

  /** Returns reservations to the pool and marks the matching pending orders as expired. */
  async reapExpired(): Promise<string[]> {
    const orderIds = await this.locks.releaseExpired(200);
    if (orderIds.length > 0) {
      const { error } = await db
        .from('orders')
        .update({ status: 'expired', updated_at: new Date().toISOString() })
        .in('id', orderIds)
        .eq('status', 'pending');
      if (error) throw new HttpError(500, 'database_error', 'Could not expire orders');
    }
    return orderIds;
  }
}
