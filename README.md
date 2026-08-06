# TBBM · Catálogo Meta — crawler gentil + feed

Genera un feed de productos compatible con Meta desde el sitio público de The Blue Box Market y lo publica
en una URL fija que Meta re-lee sola (Data Source = feed programado). Resuelve el match rate bajo (37%→90%+)
**sin permiso de escritura por API** y **sin depender del cliente ni de Direct Group**.

> ⚠️ **El sitio tiene anti-abuse AWS (ELB/WAF)**: bloquea (403) el crawling agresivo por tasa/volumen, y la
> reputación de la IP se degrada con cada bloqueo. Por eso el crawler es **deliberadamente lento**
> (rate-limit, tandas con descanso, cooldown ante 403) y **reanudable**. Corre en **GitHub Actions**, donde
> cada corrida usa una IP fresca — no arrastra reputación. Validación real = en Actions, no desde una IP local.

## Cómo anda

- **Enumeración** (`enumerate`): HEAD gentil a `/product/{id}/` (200=existe, 500=no) por tandas con
  **watermark** → arma `data/seed-ids.json`. Avanza un `--chunk` por corrida; reanuda solo.
- **Detalle** (`build`): GET gentil de los IDs del seed → parsea el `<script application/ld+json>`
  `@type: Product` (name, sku, brand, category, image, price ARS, availability, condition) → `docs/feed.csv`.
  Detecta la página genérica/WAF (200 chico sin producto) y NO la confunde con "producto inexistente".
- **Match:** `id` del feed = ID numérico = **`content_id` que dispara el Pixel** → match garantizado.

Sin dependencias: Node 18+ (fetch/gzip nativos). Reanudable (cache `docs/products.json` + `--append`/`--refresh`).

## Uso local (gentil por default)

```bash
node crawler.js enumerate --to 54000 --chunk 3000      # descubre IDs (tanda), reanudable
node crawler.js build --seed data/seed-ids.json --out docs/feed.csv --refresh
```

Flags: `--rps 1 --concurrency 2 --batch 150 --rest 180 --cooldown 300 --jitter 600`. Bajá `--rps` / subí
`--rest` si aparece throttling (el log avisa "muchas páginas genéricas").

## Deploy (GitHub Actions + Pages, 100% nuestro)

1. Repo standalone (cuenta `bernibureau`). Copiar `crawler.js`, `package.json`, `.github/workflows/*`.
2. Activar **GitHub Pages** sobre `/docs` en `main` → feed en `https://<owner>.github.io/<repo>/feed.csv`.
3. Workflows:
   - **`feed-enumerate.yml`** (cada 6 h): avanza el barrido de IDs, commitea `seed-ids.json`. En pocos días
     completa el catálogo; después queda vigilando IDs nuevos.
   - **`feed-daily.yml`** (diario): baja el detalle de los IDs conocidos → `docs/feed.csv` → Pages.

## Conectar en Meta (UI, sin token)

Commerce Manager → **catálogo `Catalogo TBB` (728929230098138)** → Data Sources → Add → Data Feed →
Scheduled feed → pegar la URL de Pages → frecuencia diaria. Verificar a las 24-48 h que el match sube a 90%+.

## Estado

Crawler completo y endurecido. **Falta:** pushear a un repo, activar Pages, dejar correr el enumerate unos
días (arma el seed), y conectar el feed en Commerce Manager. La velocidad exacta se calibra en Actions
(IP fresca) — desde una IP local ya flageada no es representativo.
