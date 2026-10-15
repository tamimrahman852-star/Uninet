import { z } from 'zod';
import { env } from '../config';
import { db } from '../db';
import type { RedisLockService } from '../services/redis-lock.service';
import type { ProductRecord } from '../types';
import { asyncHandler, HttpError, isUuid } from '../utils/http';

const currencySchema = z.enum(['BDT', 'USD']);

const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().uuid().optional(),
  seller: z.string().uuid().optional(),
  min_price: z.coerce.number().int().min(0).optional(),
  max_price: z.coerce.number().int().min(0).optional(),
  currency: currencySchema.optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'rating']).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(60).default(24),
});

const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => u.startsWith('https://'), 'Image URLs must be https');

const createSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(10_000).default(''),
    price_minor: z.number().int().min(0).max(100_000_000),
    currency: currencySchema.default('BDT'),
    stock: z.number().int().min(0).max(1_000_000).default(0),
    category_id: z.string().uuid().nullable().optional(),
    images: z.array(httpsUrl).max(10).default([]),
    attributes: z.record(z.unknown()).default({}),
    status: z.enum(['active', 'draft']).default('active'),
  })
  .strict();

const updateSchema = createSchema
  .omit({ stock: true })
  .partial()
  .extend({ status: z.enum(['active', 'draft', 'archived']).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export class ProductController {
  constructor(private readonly locks: RedisLockService) {}

  list = asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const from = (q.page - 1) * q.page_size;

    let query = db.from('products').select('*', { count: 'exact' }).eq('status', 'active');
    if (q.q) query = query.textSearch('search', q.q, { type: 'websearch', config: 'simple' });
    if (q.category) query = query.eq('category_id', q.category);
    if (q.seller) query = query.eq('seller_id', q.seller);
    if (q.currency) query = query.eq('currency', q.currency);
    if (q.min_price !== undefined) query = query.gte('price_minor', q.min_price);
    if (q.max_price !== undefined) query = query.lte('price_minor', q.max_price);

    switch (q.sort) {
      case 'price_asc':
        query = query.order('price_minor', { ascending: true });
        break;
      case 'price_desc':
        query = query.order('price_minor', { ascending: false });
        break;
      case 'rating':
        query = query.order('rating_avg', { ascending: false }).order('rating_count', { ascending: false });
        break;
      default:
        query = query.order('created_at', { ascending: false });
    }

    const { data, count, error } = await query.range(from, from + q.page_size - 1);
    if (error) {
      req.log.error({ err: error }, 'product list failed');
      throw new HttpError(500, 'database_error', 'Could not load products');
    }
    res.json({ items: data ?? [], page: q.page, page_size: q.page_size, total: count ?? 0 });
  });

  categories = asyncHandler(async (_req, res) => {
    const { data, error } = await db.from('categories').select('*').order('name');
    if (error) throw new HttpError(500, 'database_error', 'Could not load categories');
    res.json({ items: data ?? [] });
  });

  get = asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) throw new HttpError(404, 'not_found', 'Product not found');
    const { data, error } = await db.from('products').select('*').eq('id', id).maybeSingle();
    if (error) throw new HttpError(500, 'database_error', 'Could not load product');
    const product = data as ProductRecord | null;
    const isOwnerOrAdmin = req.user && product && (req.user.id === product.seller_id || req.user.role === 'admin');
    if (!product || (product.status !== 'active' && !isOwnerOrAdmin)) {
      throw new HttpError(404, 'not_found', 'Product not found');
    }
    res.json({ product });
  });

  create = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'unauthorized', 'Authentication required');
    const canSell = env.OPEN_SELLER_REGISTRATION || user.role === 'seller' || user.role === 'admin';
    if (!canSell) throw new HttpError(403, 'forbidden', 'Only sellers can list products');

    const body = createSchema.parse(req.body);
    const { data, error } = await db
      .from('products')
      .insert({ ...body, seller_id: user.id })
      .select('*')
      .single();
    if (error || !data) {
      req.log.error({ err: error }, 'product create failed');
      throw new HttpError(500, 'database_error', 'Could not create product');
    }
    const product = data as ProductRecord;
    await this.locks.seedStock(product.id, product.stock);
    res.status(201).json({ product });
  });

  update = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'unauthorized', 'Authentication required');
    const id = req.params.id;
    if (!isUuid(id)) throw new HttpError(404, 'not_found', 'Product not found');
    const body = updateSchema.parse(req.body);

    let query = db.from('products').update({ ...body, updated_at: new Date().toISOString() }).eq('id', id);
    if (user.role !== 'admin') query = query.eq('seller_id', user.id);
    const { data, error } = await query.select('*').maybeSingle();
    if (error) throw new HttpError(500, 'database_error', 'Could not update product');
    if (!data) throw new HttpError(404, 'not_found', 'Product not found');
    res.json({ product: data });
  });

  /** Soft delete: orders keep referencing the row. */
  remove = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'unauthorized', 'Authentication required');
    const id = req.params.id;
    if (!isUuid(id)) throw new HttpError(404, 'not_found', 'Product not found');

    let query = db.from('products').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', id);
    if (user.role !== 'admin') query = query.eq('seller_id', user.id);
    const { data, error } = await query.select('id').maybeSingle();
    if (error) throw new HttpError(500, 'database_error', 'Could not delete product');
    if (!data) throw new HttpError(404, 'not_found', 'Product not found');
    res.status(204).end();
  });
}
