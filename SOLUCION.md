# Catálogo Meta TBBM — Solución vía feed hosteado y auto-actualizable

**Objetivo:** llevar el catálogo de Meta de The Blue Box Market a 90%+ de match rate y mantenerlo
actualizado solo, **sin depender de Direct Group ni del cliente, y sin necesitar permiso de escritura
por API**. Todo lo resuelve la agencia.

## Idea en una línea

Un feed (archivo) con todos los productos vive en **una URL fija nuestra**, un **cron lo regenera cada
día** con precio/stock frescos, y **Meta lo re-lee solo** (feed programado). Cero intervención manual una
vez montado.

```
   Sitio TBBM (público)                 Nuestro servicio (cron)                 Meta
 ┌──────────────────────┐        ┌───────────────────────────────┐      ┌────────────────────┐
 │ RASTREO PROFUNDO:    │        │ 1. enumera TODOS los productos │      │ Commerce Manager    │
 │  categorías+paginado │  ───►  │ 2. por cada producto saca      │      │  Data Source =      │
 │  / products-service  │        │    título/precio/stock/img/marca│ ──► │  "Feed programado"  │
 │  (ajaxGetPorto)      │        │ 3. arma feed CSV Meta-compliant │      │  apuntando a la URL │
 └──────────────────────┘        │    (id = ID numérico = content) │      │  refresco diario    │
                                 │ 4. publica en URL fija          │      └─────────┬──────────┘
                                 └───────────────────────────────┘                │
                                     ▲ corre solo cada 24 h                        ▼
                                                                        Catálogo al 90%+ →
                                                                        anuncios dinámicos OK
```

> **Nota de enumeración:** el `sitemap.xml` está **incompleto** (lista ~500 URLs cuando el sitio tiene
> ~3.9K+ productos). NO se usa como fuente de verdad. La lista de productos se arma con un **rastreo
> profundo** de todo el sitio (ver Fase 0/1).

---

## ✅ Spike validado (5-ago-2026) — el método confirmado

Probado end-to-end contra el sitio real. Conclusiones firmes:

- **Extracción por producto = JSON-LD.** Cada página `/product/{id}/` trae un `<script application/ld+json>`
  `@type: Product` con **todo lo que Meta necesita**: `name`, `sku`, `brand`, `category`, `image`, `url`,
  y `offers` con `price` + `priceCurrency` (ARS) + `availability` + `itemCondition`. **No hace falta
  Playwright** — se parsea del HTML con curl. (El `product-quick-view.php` NO sirve para precio: mostró un
  valor distinto al del JSON-LD.)
- **Enumeración completa = barrido por ID.** La URL resuelve **solo con el ID + slash** (`/product/40128/`
  = 200; el slug se ignora). **`200` = producto existe, `500` = no existe.** Los IDs son numéricos y van de
  ~2 hasta ~53.000. Un barrido del rango encuentra **todos** los productos, sin depender del sitemap
  (incompleto) ni de las categorías (grilla por **sesión** + paginación por cursor `cargarMas.php?ultimoId`,
  frágil de replicar). El barrido es la fuente de verdad; el crawl por categoría y el sitemap quedan como
  complemento/checksum.
- **El match está garantizado:** `id` del feed = ID numérico de la URL = **`content_id` que dispara el
  Pixel**. Eso arregla las dos causas del match rate bajo (productos faltantes **y** items con `retailer_id`
  tipo hash `0dqq92j8f6` que no matchean).
- **Prueba tangible:** se generaron filas de feed válidas para los mismos productos que el Pixel reporta
  como *unmatched* (Freezer 45514, TV 40128, Notebook 51801, Heladera 51372…) con id/title/price/stock/
  brand/image/link correctos. Muestra en `muestra-feed.csv`.
- **Carga:** cada página pesa ~1-2 MB (gzip ~150 KB-1,3 MB). → refresco **diario solo de las categorías a
  pautar** + **full semanal**, siempre con `--compressed`. Normalizar `image_link` a `https` (algunas vienen
  en `http`). El precio del JSON-LD se verifica contra la página en el QA (política de Meta: feed = landing).
- **Acceso de lectura a Meta = parcial:** se lee `Catalogo TBB` (728929230098138) básico, pero el *filtro* y
  otros catálogos dan `Permissions error`. **No bloquea el fix** (el feed reemplaza el catálogo). Para el
  diagnóstico conviene confirmar a qué catálogo hay lectura y cuál es el target de la pauta.

**Clave del match:** cada producto se carga con `id` (retailer_id) = **el ID numérico de la URL**
(46051, 45514, 40128…), que es exactamente el `content_id` que dispara el Pixel. Eso arregla las **dos**
causas del match rate bajo que ya detectamos: productos faltantes **y** items cargados con un hash
(ej. `0dqq92j8f6`) que nunca matchea.

---

## Paso a paso

### Fase 0 — Validación (read-only, sin ningún permiso nuevo)
1. **Enumerar el catálogo actual** con nuestro acceso de lectura → sacar todos los `retailer_id` que ya
   tiene (esto ya lo puedo hacer hoy).
2. **Método de rastreo profundo — CONFIRMADO:** barrido por rango de IDs (`/product/{id}/`, 200=existe /
   500=no) para el universo completo, + parseo del JSON-LD de cada producto para el detalle. El crawl por
   categoría (sesión + `cargarMas`) y el sitemap quedan como complemento/checksum. (Ver "Spike validado".)
3. **Prueba de match:** sacar 5-10 productos del sitio, cruzarlos contra los `content_id` del Pixel y
   confirmar que con `id` = ID numérico matchean.
4. **Gap analysis:** lista exacta de *qué falta en el catálogo* + *qué está cargado con ID mal*.

### Fase 1 — Generador de feed
5. Script (Node) que:
   - **Enumera el universo completo** por rastreo profundo (método de Fase 0.2): todos los productos del
     sitio, no solo los del sitemap.
   - Por cada producto obtiene: `title`, `description`, `price` (ARS), `availability` (in stock / out of
     stock), `condition` (new), `image_link`, `brand`, `link` (URL del producto).
   - Arma un **feed CSV/XML compatible con Meta** con el campo `id` = ID numérico (= `content_id`).
   - **Robustez del crawl:** reintentos, rate-limit amable, y control de que el total rastreado sea
     coherente con el conteo del sitio (que no se corte a la mitad y suba un feed incompleto).
6. Campos obligatorios cubiertos: `id, title, description, availability, condition, price, link,
   image_link, brand`. Opcionales útiles: `sale_price`, `product_type` (categoría), `google_product_category`.

### Fase 2 — Hosting + automatización (el "se actualiza solo")
7. Se despliega como **Cloudflare Worker con Cron Trigger** (alineado a la migración de la agencia a
   Cloudflare):
   - El cron corre cada 24 h (configurable), regenera el feed y lo guarda en **R2**.
   - Un handler sirve el archivo en una **URL fija**, ej: `https://feed-tbbm.deepbeacon.workers.dev/catalogo.csv`.
   - *Fallback:* si la extracción necesita render de navegador, se usa **GitHub Actions cron + Playwright**
     (o Cloudflare Browser Rendering) que genera el feed y lo publica igual en una URL fija.
8. La URL puede ir **pública** o **con usuario/contraseña** (Meta soporta basic auth en feeds programados).

### Fase 3 — Conectar en Meta (UI, sin token de escritura)
9. Commerce Manager → catálogo elegido → **Data Sources → Add → Data Feed → Scheduled feed**.
10. Pegar la **URL del feed** + (si aplica) usuario/contraseña + **frecuencia = diaria** (o la que definamos).
11. Meta hace el primer pull y empieza a cargar/actualizar productos solo. **Esto lo hace cualquiera con
    acceso normal a Commerce Manager (Berni o el equipo) — no requiere System User token.**

### Fase 4 — Verificación + mantenimiento
12. A las 24-48 h, **leer el match rate** con nuestro acceso read-only → objetivo **90%+**.
13. **Ordenar los catálogos:** hoy hay **5** en la cuenta; dejar **uno oficial** para la pauta y apuntar
    los anuncios ahí (los múltiples catálogos sobre el mismo Pixel también parten el match rate).
14. De ahí en más **el cron mantiene precio/stock al día solo**. Se suma un monitoreo simple (alerta si el
    feed falla o queda viejo).

---

## Por qué esto cumple "100% nosotros"

- La extracción lee el **sitio público** → cero permisos de Meta, cero pedidos a Direct Group.
- El hosting y el cron son **infra nuestra** (Cloudflare / GitHub).
- El único paso humano es **una sola vez**: pegar la URL en Commerce Manager (UI, con el acceso que el
  equipo ya tiene). Después es automático.

## Dos temas separados (no los tapa esta solución)
- **Purchase = 0 en el Pixel:** el sitio manda la compra como evento propio ("Compra finalizada"), no el
  estándar `Purchase`. Es un fix del lado del sitio; no lo arregla el feed. Se deja anotado.
- **Consolidar catálogos:** los 5 catálogos conviene reducirlos; eso sí lo podemos ordenar nosotros desde
  la UI.

## Decisiones para arrancar
1. **Alcance del feed:** catálogo completo (recomendado, maximiza match rate) vs. solo categorías a pautar.
2. **Frecuencia:** diaria (recomendado) u horaria si los precios cambian mucho.
3. **Hosting:** Cloudflare Worker (recomendado) vs. GitHub Actions (si hace falta Playwright).
4. **Catálogo oficial:** cuál de los 5 usamos para la pauta (`Catalogo TBB` o `TBB Agosto 2026`).
5. **URL:** pública o con contraseña.
