# Catálogo → Feed para Meta (Data Feed programado)

Genera un feed de productos compatible con **Meta Commerce Manager** desde un sitio de e-commerce público
y lo publica en una URL fija (GitHub Pages) que Meta re-lee de forma programada. Sin permisos de escritura
por API: el alta se hace como *Data Feed* desde la UI de Commerce Manager.

## Cómo funciona

- **`enumerate`** — descubre IDs de producto existentes por barrido `HEAD` gentil a `/product/{id}/`
  (200 = existe, 500 = no), por tandas con **watermark** → `data/seed-ids.json`. Reanudable.
- **`build`** — baja el detalle (`GET`) de cada ID y parsea el `<script application/ld+json>` `@type: Product`
  (nombre, sku, marca, categoría, imagen, precio, disponibilidad) → `docs/feed.csv`. Detecta la página
  genérica (200 sin JSON-LD) y no la confunde con "producto inexistente".
- **Match** — el `id` del feed = ID numérico del producto = `content_id` del pixel → match garantizado.

Sin dependencias (Node 18+, `fetch`/`gzip` nativos). Reanudable (cache `docs/products.json` + `--append`/`--refresh`).

## Seed inicial

El seed puede sembrarse con los IDs reales de un catálogo existente (se lee el catálogo y de cada `url`
`/product/{id}` se extrae el ID numérico) → el `build` arma el feed completo sin depender del barrido; el
`enumerate` queda de fondo para descubrir IDs nuevos.

## Uso

```bash
node crawler.js enumerate --to 54000 --chunk 3000        # descubre IDs (tanda), reanudable
node crawler.js build --seed data/seed-ids.json --out docs/feed.csv --refresh
```

Flags: `--rps 1 --concurrency 2 --batch 150 --rest 180 --cooldown 300 --jitter 600`. El crawler es
deliberadamente lento y reanudable: rate-limit global, tandas con descanso, y cooldown ante `403`
(el sitio puede tener anti-abuse por tasa/volumen).

## Deploy

GitHub Actions (cron) corre `enumerate` (cada 6 h) y `build` (diario); **GitHub Pages** sirve `/docs`.
El feed queda en `https://<owner>.github.io/<repo>/feed.csv` → conectar como *Scheduled feed* en
Commerce Manager → Data Sources → Data Feed.
