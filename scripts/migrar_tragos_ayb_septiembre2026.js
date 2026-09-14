// scripts/migrar_tragos_ayb_septiembre2026.js
//
// Importa el costeo de barra de AYB (planilla "Septiembre 26 corregido")
// que hasta ahora vivía en Excel, a Costos → Tragos:
//   - 104 destilados/aperitivos -> productos_ayb (categoria='Destilados')
//   - 21 tragos clásicos        -> platos_costo (departamento='ayb', categoria='Tragos Clasicos')
//   - 7 tragos "Autor Nuevo"    -> platos_costo (departamento='ayb', categoria='Tragos de Autor')
// con sus líneas de ingrediente en plato_insumos_ayb.
//
// Idempotente: se puede correr más de una vez sin duplicar nada.
//   - Un producto de productos_ayb que ya existe (mismo nombre, sin
//     importar mayúsculas) se deja tal cual — no se pisa su precio.
//   - Un trago que ya existe en platos_costo (mismo nombre, departamento
//     'ayb') se salta completo (no se tocan sus ingredientes ni su precio).
//
// Uso: node scripts/migrar_tragos_ayb_septiembre2026.js   (desde la raíz del proyecto)

const fs = require('fs');
const path = require('path');
const db = require('../src/db/database');

const CATEGORIA_DESTILADOS = 'Destilados';
const CATEGORIA_OTROS = 'Otros insumos de barra';

// ── Normalización de texto (mismo criterio que src/services/importadorPlatos.js,
//    para no reinventar cómo esta app ya compara nombres) ──
function normalizar(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Alias explícitos: nombre de ingrediente (normalizado) tal como viene en
//    las recetas -> nombre EXACTO del destilado en destilados_septiembre2026.json.
//
//    Se usa una tabla fija en vez de matching difuso (Levenshtein) porque acá
//    un error de matching es peligroso: por ejemplo "limon" (jugo/guarnición,
//    sin alcohol) es substring de "Limoncello" (un licor) y un matcher común
//    por contención los confundiría. Como el set de ingredientes de estas 28
//    recetas es chico y conocido, es más seguro escribir la tabla a mano y
//    documentar acá mismo los casos dudosos, que confiar en un score.
//
//    Los 5 primeros son los que ya venían marcados como "variantes de
//    ortografía" al pedir esta migración; el resto se agrega porque el
//    nombre de la receta no coincide textualmente con el de destilados.json
//    pero es inequívocamente el mismo producto (p.ej. "campari" -> "Campari
//    – Italia").
const ALIAS_DESTILADOS = {
  'ron bacardi': 'Bacardi blanco',
  'ron bacardi bco': 'Bacardi blanco',
  'ron bacardi blanco': 'Bacardi blanco',
  'gin beefeter': 'Beefeater - Inglaterra',
  'voda smirnoff': 'Smirnoff – Rusia',
  'vodka smirnoff': 'Smirnoff – Rusia',
  'tequila cuervo bco': 'José cuervo blanco',
  'cachacca': 'Cachaca',
  'jim beam': 'Jim Beam',
  'campari': 'Campari – Italia',
  'amaretto': 'Amaretto Disaronno - Italia',
  'aperol': 'Aperol - Italia',
  'malibu': 'Malibú - Barbados',
  'drambuie': 'Drambuie - Escocia',
  'vodka sernova': 'Sernova – Italia',
  'borguetti': 'Borguetti - Italia', // ojo: destilados.json TAMBIÉN tiene "Sambuca Borguetti - Italia" — el costo_parcial de la receta (Expresso Martini, 22ml=$363.73 => ~$16.53/ml) coincide con el precio de "Borguetti - Italia" ($12400/750ml=$16.53/ml), no con el de Sambuca Borguetti ($25130/750ml=$33.5/ml). Por eso apunta a ese y no al otro.
  'cynar': 'Cynar - Italia',
  'pisco': 'Pisco',
  'gin heredero': 'Heredero',
  'fernet': 'Fernet Branca - Italia',
  'gancia': 'Gancia',
  'limoncello': 'Limoncello - Italia',
  'amargo obrero': 'Amargo Obrero - Argentina',
  'grappa': 'Grappa Candolini- Italia',
  'whisky red label': 'Johnnie Walker Red Label',
  'escoces jw red': 'Johnnie Walker Red Label', // "Escocés (JW Red)" normalizado
  // BAJA CONFIANZA — ver reporte final: destilados.json no tiene ningún
  // "Havana ... dorado" ni "Ron Havana Dorado" literal. Se lo asocia al más
  // parecido (Havana Club añejo, que es "dorado" por estilo) pero convendría
  // que Maxi confirme si en realidad se refería a otra botella (p.ej.
  // Bacardi Dorado) y lo corrija a mano en Inventario AYB / en el trago.
  'ron havanna dorado': 'Havana club añejo - Cuba',
};

// ── Ingredientes que NO son un destilado del catálogo (jugos, syrups,
//    guarniciones, y también un puñado de "genéricos" alcohólicos que las
//    recetas no especifican con marca — vermouths sueltos, triple sec,
//    espumante, vino). Todos se agrupan bajo un nombre canónico para que
//    variantes de tipeo/acentos de la misma cosa ("jugo limon" / "jugo de
//    limon" / "jugo de limón") terminen siendo UN solo producto en vez de
//    tres. Se crean en productos_ayb con categoria='Otros insumos de barra'
//    — Maxi puede reclasificarlos o corregirles la unidad después, desde
//    Inventario AYB.
const CANONICO_OTROS = {
  'jugo limon': 'Jugo de limón',
  'jugo de limon': 'Jugo de limón',
  'limon': 'Jugo de limón', // "limon" a secas aparece con cantidades de líquido (10ml), no como guarnición — se asume jugo
  'rodaja de limon': 'Rodaja de limón (guarnición)',
  'limon deshidratado': 'Limón deshidratado (guarnición)',
  'jugo tomate': 'Jugo de tomate',
  'jugo cranberry': 'Jugo de cranberry',
  'jugo de naranja': 'Jugo de naranja',
  'jugo anana': 'Jugo de ananá',
  'jujo anana': 'Jugo de ananá', // typo de la planilla
  'jugo de pomelo': 'Jugo de pomelo',
  'lima': 'Lima (fruta)',
  'aceituna': 'Aceituna',
  'bitter angostura': 'Bitter Angostura',
  'biter angostura': 'Bitter Angostura', // typo de la planilla
  'agua c gas': 'Agua con gas',
  'agua con gas': 'Agua con gas',
  'menta fresca': 'Menta fresca',
  'menta': 'Menta fresca',
  'syrup': 'Syrup simple',
  'syrup simple': 'Syrup simple',
  'syrup jengibre': 'Syrup de jengibre',
  'top cerveza tirada': 'Cerveza tirada (top)',
  'clara de huevo': 'Clara de huevo',
  'cafe espresso': 'Café espresso',
  // genéricos sin marca — no hay forma de saber a qué botella se refería
  // la planilla, así que quedan como insumo propio en vez de forzarlos
  // contra un destilado específico:
  'triple sec': 'Triple sec (genérico)',
  'espumante': 'Espumante',
  'vermouht seco': 'Vermouth seco (genérico)',
  'vermouth dulce': 'Vermouth dulce (genérico)',
  'vermouth rojo': 'Vermouth rojo (genérico)',
  'vermuth blanco': 'Vermouth blanco (genérico)',
  'vermuth bianco': 'Vermouth bianco (genérico)',
  'vino torrontes': 'Vino Torrontés',
  // ingredientes de autor nuevo (specialties de coctelería de autor):
  'pomelo deshidratado': 'Pomelo deshidratado (guarnición)',
  'espuma de marshmello': 'Espuma de marshmallow',
  'bitter de tabaco y vainilla': 'Bitter de tabaco y vainilla',
  'biter de cacao': 'Bitter de cacao',
  'cordial de hongos': 'Cordial de hongos',
  'hongos miniatura': 'Hongos miniatura (guarnición)',
  'cordial de mate': 'Cordial de mate',
  'espuma de naranja y fernet menta': 'Espuma de naranja y fernet menta',
  'infusion de te verde': 'Infusión de té verde',
  'almibar de pepino': 'Almíbar de pepino',
  'soda de hibiscus': 'Soda de hibiscus',
  'ramillete de eneldo': 'Ramillete de eneldo (guarnición)',
  'almibar de membrillo': 'Almíbar de membrillo',
};

function leerJson(nombreArchivo) {
  const ruta = path.join(__dirname, 'data', nombreArchivo);
  return JSON.parse(fs.readFileSync(ruta, 'utf8'));
}

// ── 1) Destilados/aperitivos -> productos_ayb ──
// unidad_default='ml' con precio_unitario = costo por ml (costo_botella /
// tamaño de botella), en vez de guardar el costo de la botella entero. Es
// a propósito, aunque la planilla da el costo "por botella": Costos
// recalcula el costo de un trago (y de cada línea, cuando se edita la
// cantidad o cambia el precio de un producto — ver recalcularCostoPlato /
// recalcularPlatosAyb en costos.js) haciendo cantidad_de_la_receta ×
// precio_unitario, exactamente como ya hace Cocina con insumos (que
// siempre están en la MISMA unidad que usan sus recetas). Las recetas de
// tragos miden todo en ml, así que precio_unitario tiene que ser "por ml"
// para que esa cuenta dé un número real — si quedara "por botella" (unidad
// 'bot'), cualquier edición futura de cantidad o precio multiplicaría mal
// (ml × precio-de-botella-entera) y el costo se dispararía a un número
// absurdo. Se asume una botella estándar de 750ml (no viene el dato real
// en la planilla) — Maxi puede corregir el precio_unitario a mano desde
// Inventario AYB para cualquier botella que no sea de 750ml.
const ML_POR_BOTELLA_ASUMIDO = 750;

async function importarDestilados() {
  const destilados = leerJson('destilados_septiembre2026.json');
  const resumen = { nuevos: 0, existentes: 0 };
  const idPorNombre = new Map(); // nombre EXACTO (como está en el JSON) -> id

  for (const d of destilados) {
    const existente = await db.get2('SELECT id FROM productos_ayb WHERE LOWER(nombre)=LOWER($1)', [d.nombre]);
    if (existente) {
      idPorNombre.set(d.nombre, existente.id);
      resumen.existentes++;
      continue;
    }
    const precioPorMl = (d.costo_botella || 0) / ML_POR_BOTELLA_ASUMIDO;
    const insertado = await db.get2(
      `INSERT INTO productos_ayb (nombre, categoria, unidad_default, precio_unitario, stock_actual, activo)
       VALUES ($1,$2,'ml',$3,0,true) RETURNING id`,
      [d.nombre, d.categoria || CATEGORIA_DESTILADOS, precioPorMl]
    );
    idPorNombre.set(d.nombre, insertado.id);
    resumen.nuevos++;
  }
  return { resumen, idPorNombre };
}

// Busca o crea (una sola vez) el producto "Otros insumos de barra"
// correspondiente a un nombre canónico, cacheando el id para no volver a
// golpear la base por cada línea de receta que lo repite.
const cacheOtros = new Map(); // nombreCanonico -> id
async function getOrCrearOtro(nombreCanonico, unidad, precioUnitario) {
  if (cacheOtros.has(nombreCanonico)) return cacheOtros.get(nombreCanonico);
  const existente = await db.get2('SELECT id FROM productos_ayb WHERE LOWER(nombre)=LOWER($1)', [nombreCanonico]);
  if (existente) {
    cacheOtros.set(nombreCanonico, existente.id);
    return existente.id;
  }
  const insertado = await db.get2(
    `INSERT INTO productos_ayb (nombre, categoria, unidad_default, precio_unitario, stock_actual, activo)
     VALUES ($1,$2,$3,$4,0,true) RETURNING id`,
    [nombreCanonico, CATEGORIA_OTROS, unidad, precioUnitario]
  );
  cacheOtros.set(nombreCanonico, insertado.id);
  return insertado.id;
}

// Resuelve UN ingrediente de receta a un id de productos_ayb, creando el
// producto "otros insumos" la primera vez que aparece si hace falta.
// unidadFallback/precioFallback son la unidad y el precio por unidad a usar
// SI hay que crear el producto (no se usan si ya existía).
async function resolverIngrediente(nombreIngrediente, idPorNombreDestilado, unidadFallback, precioFallback) {
  const norm = normalizar(nombreIngrediente);

  if (ALIAS_DESTILADOS[norm]) {
    const nombreDestilado = ALIAS_DESTILADOS[norm];
    const id = idPorNombreDestilado.get(nombreDestilado);
    if (id) return { id, match: 'destilado', nombreDestino: nombreDestilado };
  }

  if (CANONICO_OTROS[norm]) {
    const nombreCanonico = CANONICO_OTROS[norm];
    const id = await getOrCrearOtro(nombreCanonico, unidadFallback, precioFallback);
    return { id, match: 'otro', nombreDestino: nombreCanonico };
  }

  return { id: null, match: 'sin_match', nombreDestino: null };
}

// ── 2) Tragos (clásicos + autor nuevo) -> platos_costo + plato_insumos_ayb ──
async function importarTrago({ nombre, categoria, precioVenta, ingredientes }, idPorNombreDestilado) {
  const yaExiste = await db.get2(
    "SELECT id FROM platos_costo WHERE departamento='ayb' AND LOWER(nombre)=LOWER($1)", [nombre]
  );
  if (yaExiste) return { estado: 'ya_existia', nombre };

  const lineas = []; // { insumo_id, cantidad, unidad, costo_parcial }
  const sinMatch = [];

  for (const ing of ingredientes) {
    const r = await resolverIngrediente(ing.nombre, idPorNombreDestilado, ing.unidad, ing.precioUnitarioFallback);
    if (!r.id) { sinMatch.push(ing.nombre); continue; }
    lineas.push({ insumo_id: r.id, cantidad: ing.cantidad, unidad: ing.unidad, costo_parcial: ing.costoParcial });
  }

  const costoTotal = lineas.reduce((s, l) => s + (l.costo_parcial || 0), 0);
  // margen_ganancia se calcula para que el "precio de venta sugerido" que
  // muestra la pantalla (costo * (1+margen/100)) reproduzca el precio_venta
  // de la planilla, en vez de guardar un margen inventado (30% por
  // default) que mostraría un precio sugerido distinto al de la fuente.
  const margen = costoTotal > 0 ? ((precioVenta - costoTotal) / costoTotal) * 100 : 0;

  const plato = await db.get2(
    `INSERT INTO platos_costo (nombre, categoria, porciones, precio_venta, margen_ganancia, costo_total, departamento)
     VALUES ($1,$2,1,$3,$4,$5,'ayb') RETURNING id`,
    [nombre, categoria, precioVenta, margen, costoTotal]
  );

  for (const l of lineas) {
    await db.run2(
      `INSERT INTO plato_insumos_ayb (plato_id, insumo_id, cantidad, unidad, costo_parcial)
       VALUES ($1,$2,$3,$4,$5)`,
      [plato.id, l.insumo_id, l.cantidad, l.unidad, l.costo_parcial]
    );
  }

  return { estado: 'creado', nombre, costoTotal, lineasOk: lineas.length, sinMatch };
}

async function importarTragosClasicos(idPorNombreDestilado) {
  const cocteles = leerJson('cocteles_clasicos_septiembre2026.json');
  const resultados = [];
  for (const c of cocteles) {
    // Todas las cantidades de esta planilla vienen en el campo "ml" — incluso
    // guarniciones raras como "Aceituna" (0.5) o "Rodaja de Limon" (0.02), que
    // en la vida real no se miden en mililitros. Se importa tal cual (no se
    // inventa una unidad distinta) porque el costo_parcial ya viene calculado
    // desde la planilla; Maxi puede ajustar la unidad de esos insumos puntuales
    // en Inventario AYB si quiere prolijizarlo, sin que afecte el costo ya cargado.
    const ingredientes = c.ingredientes.map(i => ({
      nombre: i.insumo,
      cantidad: i.ml,
      unidad: 'ml',
      costoParcial: i.costo_parcial,
      // Si hay que crear el insumo como "otro" nuevo, se le pone de precio
      // por unidad el costo/ml de ESTA línea (primera vez que aparece).
      precioUnitarioFallback: i.ml > 0 ? i.costo_parcial / i.ml : 0,
    }));
    resultados.push(await importarTrago({
      nombre: c.nombre,
      categoria: 'Tragos Clasicos',
      precioVenta: c.precio_venta,
      ingredientes,
    }, idPorNombreDestilado));
  }
  return resultados;
}

async function importarTragosAutor(idPorNombreDestilado) {
  const recetas = leerJson('autor_nuevo_septiembre2026.json');
  const resultados = [];
  for (const r of recetas) {
    // El archivo trae filas de resumen al final ("RESUMEN", "TOTAL COSTO
    // PROMEDIO", ...) sin ingredientes ni precio — se saltan.
    if (!r.ingredientes || r.ingredientes.length === 0) continue;

    const ingredientes = r.ingredientes
      // La fila "TOTAL ONZAS" es un subtotal informativo de la planilla, no
      // un ingrediente real (no tiene unidad_compra ni costo) — se descarta.
      .filter(i => i.unidad_compra !== null)
      .map(i => {
        // "peso_neto" es la cantidad que la RECETA usa (lo que va a quedar
        // guardado como plato_insumos_ayb.cantidad), y es en la unidad en la
        // que se sirve, no en la unidad de compra: para 'bot'/'cc' es ml
        // (mililitros servidos), para 'unid' es una cuenta de unidades. Por
        // eso el fallback de precio, si hay que crear el insumo, se calcula
        // como costo_ingrediente/peso_neto (precio "por lo que la receta
        // consume") y NO a partir de precio_unidad_compra: ese precio es por
        // el envase de compra entero (una botella, un litro, una caja — no
        // es un dato confiable para convertir sin saber el tamaño real del
        // envase), y mezclarlo con una cantidad en ml/unidades produciría el
        // mismo desajuste de unidades que tenían los destilados antes de
        // pasar a precio-por-ml (ver comentario en importarDestilados).
        const unidad = i.unidad_compra === 'unid' ? 'unidad' : 'ml';
        return {
          nombre: i.insumo,
          cantidad: i.peso_neto,
          unidad,
          costoParcial: i.costo_ingrediente,
          precioUnitarioFallback: i.peso_neto > 0 ? i.costo_ingrediente / i.peso_neto : 0,
        };
      });

    resultados.push(await importarTrago({
      nombre: r.nombre,
      categoria: 'Tragos de Autor',
      precioVenta: r.precio_venta,
      ingredientes,
    }, idPorNombreDestilado));
  }
  return resultados;
}

(async () => {
  try {
    // Esperar a que database.js termine de crear TODAS las tablas (incluida
    // plato_insumos_ayb) antes de tocar nada — si no, hay una carrera entre
    // este script y la inicialización de la base que puede hacer fallar la
    // migración a mitad de camino con "no existe la relación X".
    if (db.listaParaUsar) await db.listaParaUsar;

    console.log('== Migración Tragos AYB — Septiembre 2026 ==\n');

    console.log('1) Destilados/aperitivos...');
    const { resumen: resumenDestilados, idPorNombre } = await importarDestilados();
    console.log(`   ✓ ${resumenDestilados.nuevos} nuevos, ${resumenDestilados.existentes} ya existían.\n`);

    console.log('2) Tragos clásicos...');
    const resultadosClasicos = await importarTragosClasicos(idPorNombre);
    reportarTragos(resultadosClasicos);

    console.log('\n3) Tragos de autor (Autor Nuevo)...');
    const resultadosAutor = await importarTragosAutor(idPorNombre);
    reportarTragos(resultadosAutor);

    // Aviso importante sobre el precio de venta de "Autor Nuevo": esa
    // planilla lo calculó como costo/0.04 (un ratio de costo del 4%, mucho
    // más agresivo que el ~15-20% usado en destilados/clásicos). Se importa
    // el número tal cual está en la planilla (no se inventa otro), pero
    // Maxi debería revisarlo antes de usarlo como precio real de carta —
    // puede no reflejar el margen que en verdad quiere aplicar.
    console.log('\n⚠ AVISO: los precios de venta de "Tragos de Autor" salen de la planilla original,');
    console.log('  calculados como costo/0.04 (4% de costo objetivo) — mucho más agresivo que el');
    console.log('  margen usado en destilados y tragos clásicos (~15-20%). Se importaron tal cual,');
    console.log('  pero convendría que Maxi los revise antes de usarlos como precio de carta real.');

    const totalProductos = await db.get2("SELECT COUNT(*)::int AS n FROM productos_ayb");
    const totalTragos = await db.get2("SELECT COUNT(*)::int AS n FROM platos_costo WHERE departamento='ayb'");
    const totalLineas = await db.get2("SELECT COUNT(*)::int AS n FROM plato_insumos_ayb");
    console.log(`\n== Totales en la base ahora: ${totalProductos.n} productos_ayb · ${totalTragos.n} tragos AYB · ${totalLineas.n} líneas de ingrediente ==`);
  } catch (e) {
    console.error('✗ Error en la migración:', e);
  } finally {
    process.exit(0);
  }
})();

function reportarTragos(resultados) {
  for (const r of resultados) {
    if (r.estado === 'ya_existia') {
      console.log(`   - "${r.nombre}": ya existía, omitido.`);
    } else {
      console.log(`   ✓ "${r.nombre}": costo $${r.costoTotal.toFixed(2)}, ${r.lineasOk} ingrediente(s)${r.sinMatch.length ? ', SIN MATCH: ' + r.sinMatch.join(', ') : ''}`);
    }
  }
}
