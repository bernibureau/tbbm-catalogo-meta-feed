#!/usr/bin/env node
/*
 * Crawler + generador de feed para el catálogo de Meta de The Blue Box Market.
 *
 * ⚠️ El sitio tiene anti-abuse a nivel AWS (ELB/WAF): un burst de requests → 403 y bloqueo de IP.
 *    Por eso este crawler es DELIBERADAMENTE LENTO y respetuoso: rate-limit global (req/s), jitter,
 *    baja concurrencia, y ante 403 hace un enfriamiento largo. Es reanudable (no re-baja lo ya hecho).
 *
 * Método (validado 5-ago-2026):
 *   - Detalle:  GET /product/{id}/ (gzip) → se parsea el <script application/ld+json> @type Product.
 *   - Existencia: 200 con Product JSON-LD = producto real; 500 o soft-404 (200 sin JSON-LD) = no va.
 *   - Feed:     CSV compatible con Meta, id = ID numérico = content_id que dispara el Pixel.
 *
 * Enumeración (de dónde salen los IDs candidatos, sin barrer 54k a lo bruto):
 *   - `--seed <archivo.json|.txt|.csv>`  lista de IDs (ej: exportada del catálogo actual de Meta o del sitemap).
 *   - `--from N --to M`                  rango (usar solo para descubrir IDs nuevos, en tramos chicos).
 *
 * Uso:
 *   node crawler.js build --seed data/seed-ids.json --out docs/feed.csv           # gentil, reanudable
 *   node crawler.js build --from 53000 --to 54000 --out docs/feed.csv --append    # descubrir nuevos
 *
 * Flags: --rps 1.5  --jitter 500  --concurrency 3  --cooldown 300  --timeout 25000  --retries 3
 *        --refresh (re-baja lo ya cacheado)  --append (suma al products.json existente)
 */
"use strict";
const fs = require("fs");
const path = require("path");

const args = parseArgs(process.argv.slice(2));
const CMD = args._[0] || "build";
const BASE = args.base || "https://www.theblueboxmarket.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const RPS = num(args.rps, 1);              // requests/segundo GLOBAL (no por worker) — conservador
const JITTER = int(args.jitter, 600);      // ms de ruido aleatorio por request
const CONCURRENCY = int(args.concurrency, 2);
const COOLDOWN = int(args.cooldown, 300) * 1000; // enfriamiento ante 403 (s → ms)
const MAX_BLOCKS = int(args.maxBlocks, 5);  // 403 consecutivos → abortar (reanuda otra corrida)
const BATCH = int(args.batch, 150);        // requests por tanda antes de descansar
const REST = int(args.rest, 180) * 1000;   // descanso entre tandas (s → ms) — respeta límite por volumen
const GENERIC_MAX = int(args.genericMax, 400000); // 200 más chico que esto y sin JSON-LD = página genérica/WAF
const TIMEOUT = int(args.timeout, 25000);
const RETRIES = int(args.retries, 3);

function parseArgs(a) { const o = { _: [] }; for (let i = 0; i < a.length; i++) { if (a[i].startsWith("--")) { const k = a[i].slice(2); const v = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true; o[k] = v; } else o._.push(a[i]); } return o; }
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }
function log(...m) { process.stderr.write(m.join(" ") + "\n"); }

// -------- filtro de productos restringidos por Meta (alcohol / cuchillos) --------
// Meta rechaza bebidas alcohólicas y armas blancas (cuchillos). El feed se regenera
// del sitio cada día, así que estos productos se vuelven a subir y se vuelven a
// rechazar. Los sacamos del feed publicado (siguen en products.json para auditoría).
// Escape hatch: data/blocklist-ids.json (lista de IDs) fuerza excluir cualquier otro,
// y data/allowlist-ids.json fuerza mantener uno si la heurística lo saca de más.
const readIds = (f) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "data", f), "utf8")).map(String); } catch { return []; } };
const BLOCKLIST = new Set(readIds("blocklist-ids.json"));
const ALLOWLIST = new Set(readIds("allowlist-ids.json"));
const sinTildes = (s) => String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
// bebida alcohólica: se matchea por palabra entera (salvo las frases con espacio)
const ALCO_WORDS = ["vino", "vinos", "whisky", "whiskey", "vodka", "gin", "ginebra", "tequila", "licor", "licores", "champagne", "champan", "espumante", "espumantes", "fernet", "aperol", "campari", "brandy", "cognac", "vermouth", "vermut", "prosecco", "sidra", "grappa", "malbec", "cabernet", "syrah", "chardonnay", "sauvignon", "pinot", "chandon"];
const ALCO_PHRASES = ["baron b", "luigi bosca", "blanc de"];
// electro / accesorios / viajes que dicen "vino" pero NO son bebida (heladeras, vinotecas, abridores)
const ALCO_GUARD_WORDS = ["cava", "vinoteca", "conservadora", "cervecera", "termoelectrica", "termoelectrico", "frigobar", "botellero", "abridor", "sacacorchos", "vertedor", "decantador", "enfriador", "dispenser"];
const ALCO_GUARD_PHRASES = ["para vino", "para vinos", "ruta del vino"];
// cuchillos / armas blancas (los corta-pelo dicen "cuchilla", no matchean; "electrico" salva el cuchillo eléctrico de cocina)
const KNIFE_WORDS = ["cuchillo", "cuchillos", "faca", "facon", "machete", "punal", "daga"];
const KNIFE_GUARD_WORDS = ["electrico", "electrica"];

/** Devuelve el motivo por el que el producto no debe ir al feed, o null si va. */
function motivoRestringido(row) {
  if (ALLOWLIST.has(String(row.id))) return null;
  if (BLOCKLIST.has(String(row.id))) return "blocklist";
  const t = sinTildes(row.title);
  const w = new Set(t.split(/[^a-z0-9]+/).filter(Boolean));
  const tieneFrase = (list) => list.some((p) => t.includes(sinTildes(p)));
  const esAccesorioVino = ALCO_GUARD_WORDS.some((x) => w.has(x)) || tieneFrase(ALCO_GUARD_PHRASES);
  if (!esAccesorioVino && (ALCO_WORDS.some((x) => w.has(x)) || tieneFrase(ALCO_PHRASES))) return "alcohol";
  if (!KNIFE_GUARD_WORDS.some((x) => w.has(x)) && KNIFE_WORDS.some((x) => w.has(x))) return "cuchillo";
  return null;
}

/** Parte las filas en las que van al feed y las restringidas (con su motivo). */
function partirRestringidos(rows) {
  const feed = [], excluidos = [];
  for (const r of rows) { const m = motivoRestringido(r); if (m) excluidos.push({ ...r, motivo: m }); else feed.push(r); }
  return { feed, excluidos };
}

// -------- rate limiter global (espaciado + jitter + descanso por tanda) --------
let nextSlot = 0, blocks = 0, blockedHard = false, reqCount = 0;
async function pace() {
  const now = Date.now();
  const interval = 1000 / RPS;
  const slot = Math.max(now, nextSlot);
  reqCount++;
  // cada BATCH requests, inyecta un descanso largo (respeta límite por volumen/reputación del WAF)
  const extra = BATCH && reqCount % BATCH === 0 ? REST : 0;
  if (extra) log(`  ⏸️  descanso de tanda: ${REST / 1000}s tras ${reqCount} requests`);
  nextSlot = slot + interval + extra;
  const wait = slot - now + (JITTER ? Math.random() * JITTER : 0);
  if (wait > 0) await sleep(wait);
}

async function request(id, method) {
  for (let t = 1; t <= RETRIES; t++) {
    if (blockedHard) return { status: -1 };
    await pace();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const r = await fetch(`${BASE}/product/${id}/`, { method, redirect: "follow", headers: { "user-agent": UA, "accept-language": "es-AR,es;q=0.9", "accept": "text/html" }, signal: ctrl.signal });
      clearTimeout(to);
      if (r.status === 403) {                       // WAF: enfriar y reintentar
        blocks++;
        if (blocks >= MAX_BLOCKS) { blockedHard = true; log(`⛔ ${MAX_BLOCKS} bloqueos 403 seguidos — el sitio nos cortó. Abortando (reanudá más tarde).`); return { status: 403 }; }
        log(`⚠️  403 (bloqueo) en id=${id} — enfriando ${COOLDOWN / 1000}s [${blocks}/${MAX_BLOCKS}]`);
        await sleep(COOLDOWN);
        continue;
      }
      blocks = 0;                                   // hubo respuesta buena → reset contador de bloqueos
      if (r.status === 500 || r.status === 404) return { status: r.status };
      if (r.status === 200) return { status: 200, body: method === "GET" ? await r.text() : null };
      if (t < RETRIES) { await sleep(1000 * t); continue; }
      return { status: r.status };
    } catch (e) { clearTimeout(to); if (t < RETRIES) { await sleep(1000 * t); continue; } return { status: 0, err: e.message }; }
  }
  return { status: 0 };
}

// -------- extracción JSON-LD --------
function extractProduct(html) {
  for (const b of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let j; try { j = JSON.parse(b[1].trim()); } catch { continue; }
    const nodes = Array.isArray(j) ? j : j["@graph"] ? j["@graph"] : [j];
    const p = nodes.find((n) => n && (n["@type"] === "Product" || (Array.isArray(n["@type"]) && n["@type"].includes("Product"))));
    if (p) return p;
  }
  return null;
}
const AVAIL = { "https://schema.org/InStock": "in stock", "http://schema.org/InStock": "in stock", "https://schema.org/OutOfStock": "out of stock", "http://schema.org/OutOfStock": "out of stock" };
function toRow(id, p) {
  const o = p.offers && !Array.isArray(p.offers) ? p.offers : Array.isArray(p.offers) ? p.offers[0] : {};
  const c = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  let img = (Array.isArray(p.image) ? p.image[0] : p.image) || "";
  img = c(img).replace(/^http:\/\//i, "https://");
  return { id: String(id), title: c(p.name).slice(0, 150), description: (c(p.description) || c(p.name)).slice(0, 5000), availability: AVAIL[o.availability] || "in stock", condition: "new", price: o.price != null ? `${o.price} ${o.priceCurrency || "ARS"}` : "", link: c(p.url) || `${BASE}/product/${id}/`, image_link: img, brand: c(p.brand && (p.brand.name || p.brand)), product_type: c(p.category), sku: c(p.sku) };
}

// -------- IO --------
function readSeed(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return [];
  if (file.endsWith(".json")) return JSON.parse(raw).map(String);
  // txt/csv: extrae todos los números que parezcan IDs de /product/{id} o una col de IDs
  const ids = new Set();
  for (const m of raw.matchAll(/(?:\/product\/|^|,|\s)(\d{1,7})(?:\D|$)/gm)) ids.add(m[1]);
  return [...ids];
}
function loadCache(dir) { const f = path.join(dir, "products.json"); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : []; }
// Lee un CSV escrito por writeCSV (campos siempre entrecomillados, sin saltos de línea internos).
function readCSV(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length);
  if (!lines.length) return [];
  const parseLine = (line) => { const out = []; let f = "", q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else { if (c === '"') q = true; else if (c === ",") { out.push(f); f = ""; } else f += c; } } out.push(f); return out; };
  const head = parseLine(lines[0]);
  return lines.slice(1).map((l) => { const cells = parseLine(l); const o = {}; head.forEach((h, i) => (o[h] = cells[i])); return o; });
}
function writeCSV(rows, out) {
  const cols = ["id", "title", "description", "availability", "condition", "price", "link", "image_link", "brand", "product_type"];
  const esc = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`;
  ensureDir(out); fs.writeFileSync(out, [cols.join(",")].concat(rows.map((r) => cols.map((k) => esc(r[k])).join(","))).join("\n"));
  log(`✓ Feed CSV: ${rows.length} filas → ${out}`);
}
function writeExcluded(rows, out) {
  const cols = ["id", "motivo", "title"];
  const esc = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`;
  ensureDir(out); fs.writeFileSync(out, [cols.join(",")].concat(rows.map((r) => cols.map((k) => esc(r[k])).join(","))).join("\n"));
  if (rows.length) log(`  ⊘ Excluidos del feed (restringidos por Meta): ${rows.length} → ${out}`);
}

// -------- build (gentil, reanudable) --------
async function build() {
  const out = args.out || "docs/feed.csv";
  const dir = /\.(csv|json)$/i.test(out) ? path.dirname(out) : out;
  const feedPath = out.endsWith(".csv") ? out : path.join(dir, "feed.csv");
  const cachePath = path.join(dir, "products.json");

  // candidatos
  let ids = [];
  if (args.seed) ids = readSeed(args.seed);
  if (args.from || args.to) { for (let i = int(args.from, 1); i <= int(args.to, 1); i++) ids.push(String(i)); }
  ids = [...new Set(ids)];
  if (!ids.length) { log("Sin IDs candidatos todavía (el seed está vacío; corré enumerate primero). Nada que hacer."); return; }

  // cache / reanudación
  const cache = new Map((args.append ? loadCache(dir) : []).map((r) => [String(r.id), r]));
  const doneOk = args.refresh ? new Set() : new Set(cache.keys());
  const todo = ids.filter((id) => !doneOk.has(id));
  const cats = args.categories ? String(args.categories).split(",").map((s) => s.trim().toLowerCase()) : null;
  log(`Build gentil: ${todo.length} a bajar (de ${ids.length} candidatos; ${cache.size} en cache) · rps ${RPS} · conc ${CONCURRENCY}`);

  const stats = { ok: 0, noLd: 0, gone: 0, err: 0, wafish: 0 };
  let idx = 0, since = 0;
  const flush = () => {
    const rows = [...cache.values()];
    ensureDir(cachePath); fs.writeFileSync(cachePath, JSON.stringify(rows));
    const base = cats ? rows.filter((r) => cats.includes((r.product_type || "").toLowerCase())) : rows;
    const { feed, excluidos } = partirRestringidos(base);
    writeCSV(feed, feedPath);
    writeExcluded(excluidos, path.join(dir, "excluded.csv"));
  };

  async function worker() {
    while (idx < todo.length && !blockedHard) {
      const id = todo[idx++];
      const r = await request(id, "GET");
      if (r.status === 200 && r.body) {
        const p = extractProduct(r.body);
        if (p) { cache.set(id, toRow(id, p)); stats.ok++; }
        // 200 chico y sin producto = página genérica/WAF/soft-404 → AMBIGUO: no se marca gone, se reintenta en otra corrida
        else if (r.body.length < GENERIC_MAX) stats.wafish++;
        else stats.noLd++;
      } else if (r.status === 500 || r.status === 404) stats.gone++;
      else if (r.status === 403) { /* ya logueado */ } else stats.err++;
      if (++since >= 100) { since = 0; flush(); log(`  …${idx}/${todo.length} · ok ${stats.ok} · gone ${stats.gone} · genérica ${stats.wafish} · sinLD ${stats.noLd} · err ${stats.err}`); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  flush();
  if (stats.wafish > stats.ok) log(`⚠️  Muchas páginas genéricas (${stats.wafish}) vs productos (${stats.ok}) — probable throttling del WAF; conviene bajar --rps / subir --rest y reanudar.`);
  log(`✓ Fin: ok ${stats.ok} · gone ${stats.gone} · genérica/WAF ${stats.wafish} · sinLD ${stats.noLd} · err ${stats.err}` + (blockedHard ? " · ⛔ CORTADO por WAF (reanudá con --append)" : ""));
}

// -------- enumerate (gentil, HEAD liviano → seed de IDs existentes; reanudable por watermark) --------
async function enumerate() {
  const seedPath = args.seed || "data/seed-ids.json";
  const statePath = path.join(path.dirname(seedPath), "enum-state.json");
  const known = new Set(fs.existsSync(seedPath) ? JSON.parse(fs.readFileSync(seedPath, "utf8")).map(String) : []);
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { checked: 0 };
  const ceil = int(args.to, 54000), chunk = int(args.chunk, 3000);
  // continúa desde el watermark; cuando llega al techo, vuelve a 1 (para recapturar bajas/altas)
  let start = state.checked >= ceil ? int(args.from, 1) : state.checked + 1;
  const end = Math.min(ceil, start + chunk - 1);
  log(`Enumerate gentil (HEAD): tanda ${start}..${end} de ${ceil} · watermark ${state.checked} · ${known.size} conocidos · rps ${RPS}`);
  const range = []; for (let i = start; i <= end; i++) range.push(i);
  let idx = 0, since = 0, found = 0, lastDone = start - 1;
  const flush = () => { ensureDir(seedPath); fs.writeFileSync(seedPath, JSON.stringify([...known].map(Number).sort((a, b) => a - b))); fs.writeFileSync(statePath, JSON.stringify({ checked: lastDone })); };
  async function worker() {
    while (idx < range.length && !blockedHard) {
      const id = range[idx++];
      const r = await request(String(id), "HEAD");
      if (r.status === 200) { known.add(String(id)); found++; }
      if (id > lastDone) lastDone = id;
      if (++since >= 100) { since = 0; flush(); log(`  …${idx}/${range.length} · existen +${found} (total ${known.size})`); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (blockedHard) lastDone = start - 1;            // si cortó, no avanzar el watermark (reanuda la misma tanda)
  else if (end >= ceil) lastDone = ceil;            // completó el techo → próxima corrida reinicia desde --from
  flush();
  log(`✓ Enumerate: +${found} nuevos · total ${known.size} IDs · watermark ${lastDone}/${ceil} → ${seedPath}` + (blockedHard ? " · ⛔ CORTADO (reanuda la tanda)" : ""));
}

// -------- clean (aplica el filtro de restringidos a un feed existente, sin recrawlear) --------
function clean() {
  const out = args.out || "docs/feed.csv";
  const rows = readCSV(out);
  if (!rows.length) { log(`Sin filas en ${out}.`); return; }
  const { feed, excluidos } = partirRestringidos(rows);
  writeCSV(feed, out);
  writeExcluded(excluidos, path.join(path.dirname(out), "excluded.csv"));
  const porMotivo = excluidos.reduce((a, r) => ((a[r.motivo] = (a[r.motivo] || 0) + 1), a), {});
  log(`✓ Clean: ${feed.length} al feed · ${excluidos.length} excluidos (${Object.entries(porMotivo).map(([k, v]) => `${k} ${v}`).join(" · ")})`);
}

(async function main() {
  if (CMD === "build") return build();
  if (CMD === "enumerate") return enumerate();
  if (CMD === "clean") return clean();
  log(`Comando: ${CMD}. Usá: enumerate --from N --to M  |  build --seed data/seed-ids.json --out docs/feed.csv  |  clean --out docs/feed.csv`);
  process.exit(1);
})().catch((e) => { log("FATAL", e.stack || e.message); process.exit(1); });
