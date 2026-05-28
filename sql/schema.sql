CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  offer_id TEXT NOT NULL UNIQUE,
  product_id TEXT,
  title TEXT,
  image_url TEXT,
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

CREATE INDEX IF NOT EXISTS products_updated_at_idx ON products (updated_at DESC);
CREATE INDEX IF NOT EXISTS products_product_id_idx ON products (product_id);

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
