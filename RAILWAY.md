# Railway Setup

## New Project

Recommended: deploy v2 as a separate Railway service first.

Example domain:

```text
ozon-api-v2-production.up.railway.app
```

Keep the current Feishu-backed API running until the frontend is switched.

## Steps

1. Create or select a Railway project.
2. Add PostgreSQL.
3. Create a new service from the v2 GitHub repo/folder.
4. Set environment variable:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
ALLOWED_ORIGINS=*
AUTO_MIGRATE=true
```

5. Deploy.
6. Schema migration runs automatically when `AUTO_MIGRATE=true`. You can also run:

```text
npm run migrate
```

7. Test:

```text
/health
/api/products
/api/dashboard
```

## Cutover

After v2 is verified:

1. Ask the Miaoda frontend agent to switch data source to `/api/dashboard`.
2. Ask it to switch saves to `PATCH /api/products/:offer_id`.
3. Test commission, price, image, and competitor compare.
4. Keep the old API as backup for one day.
