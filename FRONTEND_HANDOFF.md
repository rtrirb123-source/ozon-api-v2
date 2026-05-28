# Frontend Handoff

Use the v2 API instead of the Feishu-backed API.

## Data Source

```text
GET /api/dashboard
```

Products:

```text
data.products
```

Summary:

```text
data.summary.productCount
data.summary.missingImageCount
data.summary.missingCompetitorCount
data.summary.missingPriceCount
data.summary.missingCommissionCount
```

## Create Product

```http
POST /api/products
Content-Type: application/json

{
  "offer_id": "manshiwan",
  "product_id": "3649799379",
  "price": 620
}
```

## Edit Product

Use `PATCH`, not whole-row overwrite.

```http
PATCH /api/products/{offer_id}
Content-Type: application/json

{
  "competitor_compare": "new text"
}
```

For the transition period, these old endpoints also exist:

```text
GET  /products
POST /products
```

But new code should use `/api/products` and `PATCH /api/products/{offer_id}`.

## Input UX

- Input values must bind to local draft state for immediate display.
- Save on blur or with 500-800ms debounce.
- Do not refresh `/api/dashboard` on every keystroke.
- When the PATCH response returns, merge the returned product only if the user
  has not continued editing that same field.

Recommended fields:

```text
offer_id
product_id
title
image_url
strategy
commission_rate
purchase_cost
weight
freight_rate
return_rate
ad_ratio
price
competitor_compare
```
