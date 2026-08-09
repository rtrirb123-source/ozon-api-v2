CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  offer_id TEXT NOT NULL UNIQUE,
  product_id TEXT,
  ozon_sku TEXT,
  description_category_id TEXT,
  type_id TEXT,
  category_name TEXT,
  type_name TEXT,
  title TEXT,
  image_url TEXT,
  fbo_stock NUMERIC,
  fbs_stock NUMERIC,
  yesterday_sales NUMERIC,
  strategy TEXT,
  commission_rate NUMERIC,
  purchase_cost NUMERIC,
  weight NUMERIC,
  freight_rate NUMERIC,
  tail_delivery_rate NUMERIC DEFAULT 10,
  return_rate NUMERIC,
  ad_ratio NUMERIC,
  price NUMERIC,
  competitor_compare TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE products
ADD COLUMN IF NOT EXISTS ozon_sku TEXT;

ALTER TABLE products
ADD COLUMN IF NOT EXISTS tail_delivery_rate NUMERIC DEFAULT 10;

ALTER TABLE products
ADD COLUMN IF NOT EXISTS description_category_id TEXT;

ALTER TABLE products
ADD COLUMN IF NOT EXISTS type_id TEXT;

ALTER TABLE products
ADD COLUMN IF NOT EXISTS category_name TEXT;

ALTER TABLE products
ADD COLUMN IF NOT EXISTS type_name TEXT;

ALTER TABLE products
ADD COLUMN IF NOT EXISTS fbo_stock NUMERIC;

ALTER TABLE products
ADD COLUMN IF NOT EXISTS fbs_stock NUMERIC;

ALTER TABLE products
ADD COLUMN IF NOT EXISTS yesterday_sales NUMERIC;

ALTER TABLE products ADD COLUMN IF NOT EXISTS front_price NUMERIC;
ALTER TABLE products ADD COLUMN IF NOT EXISTS front_price_source TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS front_price_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS products_updated_at_idx ON products (updated_at DESC);
CREATE INDEX IF NOT EXISTS products_product_id_idx ON products (product_id);
CREATE INDEX IF NOT EXISTS products_ozon_sku_idx ON products (ozon_sku);

CREATE TABLE IF NOT EXISTS product_daily_metrics (
  id BIGSERIAL PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES products (offer_id) ON DELETE CASCADE,
  metric_date DATE NOT NULL,
  sales_units NUMERIC,
  ad_ratio NUMERIC,
  ad_spend NUMERIC,
  revenue NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (offer_id, metric_date)
);

CREATE INDEX IF NOT EXISTS product_daily_metrics_offer_date_idx
ON product_daily_metrics (offer_id, metric_date DESC);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_set_updated_at ON products;
CREATE TRIGGER products_set_updated_at
BEFORE UPDATE ON products
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS product_daily_metrics_set_updated_at ON product_daily_metrics;
CREATE TRIGGER product_daily_metrics_set_updated_at
BEFORE UPDATE ON product_daily_metrics
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS wb_products (
  id BIGSERIAL PRIMARY KEY,
  nm_id TEXT NOT NULL UNIQUE,
  vendor_code TEXT,
  title TEXT,
  brand TEXT,
  subject_name TEXT,
  image_url TEXT,
  stock NUMERIC,
  yesterday_sales NUMERIC,
  price NUMERIC,
  purchase_cost NUMERIC,
  ad_ratio NUMERIC,
  tail_delivery_rate NUMERIC DEFAULT 14,
  competitor_compare TEXT,
  strategy TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wb_products_updated_at_idx ON wb_products (updated_at DESC);
CREATE INDEX IF NOT EXISTS wb_products_vendor_code_idx ON wb_products (vendor_code);

CREATE TABLE IF NOT EXISTS wb_daily_metrics (
  id BIGSERIAL PRIMARY KEY,
  nm_id TEXT NOT NULL REFERENCES wb_products (nm_id) ON DELETE CASCADE,
  metric_date DATE NOT NULL,
  sales_units NUMERIC,
  revenue NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (nm_id, metric_date)
);

CREATE INDEX IF NOT EXISTS wb_daily_metrics_product_date_idx
ON wb_daily_metrics (nm_id, metric_date DESC);

DROP TRIGGER IF EXISTS wb_products_set_updated_at ON wb_products;
CREATE TRIGGER wb_products_set_updated_at
BEFORE UPDATE ON wb_products
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS wb_daily_metrics_set_updated_at ON wb_daily_metrics;
CREATE TRIGGER wb_daily_metrics_set_updated_at
BEFORE UPDATE ON wb_daily_metrics
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


CREATE TABLE IF NOT EXISTS product_strategy_history (
  id BIGSERIAL PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES products (offer_id) ON DELETE CASCADE,
  strategy TEXT,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS product_strategy_history_offer_saved_idx
ON product_strategy_history (offer_id, saved_at DESC);


ALTER TABLE wb_products
ADD COLUMN IF NOT EXISTS weight NUMERIC,
ADD COLUMN IF NOT EXISTS freight_rate NUMERIC,
ADD COLUMN IF NOT EXISTS tail_delivery_rate NUMERIC DEFAULT 14,
ADD COLUMN IF NOT EXISTS shipping_cost NUMERIC,
ADD COLUMN IF NOT EXISTS fbs_stock NUMERIC,
ADD COLUMN IF NOT EXISTS fbw_stock NUMERIC,
ADD COLUMN IF NOT EXISTS commission_rate NUMERIC,
ADD COLUMN IF NOT EXISTS return_rate NUMERIC;

CREATE TABLE IF NOT EXISTS wb_product_mappings (
  id BIGSERIAL PRIMARY KEY,
  wb_nm_id TEXT NOT NULL REFERENCES wb_products (nm_id) ON DELETE CASCADE,
  wb_cross_nm_id TEXT NOT NULL REFERENCES wb_cross_products (nm_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wb_nm_id, wb_cross_nm_id)
);

CREATE INDEX IF NOT EXISTS wb_product_mappings_local_idx
ON wb_product_mappings (wb_nm_id);

CREATE INDEX IF NOT EXISTS wb_product_mappings_cross_idx
ON wb_product_mappings (wb_cross_nm_id);

CREATE INDEX IF NOT EXISTS wb_product_mappings_updated_at_idx
ON wb_product_mappings (updated_at DESC);


ALTER TABLE wb_cross_products
ADD COLUMN IF NOT EXISTS shipping_cost NUMERIC,
ADD COLUMN IF NOT EXISTS tail_delivery_rate NUMERIC DEFAULT 20;

CREATE TABLE IF NOT EXISTS seerfar_competitors (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'OZON',
  sku TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'seerfar',
  title TEXT,
  image_url TEXT,
  brand TEXT,
  seller_name TEXT,
  category_name TEXT,
  price NUMERIC,
  sales_30d NUMERIC,
  revenue_30d NUMERIC,
  daily_avg_sales NUMERIC,
  stock NUMERIC,
  rating NUMERIC,
  review_count NUMERIC,
  exposure NUMERIC,
  card_views NUMERIC,
  cart_rate NUMERIC,
  order_conversion_rate NUMERIC,
  ad_share NUMERIC,
  return_cancel_rate NUMERIC,
  gross_margin NUMERIC,
  raw_json JSONB,
  fetched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, sku)
);

CREATE INDEX IF NOT EXISTS seerfar_competitors_platform_sku_idx
ON seerfar_competitors (platform, sku);

CREATE TABLE IF NOT EXISTS product_competitor_links (
  id BIGSERIAL PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES products (offer_id) ON DELETE CASCADE,
  competitor_id BIGINT NOT NULL REFERENCES seerfar_competitors (id) ON DELETE CASCADE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (offer_id, competitor_id)
);

CREATE INDEX IF NOT EXISTS product_competitor_links_offer_idx
ON product_competitor_links (offer_id);

DROP TRIGGER IF EXISTS seerfar_competitors_set_updated_at ON seerfar_competitors;
CREATE TRIGGER seerfar_competitors_set_updated_at
BEFORE UPDATE ON seerfar_competitors
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS product_competitor_links_set_updated_at ON product_competitor_links;
CREATE TRIGGER product_competitor_links_set_updated_at
BEFORE UPDATE ON product_competitor_links
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
