# Ozon API v2

PostgreSQL-backed Ozon dashboard API. This version does not use Feishu for
real-time storage.

## Architecture

```text
Miaoda frontend -> Railway API -> Railway PostgreSQL
```

Feishu can still be used later for import/export, but it is no longer the live
database.

## Deploy On Railway

1. Create a new Railway service from this folder or a GitHub repo containing it.
2. Add Railway PostgreSQL to the project.
3. Set `DATABASE_URL` from the PostgreSQL plugin.
4. Deploy the API.
5. By default the API runs the schema migration on startup. You can also run it manually:

```bash
npm run migrate
```

6. Open:

```text
/health
/api/dashboard
```

## Environment

```text
PORT=3000
DATABASE_URL=postgresql://...
ALLOWED_ORIGINS=*
```

Railway provides `PORT`; PostgreSQL provides `DATABASE_URL`.

## API

```text
GET    /health
GET    /api/dashboard
GET    /api/products
POST   /api/products
POST   /api/import/products
GET    /api/products/:offer_id
PATCH  /api/products/:offer_id
DELETE /api/products/:offer_id
```

Legacy compatibility endpoints are also available:

```text
GET  /products
POST /products
```

## Product Fields

```json
{
  "offer_id": "manshiwan",
  "product_id": "3649799379",
  "title": "",
  "image_url": "https://...",
  "strategy": "",
  "commission_rate": 39,
  "purchase_cost": 8.55,
  "weight": 116,
  "freight_rate": 3,
  "return_rate": null,
  "ad_ratio": 0,
  "price": 620,
  "competitor_compare": ""
}
```

## Partial Update

Update only one field without touching the rest:

```http
PATCH /api/products/manshiwan
Content-Type: application/json

{
  "commission_rate": 39
}
```

Image update:

```http
PATCH /api/products/manshiwan
Content-Type: application/json

{
  "image_url": "https://example.com/image.jpg"
}
```

The response returns the latest saved product.

## Compatibility

The API accepts old frontend aliases such as:

- `commission`, `commissionRate`, `佣金`, `佣金率`
- `price`, `salePrice`, `售价`, `价格`
- `imageUrl`, `mainImage`, `商品图片`, `图片`, `主图`
- `competitorCompare`, `竞品对比`

Internally everything is stored in fixed PostgreSQL columns.

## Import From Old API

Fetch the old dashboard response and post `data.products` to:

```text
POST /api/import/products
```

Example body:

```json
{
  "products": [
    {
      "offer_id": "manshiwan",
      "product_id": "3649799379",
      "price": 620
    }
  ]
}
```
