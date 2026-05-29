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
