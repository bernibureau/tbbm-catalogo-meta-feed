# Solución — Catálogo de Meta de The Blue Box Market

## El problema
El catálogo de productos de Meta (el que alimenta la pauta) se llenaba solo por el Pixel/scraping y quedó
desactualizado: **match rate ~37%** (Meta necesita **90%** para que los anuncios dinámicos funcionen bien),
los productos nuevos no entraban, y varios estaban cargados con un ID que no coincide con el que dispara el
Pixel. No hay un feed de productos disponible y no podemos depender de terceros para generarlo.

## La solución que adoptamos
Generamos **nosotros** un feed de productos automático a partir del sitio público de TBBM y lo publicamos en
una **URL fija que Meta lee sola, de forma programada**. No requiere permisos de escritura por API ni que
nadie externo nos pase nada: se resuelve 100% de nuestro lado.

## Cómo funciona (automático)
1. Un proceso recorre el sitio y detecta todos los productos.
2. De cada uno toma título, precio, stock, imagen, marca y categoría (de la data estructurada de la propia página).
3. Arma el feed con el **ID de cada producto igual al que dispara el Pixel** → el match queda garantizado
   (esto es lo que lleva el 37% al 90%+).
4. Meta re-lee esa URL todos los días → precios y stock siempre actualizados.

## Por qué es robusto
- Corre solo en la nube (tareas programadas); nadie lo ejecuta a mano.
- Es **reanudable**: si algo falla, retoma donde quedó.
- El sitio tiene protección anti-abuso estándar, así que el proceso corre a **ritmo controlado y gradual**
  para respetarla. Por eso el catálogo completo se arma en el transcurso de unos días (decisión de diseño,
  no una limitación).

## Estado y próximos pasos
- ✅ Solución construida y desplegada; el feed se genera solo en la nube.
- ✅ Arrancamos el catálogo con los **3.848 productos reales** del catálogo actual de Meta (sin scraping
  a ciegas), y el proceso descubre los nuevos de forma automática.
- 🔜 Conectar el feed en Commerce Manager (Data Feed programado) y verificar que el match sube a 90%+ en 24-48 h.
- Resultado esperado: catálogo completo y siempre actualizado → retargeting / Advantage+ al 100%.

---

## Purchase = 0: qué es y cómo lo encaramos

**Qué encontramos (verificado):** el evento de compra **sí llega a Meta** — hay compras por el evento
estándar y también por una conversión personalizada ("Compra finalizada"). Es decir, **no es que no haya
compras.** El *"Product purchases: Missing"* del catálogo aparece porque esas compras **no estaban
matcheando contra el catálogo** — que es justamente lo que el feed viene a arreglar.

**La pauta NO está ciega a las compras:** ya optimizamos y reportamos sobre ellas hoy. El gap es puntual del
diagnóstico del catálogo, no de la medición de la pauta.

**Cómo lo encaramos (secuencial, sin construir nada de más):**
1. Primero dejamos que el **feed complete el catálogo** (en marcha).
2. Re-chequeamos el diagnóstico:
   - Si las compras empiezan a matchear → **se resolvió solo**, sin trabajo extra.
   - Si sigue faltando → lo cerramos enviando el evento de compra con los IDs de producto vía **Conversions
     API** (server-to-server, 100% de nuestro lado, sin tocar el sitio).

Estamos afinando un par de detalles del pixel con el equipo para confirmar cuál de los dos caminos aplica.
