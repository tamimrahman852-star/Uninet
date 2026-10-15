import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type Stripe from 'stripe';
import { z } from 'zod';
import { env, logger } from '../config';
import { db } from '../db';
import { PaymentService, type CustomerInfo } from '../services/payment.service';
import type { RedisLockService, ReserveLine } from '../services/redis-lock.service';
import type { OrderItemRecord, OrderRecord, PaymentProvider } from '../types';
import { asyncHandler, HttpError, isUuid } from '../utils/http';

const addressSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(6).max(30),
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2).max(100),
  region: z.string().trim().max(100).optional(),
  postal_code: z.string().trim().max(20).optional(),
  country: z.string().trim().length(2).toUpperCase(),
});

const createOrderSchema = z
  .object({
    items: z
      .array(z.object({ product_id: z.string().uuid(), quantity: z.number().int().min(1).max(50) }).strict())
      .min(1)
      .max(50),
    shipping_address: addressSchema,
  })
  .strict();

const paySchema = z.object({ provider: z.enum(['stripe', 'bkash', 'sslcommerz']) }).strict();

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(20),
});

/** Flat shipping in minor units; free above the threshold. */
const SHIPPING = {
  BDT: { flat: 6_000, freeAbove: 500_000 },
  USD: { flat: 500, freeAbove: 10_000 },
} as const;

type ConfirmResult = 'paid' | 'already_paid' | 'insufficient_stock' | 'invalid_state' | 'not_found';

export class OrderController {
  constructor(
    private readonly locks: RedisLockService,
    private readonly payments: PaymentService,
  ) {}

  /* ------------------------------ helpers ------------------------------ */

  private async loadItems(orderId: string): Promise<OrderItemRecord[]> {
    const { data, error } = await db.from('order_items').select('*').eq('order_id', orderId);
    if (error) throw new HttpError(500, 'database_error', 'Could not load order items');
    return (data ?? []) as OrderItemRecord[];
  }

  private async loadOrder(orderId: string, user: { id: string; role: string }): Promise<OrderRecord> {
    if (!isUuid(orderId)) throw new HttpError(404, 'not_found', 'Order not found');
    const { data, error } = await db.from('orders').select('*').eq('id', orderId).maybeSingle();
    if (error) throw new HttpError(500, 'database_error', 'Could not load order');
    const order = data as OrderRecord | null;
    if (!order || (order.user_id !== user.id && user.role !== 'admin')) {
      throw new HttpError(404, 'not_found', 'Order not found');
    }
    return order;
  }

  private async findByPaymentRef(reference: string): Promise<OrderRecord | null> {
    const { data, error } = await db.from('orders').select('*').eq('payment_ref', reference).maybeSingle();
    if (error) throw new HttpError(500, 'database_error', 'Could not load order');
    return data as OrderRecord | null;
  }

  private redirectToShop(res: Response, orderId: string | null, status: 'success' | 'failed' | 'cancelled'): void {
    const url = new URL('/marketplace', env.FRONTEND_URL);
    if (orderId) url.searchParams.set('order', orderId);
    url.searchParams.set('status', status);
    res.redirect(303, url.toString());
  }

  /** Marks an order paid (idempotent) and reconciles the Redis stock counters. */
  async confirmPaid(orderId: string, provider: PaymentProvider, reference: string | null, transactionId?: string): Promise<ConfirmResult> {
    return this.locks.withLock(`confirm:${orderId}`, 30_000, async () => {
      const { data: before } = await db.from('orders').select('status').eq('id', orderId).maybeSingle();
      const { data, error } = await db.rpc('confirm_order', {
        p_order_id: orderId,
        p_provider: provider,
        p_payment_ref: reference,
        p_transaction_id: transactionId ?? null,
      });
      if (error) {
        logger.error({ err: error, orderId }, 'confirm_order failed');
        throw new HttpError(500, 'database_error', 'Could not confirm the order');
      }
      const result = data as ConfirmResult;

      if (result === 'paid') {
        if (before?.status === 'expired') {
          // The reservation had been returned to the pool; take the units out again.
          const items = await this.loadItems(orderId);
          const { data: stocks } = await db.from('products').select('id, stock').in('id', items.map((i) => i.product_id));
          const stockById = new Map((stocks ?? []).map((s) => [s.id as string, s.stock as number]));
          for (const item of items) {
            await this.locks.adjustStock(item.product_id, -item.quantity, stockById.get(item.product_id) ?? 0);
          }
        } else {
          await this.locks.commit(orderId);
        }
      } else if (result === 'insufficient_stock') {
        await db.from('orders').update({ status: 'cancelled', payment_provider: provider, payment_ref: reference, updated_at: new Date().toISOString() }).eq('id', orderId);
        logger.error({ orderId, provider, reference }, 'PAID ORDER COULD NOT BE FULFILLED - manual refund required');
      }
      return result;
    });
  }

  /* ----------------------------- user routes ----------------------------- */

  create = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'unauthorized', 'Authentication required');
    const body = createOrderSchema.parse(req.body);

    const quantities = new Map<string, number>();
    for (const line of body.items) {
      quantities.set(line.product_id, (quantities.get(line.product_id) ?? 0) + line.quantity);
    }
    const ids = [...quantities.keys()];

    const { data: products, error: productError } = await db
      .from('products')
      .select('id, title, price_minor, currency, stock, status')
      .in('id', ids);
    if (productError) throw new HttpError(500, 'database_error', 'Could not load products');
    if (!products || products.length !== ids.length) throw new HttpError(404, 'product_not_found', 'One or more products do not exist');

    const currencies = new Set(products.map((p) => p.currency as string));
    if (currencies.size !== 1) throw new HttpError(422, 'mixed_currency', 'All items in an order must use the same currency');
    const currency = [...currencies][0] as 'BDT' | 'USD';

    for (const p of products) {
      if (p.status !== 'active') throw new HttpError(409, 'product_unavailable', `"${p.title}" is no longer available`);
    }

    await Promise.all(products.map((p) => this.locks.seedStock(p.id as string, p.stock as number)));

    const orderId = randomUUID();
    const lines: ReserveLine[] = ids.map((productId) => ({ productId, quantity: quantities.get(productId) as number }));
    let reservation = await this.locks.reserve(orderId, lines, env.RESERVATION_TTL_SECONDS);
    if (!reservation.ok && reservation.reason === 'not_seeded') {
      await Promise.all(products.map((p) => this.locks.seedStock(p.id as string, p.stock as number)));
      reservation = await this.locks.reserve(orderId, lines, env.RESERVATION_TTL_SECONDS);
    }
    if (!reservation.ok) {
      const product = products.find((p) => p.id === reservation.productId);
      throw new HttpError(409, 'out_of_stock', `"${product?.title ?? 'An item'}" does not have enough stock`, {
        product_id: reservation.productId,
      });
    }

    try {
      const subtotal = products.reduce((sum, p) => sum + (p.price_minor as number) * (quantities.get(p.id as string) as number), 0);
      const rule = SHIPPING[currency];
      const shipping = subtotal >= rule.freeAbove ? 0 : rule.flat;
      const expiresAt = new Date(Date.now() + env.RESERVATION_TTL_SECONDS * 1000).toISOString();

      const { data: order, error: orderError } = await db
        .from('orders')
        .insert({
          id: orderId,
          user_id: user.id,
          currency,
          subtotal_minor: subtotal,
          shipping_minor: shipping,
          total_minor: subtotal + shipping,
          shipping_address: body.shipping_address,
          expires_at: expiresAt,
        })
        .select('*')
        .single();
      if (orderError || !order) throw new HttpError(500, 'database_error', 'Could not create the order');

      const { data: items, error: itemsError } = await db
        .from('order_items')
        .insert(
          products.map((p) => ({
            order_id: orderId,
            product_id: p.id,
            title: p.title,
            unit_price_minor: p.price_minor,
            quantity: quantities.get(p.id as string),
          })),
        )
        .select('*');
      if (itemsError) {
        await db.from('orders').delete().eq('id', orderId);
        throw new HttpError(500, 'database_error', 'Could not create the order items');
      }
      res.status(201).json({ order: { ...order, items } });
    } catch (err) {
      await this.locks.release(orderId);
      throw err;
    }
  });

  list = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'unauthorized', 'Authentication required');
    const { page, page_size } = listQuerySchema.parse(req.query);
    const from = (page - 1) * page_size;
    const { data, count, error } = await db
      .from('orders')
      .select('*, items:order_items(*)', { count: 'exact' })
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(from, from + page_size - 1);
    if (error) throw new HttpError(500, 'database_error', 'Could not load orders');
    res.json({ items: data ?? [], page, page_size, total: count ?? 0 });
  });

  get = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'unauthorized', 'Authentication required');
    const order = await this.loadOrder(req.params.id, user);
    res.json({ order: { ...order, items: await this.loadItems(order.id) } });
  });

  pay = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'unauthorized', 'Authentication required');
    const { provider } = paySchema.parse(req.body);
    const order = await this.loadOrder(req.params.id, user);
    if (order.user_id !== user.id) throw new HttpError(403, 'forbidden', 'Only the buyer can pay for an order');
    if (order.status !== 'pending') throw new HttpError(409, 'invalid_state', `Order is ${order.status}`);
    if (new Date(order.expires_at).getTime() < Date.now()) {
      throw new HttpError(410, 'order_expired', 'This order has expired, please place a new one');
    }

    const items = await this.loadItems(order.id);
    const address = order.shipping_address;
    const customer: CustomerInfo = {
      name: address.full_name,
      email: user.email ?? '',
      phone: address.phone,
      address: address.line1,
      city: address.city,
      country: address.country,
      postcode: address.postal_code ?? '',
    };

    const init = await this.locks.withLock(`pay:${order.id}`, 30_000, async () => {
      const result = await this.payments.init(order, items, customer, provider);
      const { error } = await db
        .from('orders')
        .update({ payment_provider: provider, payment_ref: result.reference, updated_at: new Date().toISOString() })
        .eq('id', order.id)
        .eq('status', 'pending');
      if (error) throw new HttpError(500, 'database_error', 'Could not record the payment reference');
      return result;
    });
    res.json({ provider: init.provider, redirect_url: init.redirectUrl, reference: init.reference });
  });

  cancel = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'unauthorized', 'Authentication required');
    const order = await this.loadOrder(req.params.id, user);
    if (order.user_id !== user.id) throw new HttpError(403, 'forbidden', 'Only the buyer can cancel an order');
    const { data, error } = await db
      .from('orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', order.id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle();
    if (error) throw new HttpError(500, 'database_error', 'Could not cancel the order');
    if (!data) throw new HttpError(409, 'invalid_state', `Order is ${order.status}`);
    await this.locks.release(order.id);
    res.json({ order: data });
  });

  /* ---------------------- payment provider callbacks ---------------------- */

  /** POST /payments/stripe/webhook (raw body) */
  stripeWebhook = asyncHandler(async (req: Request, res: Response) => {
    const event = this.payments.verifyStripeEvent(req.body as Buffer, req.headers['stripe-signature'] as string | undefined);

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.order_id ?? session.client_reference_id;
      if (session.payment_status === 'paid' && orderId && isUuid(orderId)) {
        const { data } = await db.from('orders').select('*').eq('id', orderId).maybeSingle();
        const order = data as OrderRecord | null;
        if (!order) {
          logger.error({ orderId, sessionId: session.id }, 'Stripe payment for unknown order');
        } else if (session.amount_total !== order.total_minor || session.currency?.toUpperCase() !== order.currency) {
          logger.error({ orderId, amount: session.amount_total, expected: order.total_minor }, 'Stripe amount mismatch, ignoring');
        } else {
          const intent = typeof session.payment_intent === 'string' ? session.payment_intent : undefined;
          await this.confirmPaid(orderId, 'stripe', session.id, intent);
        }
      }
    }
    res.json({ received: true });
  });

  /** GET /payments/bkash/callback?paymentID=...&status=success|failure|cancel */
  bkashCallback = asyncHandler(async (req, res) => {
    const paymentId = typeof req.query.paymentID === 'string' ? req.query.paymentID : '';
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const order = paymentId ? await this.findByPaymentRef(paymentId) : null;
    if (!order) {
      this.redirectToShop(res, null, 'failed');
      return;
    }
    if (status !== 'success') {
      this.redirectToShop(res, order.id, status === 'cancel' ? 'cancelled' : 'failed');
      return;
    }

    const execution = await this.payments.executeBkashPayment(paymentId);
    const amountOk = !execution.amount || Math.round(Number(execution.amount) * 100) === order.total_minor;
    if (!execution.completed || !amountOk) {
      logger.warn({ orderId: order.id, completed: execution.completed, amount: execution.amount }, 'bKash payment rejected');
      this.redirectToShop(res, order.id, 'failed');
      return;
    }
    const result = await this.confirmPaid(order.id, 'bkash', paymentId, execution.trxId);
    this.redirectToShop(res, order.id, result === 'paid' || result === 'already_paid' ? 'success' : 'failed');
  });

  /** Shared by SSLCommerz success (browser redirect) and IPN (server call). */
  private async handleSslCommerzPayment(body: Record<string, unknown>): Promise<{ orderId: string | null; ok: boolean }> {
    const valId = typeof body.val_id === 'string' ? body.val_id : '';
    const tranId = typeof body.tran_id === 'string' ? body.tran_id : '';
    if (!valId || !tranId) return { orderId: null, ok: false };

    const order = await this.findByPaymentRef(tranId);
    if (!order) return { orderId: null, ok: false };

    const validation = await this.payments.validateSslCommerz(valId);
    const amountOk = validation.amount !== undefined && Math.round(Number(validation.amount) * 100) === order.total_minor;
    const currencyOk = !validation.currency || validation.currency === order.currency;
    if (!validation.valid || validation.tranId !== tranId || !amountOk || !currencyOk) {
      logger.warn({ orderId: order.id, validation }, 'SSLCommerz validation rejected');
      return { orderId: order.id, ok: false };
    }
    const result = await this.confirmPaid(order.id, 'sslcommerz', tranId, validation.bankTranId ?? valId);
    return { orderId: order.id, ok: result === 'paid' || result === 'already_paid' };
  }

  sslSuccess = asyncHandler(async (req, res) => {
    const { orderId, ok } = await this.handleSslCommerzPayment((req.body ?? {}) as Record<string, unknown>);
    this.redirectToShop(res, orderId, ok ? 'success' : 'failed');
  });

  sslIpn = asyncHandler(async (req, res) => {
    const { ok } = await this.handleSslCommerzPayment((req.body ?? {}) as Record<string, unknown>);
    res.status(ok ? 200 : 202).json({ received: true });
  });

  sslFailOrCancel = (status: 'failed' | 'cancelled') =>
    asyncHandler(async (req, res) => {
      const tranId = typeof req.body?.tran_id === 'string' ? req.body.tran_id : '';
      const order = tranId ? await this.findByPaymentRef(tranId) : null;
      this.redirectToShop(res, order?.id ?? null, status);
    });
}
