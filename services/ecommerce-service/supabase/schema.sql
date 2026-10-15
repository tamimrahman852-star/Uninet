-- Uninet ecommerce-service schema. Run in the Supabase SQL editor.
-- All writes go through the service (service-role key); RLS only exposes safe reads to clients.

create table if not exists public.categories (
  id    uuid primary key default gen_random_uuid(),
  name  text not null unique,
  slug  text not null unique
);

create table if not exists public.products (
  id             uuid primary key default gen_random_uuid(),
  seller_id      uuid not null references auth.users (id) on delete cascade,
  category_id    uuid references public.categories (id) on delete set null,
  title          text not null check (char_length(title) between 2 and 200),
  description    text not null default '',
  price_minor    integer not null check (price_minor >= 0),          -- smallest currency unit (poisha / cents)
  currency       text not null default 'BDT' check (currency in ('BDT', 'USD')),
  stock          integer not null default 0 check (stock >= 0),
  images         text[] not null default '{}',
  attributes     jsonb not null default '{}'::jsonb,
  status         text not null default 'active' check (status in ('active', 'draft', 'archived')),
  rating_avg     numeric(3, 2) not null default 0,
  rating_count   integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  search         tsvector generated always as (
                   to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))
                 ) stored
);

create index if not exists products_search_idx on public.products using gin (search);
create index if not exists products_category_idx on public.products (category_id) where status = 'active';
create index if not exists products_seller_idx on public.products (seller_id);
create index if not exists products_created_idx on public.products (created_at desc) where status = 'active';

create table if not exists public.orders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete restrict,
  status            text not null default 'pending'
                      check (status in ('pending', 'paid', 'cancelled', 'expired', 'shipped', 'delivered', 'refunded')),
  currency          text not null check (currency in ('BDT', 'USD')),
  subtotal_minor    integer not null check (subtotal_minor >= 0),
  shipping_minor    integer not null default 0 check (shipping_minor >= 0),
  total_minor       integer not null check (total_minor >= 0),
  payment_provider  text check (payment_provider in ('stripe', 'bkash', 'sslcommerz')),
  payment_ref       text,
  transaction_id    text,
  shipping_address  jsonb not null,
  expires_at        timestamptz not null,
  paid_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists orders_user_idx on public.orders (user_id, created_at desc);
create index if not exists orders_payment_ref_idx on public.orders (payment_ref) where payment_ref is not null;
create index if not exists orders_pending_expiry_idx on public.orders (expires_at) where status = 'pending';

create table if not exists public.order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.orders (id) on delete cascade,
  product_id        uuid not null references public.products (id) on delete restrict,
  title             text not null,
  unit_price_minor  integer not null check (unit_price_minor >= 0),
  quantity          integer not null check (quantity > 0)
);

create index if not exists order_items_order_idx on public.order_items (order_id);

-- Atomically commits stock and marks an order paid. Idempotent.
-- Returns: 'paid' | 'already_paid' | 'insufficient_stock' | 'invalid_state' | 'not_found'
create or replace function public.confirm_order(p_order_id uuid, p_provider text, p_payment_ref text, p_transaction_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_item  record;
  v_rows  integer;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_order.status = 'paid' then
    return 'already_paid';
  end if;
  if v_order.status not in ('pending', 'expired') then
    return 'invalid_state';
  end if;

  for v_item in select product_id, quantity from public.order_items where order_id = p_order_id loop
    update public.products
       set stock = stock - v_item.quantity, updated_at = now()
     where id = v_item.product_id and stock >= v_item.quantity;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'insufficient_stock' using errcode = 'P0001';
    end if;
  end loop;

  update public.orders
     set status = 'paid', paid_at = now(), updated_at = now(),
         payment_provider = coalesce(p_provider, payment_provider),
         payment_ref = coalesce(p_payment_ref, payment_ref),
         transaction_id = p_transaction_id
   where id = p_order_id;
  return 'paid';
exception
  when sqlstate 'P0001' then
    -- Roll back stock changes of this call; the caller decides how to handle the (paid but unfulfillable) order.
    return 'insufficient_stock';
end;
$$;

revoke all on function public.confirm_order(uuid, text, text, text) from public, anon, authenticated;

alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

drop policy if exists "categories are public" on public.categories;
create policy "categories are public" on public.categories for select using (true);

drop policy if exists "active products are public" on public.products;
create policy "active products are public" on public.products for select using (status = 'active');

drop policy if exists "users read own orders" on public.orders;
create policy "users read own orders" on public.orders for select to authenticated using (auth.uid() = user_id);

drop policy if exists "users read own order items" on public.order_items;
create policy "users read own order items" on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid()));
