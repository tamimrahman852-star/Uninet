/**
 * Payment gateway integrations: Stripe (USD), bKash tokenized checkout (BDT) and SSLCommerz (BDT/USD).
 * Amounts are stored as integer minor units (cents / poisha); each provider receives the format it expects.
 */
import Stripe from 'stripe';
import type Redis from 'ioredis';
import { env, logger } from '../config';
import type { Currency, OrderItemRecord, OrderRecord, PaymentProvider } from '../types';
import { HttpError } from '../utils/http';

const SUPPORTED_CURRENCIES: Record<PaymentProvider, Currency[]> = {
  stripe: ['USD'],
  bkash: ['BDT'],
  sslcommerz: ['BDT', 'USD'],
};

export interface PaymentInit {
  provider: PaymentProvider;
  redirectUrl: string;
  /** Provider reference stored on the order (Stripe session id, bKash paymentID, SSLCommerz tran_id). */
  reference: string;
}

export interface CustomerInfo {
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  postcode: string;
}

const formatMajor = (minor: number): string => (minor / 100).toFixed(2);

async function readJson(res: Response, context: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    logger.error({ status: res.status, body: text.slice(0, 300) }, `${context}: non-JSON response`);
    throw new HttpError(502, 'payment_provider_error', 'Payment provider returned an invalid response');
  }
}

export class PaymentService {
  private readonly stripe: Stripe | null;

  constructor(private readonly redis: Redis) {
    this.stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;
  }

  isConfigured(provider: PaymentProvider): boolean {
    switch (provider) {
      case 'stripe':
        return this.stripe !== null;
      case 'bkash':
        return Boolean(env.BKASH_APP_KEY && env.BKASH_APP_SECRET && env.BKASH_USERNAME && env.BKASH_PASSWORD);
      case 'sslcommerz':
        return Boolean(env.SSLCOMMERZ_STORE_ID && env.SSLCOMMERZ_STORE_PASSWORD);
    }
  }

  assertUsable(provider: PaymentProvider, currency: Currency): void {
    if (!this.isConfigured(provider)) {
      throw new HttpError(503, 'payment_unavailable', `${provider} is not configured on this server`);
    }
    if (!SUPPORTED_CURRENCIES[provider].includes(currency)) {
      throw new HttpError(422, 'unsupported_currency', `${provider} cannot process ${currency} orders`);
    }
  }

  async init(order: OrderRecord, items: OrderItemRecord[], customer: CustomerInfo, provider: PaymentProvider): Promise<PaymentInit> {
    this.assertUsable(provider, order.currency);
    switch (provider) {
      case 'stripe':
        return this.createStripeCheckout(order, items, customer.email);
      case 'bkash':
        return this.createBkashPayment(order);
      case 'sslcommerz':
        return this.createSslCommerzSession(order, items, customer);
    }
  }

  /* ----------------------------- Stripe ----------------------------- */

  private async createStripeCheckout(order: OrderRecord, items: OrderItemRecord[], email: string): Promise<PaymentInit> {
    const stripe = this.stripe as Stripe;
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = items.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency: order.currency.toLowerCase(),
        unit_amount: item.unit_price_minor,
        product_data: { name: item.title },
      },
    }));
    if (order.shipping_minor > 0) {
      lineItems.push({
        quantity: 1,
        price_data: { currency: order.currency.toLowerCase(), unit_amount: order.shipping_minor, product_data: { name: 'Shipping' } },
      });
    }
    try {
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          client_reference_id: order.id,
          customer_email: email || undefined,
          line_items: lineItems,
          metadata: { order_id: order.id },
          payment_intent_data: { metadata: { order_id: order.id } },
          success_url: `${env.FRONTEND_URL}/marketplace?order=${order.id}&status=success`,
          cancel_url: `${env.FRONTEND_URL}/marketplace?order=${order.id}&status=cancelled`,
        },
        { idempotencyKey: `checkout:${order.id}` },
      );
      if (!session.url) throw new Error('Stripe returned no checkout URL');
      return { provider: 'stripe', redirectUrl: session.url, reference: session.id };
    } catch (err) {
      logger.error({ err, orderId: order.id }, 'Stripe checkout creation failed');
      throw new HttpError(502, 'payment_provider_error', 'Could not start the card payment');
    }
  }

  verifyStripeEvent(rawBody: Buffer, signature: string | undefined): Stripe.Event {
    if (!this.stripe || !env.STRIPE_WEBHOOK_SECRET) {
      throw new HttpError(503, 'payment_unavailable', 'Stripe webhooks are not configured');
    }
    if (!signature) throw new HttpError(400, 'invalid_signature', 'Missing Stripe signature');
    try {
      return this.stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw new HttpError(400, 'invalid_signature', 'Stripe signature verification failed');
    }
  }

  /* ------------------------------ bKash ----------------------------- */

  private async bkashToken(): Promise<string> {
    const cacheKey = 'bkash:id_token';
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const res = await fetch(`${env.BKASH_BASE_URL}/tokenized/checkout/token/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        username: env.BKASH_USERNAME ?? '',
        password: env.BKASH_PASSWORD ?? '',
      },
      body: JSON.stringify({ app_key: env.BKASH_APP_KEY, app_secret: env.BKASH_APP_SECRET }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readJson(res, 'bkash grant token');
    const token = body.id_token;
    if (typeof token !== 'string') {
      logger.error({ body }, 'bKash token grant failed');
      throw new HttpError(502, 'payment_provider_error', 'Could not authenticate with bKash');
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    await this.redis.set(cacheKey, token, 'EX', Math.max(60, expiresIn - 120));
    return token;
  }

  private async bkashHeaders(): Promise<Record<string, string>> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: await this.bkashToken(),
      'X-APP-Key': env.BKASH_APP_KEY ?? '',
    };
  }

  private async createBkashPayment(order: OrderRecord): Promise<PaymentInit> {
    const res = await fetch(`${env.BKASH_BASE_URL}/tokenized/checkout/create`, {
      method: 'POST',
      headers: await this.bkashHeaders(),
      body: JSON.stringify({
        mode: '0011',
        payerReference: order.user_id.slice(0, 20),
        callbackURL: `${env.PUBLIC_API_URL}/api/v1/shop/payments/bkash/callback`,
        amount: formatMajor(order.total_minor),
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: order.id.replace(/-/g, '').slice(0, 30),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await readJson(res, 'bkash create payment');
    if (typeof body.paymentID !== 'string' || typeof body.bkashURL !== 'string') {
      logger.error({ body, orderId: order.id }, 'bKash create payment failed');
      throw new HttpError(502, 'payment_provider_error', 'Could not start the bKash payment');
    }
    return { provider: 'bkash', redirectUrl: body.bkashURL, reference: body.paymentID };
  }

  /** Executes a bKash payment after the customer approved it. */
  async executeBkashPayment(paymentId: string): Promise<{ completed: boolean; trxId?: string; amount?: string }> {
    const res = await fetch(`${env.BKASH_BASE_URL}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: await this.bkashHeaders(),
      body: JSON.stringify({ paymentID: paymentId }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await readJson(res, 'bkash execute');
    if (body.transactionStatus === 'Completed' && typeof body.trxID === 'string') {
      return { completed: true, trxId: body.trxID, amount: typeof body.amount === 'string' ? body.amount : undefined };
    }
    // Execute is not idempotent; if it was already executed, query the payment status instead.
    const status = await fetch(`${env.BKASH_BASE_URL}/tokenized/checkout/payment/status`, {
      method: 'POST',
      headers: await this.bkashHeaders(),
      body: JSON.stringify({ paymentID: paymentId }),
      signal: AbortSignal.timeout(20_000),
    });
    const statusBody = await readJson(status, 'bkash status');
    if (statusBody.transactionStatus === 'Completed' && typeof statusBody.trxID === 'string') {
      return { completed: true, trxId: statusBody.trxID, amount: typeof statusBody.amount === 'string' ? statusBody.amount : undefined };
    }
    logger.warn({ paymentId, body }, 'bKash payment not completed');
    return { completed: false };
  }

  /* --------------------------- SSLCommerz --------------------------- */

  private sslBase(): string {
    return env.SSLCOMMERZ_IS_LIVE ? 'https://securepay.sslcommerz.com' : 'https://sandbox.sslcommerz.com';
  }

  /** SSLCommerz transaction ids are limited to 30 characters. */
  static tranIdFor(orderId: string): string {
    return orderId.replace(/-/g, '').slice(0, 30);
  }

  private async createSslCommerzSession(order: OrderRecord, items: OrderItemRecord[], customer: CustomerInfo): Promise<PaymentInit> {
    const callback = `${env.PUBLIC_API_URL}/api/v1/shop/payments/sslcommerz`;
    const tranId = PaymentService.tranIdFor(order.id);
    const form = new URLSearchParams({
      store_id: env.SSLCOMMERZ_STORE_ID ?? '',
      store_passwd: env.SSLCOMMERZ_STORE_PASSWORD ?? '',
      total_amount: formatMajor(order.total_minor),
      currency: order.currency,
      tran_id: tranId,
      success_url: `${callback}/success`,
      fail_url: `${callback}/fail`,
      cancel_url: `${callback}/cancel`,
      ipn_url: `${callback}/ipn`,
      shipping_method: 'Courier',
      product_name: items.map((i) => i.title).join(', ').slice(0, 250) || 'Uninet order',
      product_category: 'general',
      product_profile: 'physical-goods',
      num_of_item: String(items.reduce((n, i) => n + i.quantity, 0)),
      cus_name: customer.name,
      cus_email: customer.email || 'noreply@uninet.app',
      cus_add1: customer.address,
      cus_city: customer.city,
      cus_postcode: customer.postcode || '0000',
      cus_country: customer.country,
      cus_phone: customer.phone,
      ship_name: customer.name,
      ship_add1: customer.address,
      ship_city: customer.city,
      ship_postcode: customer.postcode || '0000',
      ship_country: customer.country,
      value_a: order.id,
    });
    const res = await fetch(`${this.sslBase()}/gwprocess/v4/api.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const body = await readJson(res, 'sslcommerz init');
    if (body.status !== 'SUCCESS' || typeof body.GatewayPageURL !== 'string' || body.GatewayPageURL === '') {
      logger.error({ body, orderId: order.id }, 'SSLCommerz session creation failed');
      throw new HttpError(502, 'payment_provider_error', 'Could not start the SSLCommerz payment');
    }
    return { provider: 'sslcommerz', redirectUrl: body.GatewayPageURL, reference: tranId };
  }

  /** Server-to-server validation of a val_id received on the success/IPN callbacks. */
  async validateSslCommerz(valId: string): Promise<{ valid: boolean; tranId?: string; amount?: string; currency?: string; bankTranId?: string }> {
    const url = new URL(`${this.sslBase()}/validator/api/validationserverAPI.php`);
    url.searchParams.set('val_id', valId);
    url.searchParams.set('store_id', env.SSLCOMMERZ_STORE_ID ?? '');
    url.searchParams.set('store_passwd', env.SSLCOMMERZ_STORE_PASSWORD ?? '');
    url.searchParams.set('format', 'json');
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = await readJson(res, 'sslcommerz validate');
    const valid = body.status === 'VALID' || body.status === 'VALIDATED';
    return {
      valid,
      tranId: typeof body.tran_id === 'string' ? body.tran_id : undefined,
      amount: typeof body.currency_amount === 'string' ? body.currency_amount : typeof body.amount === 'string' ? body.amount : undefined,
      currency: typeof body.currency_type === 'string' ? body.currency_type : undefined,
      bankTranId: typeof body.bank_tran_id === 'string' ? body.bank_tran_id : undefined,
    };
  }
}
