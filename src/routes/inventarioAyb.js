const express = require('express');
const router = express.Router();
const db = require('../db/database');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { loginRequerido, requiereDepartamento } = require('./middleware');
const { analizarBotellaAyb, mensajeErrorGemini } = require('../services/gemini');
const { parsearArchivoProductosAyb, importarProductosAyb, generarPlantillaProductosAyb } = require('../services/importadorProductosAyb');
router.use(loginRequerido, requiereDepartamento('/inventario-ayb'));

const storageFotoBotella = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, 'botella_ayb_' + Date.now() + path.extname(file.originalname))
});
const uploadFotoBotella = multer({ storage: storageFotoBotella, limits: { fileSize: 10 * 1024 * 1024 } });

const storageProductosAyb = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, 'productos_ayb_' + Date.now() + path.extname(file.originalname))
});
const uploadProductosAyb = multer({ storage: storageProductosAyb, limits: { fileSize: 10 * 1024 * 1024 } });

// Compara dos nombres de producto de forma flexible (sin acentos, por
// palabras en común) para matchear lo que reconoce la IA contra el
// catálogo ya cargado — no hay dos bases de datos con el mismo nombre
// exacto de fábrica, así que una comparación literal casi nunca alcanza.
function normalizarTexto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca acentos
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(p => p.length > 1);
}
function puntajeSimilitud(nombreA, nombreB) {
  const palabrasA = normalizarTexto(nombreA);
  const palabrasB = new Set(normalizarTexto(nombreB));
  if (!palabrasA.length || !palabrasB.size) return 0;
  const comunes = palabrasA.filter(p => palabrasB.has(p)).length;
  return comunes / Math.max(palabrasA.length, palabrasB.size);
}

// Inventario AYB (stock de barra) es solo para quien gestiona AYB
// (admin/supervisor) — mismo criterio que Croutons y Miembro de equipo: un
// mozo común no debe entrar acá, ni siquiera escribiendo la URL directo.
// Excepción: la pantalla de ajuste rápido por QR (/producto/:id/ajustar)
// se deja pasar a cualquier cuenta logueada de AYB, porque el conteo físico
// de stock a veces lo hace cualquier mozo, no solo el encargado — está
// marcada más abajo, antes de que se aplique esta restricción.
function esGestorAyb(req) {
  const departamento = (req.session.usuario.departamento || '').toLowerCase();
  const rol = (req.session.usuario.rol || '').toLowerCase();
  const enAyb = departamento === 'ayb' || !departamento || departamento === 'sistema';
  return enAyb && (rol === 'admin' || rol === 'supervisor');
}

// ── Ajuste rápido por QR (cualquier cuenta de AYB logueada, no solo gestor) ──
router.get('/producto/:id/ajustar', async (req, res) => {
  const departamento = (req.session.usuario.departamento || '').toLowerCase();
  if (departamento && departamento !== 'ayb' && !esGestorAyb(req)) {
    return res.redirect('/inicio?msg=sin_acceso');
  }
  try {
    const producto = await db.get2(
      `SELECT * FROM productos_ayb WHERE id=$1 AND activo=true`,
      [req.params.id]
    );
    const geminiConfigurado = !!process.env.GEMINI_API_KEY;
    if (!producto) {
      return res.render('inventario_ayb_ajustar', { producto: null, msg: null, geminiConfigurado });
    }
    res.render('inventario_ayb_ajustar', { producto, msg: req.query.msg || null, geminiConfigurado });
  } catch (e) {
    console.error('Error cargando producto para ajuste rápido:', e.message);
    res.render('inventario_ayb_ajustar', { producto: null, msg: null, geminiConfigurado: !!process.env.GEMINI_API_KEY });
  }
});

// Mutación de stock compartida — la usan tanto el formulario manual de
// ajuste (Sumar/Restar/Fijar) como el auto-sumado de "Reconocer con foto",
// para no tener la misma lógica de update+historial escrita dos veces y
// que se puedan desincronizar con el tiempo.
async function ajustarStock(productoId, modo, valor, nota, usuario) {
  const producto = await db.get2(`SELECT * FROM productos_ayb WHERE id=$1`, [productoId]);
  if (!producto) throw new Error('No se encontró el producto.');

  const anterior = producto.stock_actual || 0;
  let nueva;
  if (modo === 'sumar') nueva = anterior + valor;
  else if (modo === 'restar') nueva = Math.max(0, anterior - valor);
  else nueva = valor; // establecer

  await db.run2(`UPDATE productos_ayb SET stock_actual=$1 WHERE id=$2`, [nueva, productoId]);
  await db.run2(
    `INSERT INTO inventario_ayb_movimientos (producto_id, tipo, cantidad, cantidad_anterior, cantidad_nueva, nota, usuario_id, usuario_nombre)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [productoId, modo, valor, anterior, nueva, nota || '', usuario.id, usuario.nombre]
  );

  return { producto, nueva };
}

router.post('/producto/:id/ajustar', async (req, res) => {
  const departamento = (req.session.usuario.departamento || '').toLowerCase();
  if (departamento && departamento !== 'ayb' && !esGestorAyb(req)) {
    return res.redirect('/inicio?msg=sin_acceso');
  }
  const volverAQr = req.body.volver_a_qr === '1';
  // Si el ajuste vino de una fila dentro del modal de lista de productos,
  // al volver reabrimos ese mismo modal (y la búsqueda/rubro que tenía
  // puesto) — si no, guardar un stock desde ahí devolvía a la pantalla
  // resumen con el modal cerrado, como si nada se hubiera hecho.
  const volverLista = req.body.volver_lista === '1';
  const buscarActual = (req.body.buscar_actual || '').trim();
  const rubroActual = (req.body.rubro_actual || '').trim();
  const qsVolverLista = !volverLista ? '' :
    (buscarActual
      ? `&buscar=${encodeURIComponent(buscarActual)}`
      : (rubroActual ? `&rubro=${encodeURIComponent(rubroActual)}` : '&modal=productos'));
  const redirigirCon = (msg) => res.redirect(
    volverAQr
      ? `/inventario-ayb/producto/${req.params.id}/ajustar?msg=${encodeURIComponent(msg)}`
      : `/inventario-ayb?msg=${encodeURIComponent(msg)}${qsVolverLista}`
  );

  try {
    const modo = req.body.modo || 'sumar'; // 'sumar' | 'restar' | 'establecer'
    const valor = parseFloat(req.body.cantidad);
    if (isNaN(valor) || valor < 0) return redirigirCon('Cantidad inválida.');

    const { producto, nueva } = await ajustarStock(req.params.id, modo, valor, (req.body.nota || '').trim(), req.session.usuario);
    redirigirCon(`${producto.nombre}: stock actualizado a ${nueva}.`);
  } catch (e) {
    console.error('Error ajustando stock de inventario AYB:', e.message);
    redirigirCon('Error actualizando el stock: ' + e.message);
  }
});

// ── Reconocer botella por foto (IA) — mismo nivel de acceso que el ajuste
//    rápido por QR: cualquier cuenta de AYB logueada, no solo el gestor,
//    porque el conteo físico de stock a veces lo hace cualquier mozo. ──
router.get('/reconocer', (req, res) => {
  const departamento = (req.session.usuario.departamento || '').toLowerCase();
  if (departamento && departamento !== 'ayb' && !esGestorAyb(req)) {
    return res.redirect('/inicio?msg=sin_acceso');
  }
  res.render('inventario_ayb_ajustar', {
    producto: null,
    mostrarReconocer: true,
    geminiConfigurado: !!process.env.GEMINI_API_KEY,
    msg: req.query.msg || null,
  });
});

router.post('/reconocer-foto', uploadFotoBotella.single('foto'), async (req, res) => {
  const departamento = (req.session.usuario.departamento || '').toLowerCase();
  if (departamento && departamento !== 'ayb' && !esGestorAyb(req)) {
    return res.redirect('/inicio?msg=sin_acceso');
  }
  // Reconocer una botella con Gemini puede demorar bastante si hay que
  // reintentar (el servidor tiene un límite global de 20s para no dejar a
  // nadie con la pantalla colgada — ver server.js). Si ese límite salta
  // primero, ya se le mandó una respuesta al navegador; hay que chequear
  // res.headersSent antes de cada redirect de acá abajo, si no Express tira
  // "Cannot set headers after they are sent" al intentar responder dos veces.
  const redirigirSiPosible = (url) => { if (!res.headersSent) res.redirect(url); };

  if (!req.file) return redirigirSiPosible('/inventario-ayb/reconocer?msg=' + encodeURIComponent('No se recibió ninguna foto.'));

  try {
    const resultado = await analizarBotellaAyb(req.file.path, req.file.mimetype);
    fs.unlink(req.file.path, () => {});

    if (!resultado.reconocida) {
      return redirigirSiPosible('/inventario-ayb/reconocer?msg=' + encodeURIComponent(
        'No se pudo reconocer ninguna botella en esa foto. Probá con otra foto (que se vea bien la etiqueta) o buscalo a mano.'
      ));
    }

    // Nivel estimado — se manda como texto ya armado en el mensaje, para no
    // tener que sumar otra columna/sesión solo para pasar este dato de una
    // pantalla a la otra. Sin el símbolo "%" a propósito: la pantalla que
    // recibe este mensaje lo vuelve a decodificar con decodeURIComponent
    // (mismo patrón que el resto del sitio) y un "%" seguido de un
    // caracter que no forma parte de un %XX válido (como el espacio de
    // "100% (") hace que esa segunda decodificación reviente con "URI
    // malformed" — más fácil evitar el símbolo acá que tocar ese patrón
    // compartido con el resto de las pantallas del sitio.
    const nivelTexto = resultado.nivelPct !== null
      ? ` Nivel estimado: ~${resultado.nivelPct} de 100 (${resultado.nivelDescripcion}).`
      : '';

    const productos = await db.all2(`SELECT id, nombre FROM productos_ayb WHERE activo=true`);
    const conPuntaje = productos
      .map(p => ({ ...p, puntaje: puntajeSimilitud(resultado.nombre, p.nombre) }))
      .filter(p => p.puntaje > 0)
      .sort((a, b) => b.puntaje - a.puntaje);

    const mejor = conPuntaje[0];
    const segundo = conPuntaje[1];
    // Solo lo damos por matcheado si el mejor puntaje es razonablemente alto
    // Y se despega claramente del segundo candidato — si hay dos productos
    // parecidos (ej. "Fernet Branca" y "Fernet 1882") preferimos no
    // adivinar y mandar al encargado a elegir a mano antes que arriesgar
    // ajustar el stock del producto equivocado.
    if (mejor && mejor.puntaje >= 0.5 && (!segundo || mejor.puntaje - segundo.puntaje >= 0.2)) {
      // Match confiable: suma 1 unidad sola, como si hubieras escaneado esa
      // botella durante un recuento físico — no hace falta tocar Sumar ni
      // Guardar. Si la IA se confundió de producto, "Restar" 1 ahí mismo
      // corrige el error al toque (queda registrado en el historial igual
      // que cualquier otro ajuste, así que nunca se pierde el rastro).
      try {
        const { nueva } = await ajustarStock(mejor.id, 'sumar', 1, 'Reconocido por foto (IA)', req.session.usuario);
        return redirigirSiPosible(`/inventario-ayb/producto/${mejor.id}/ajustar?msg=` + encodeURIComponent(
          `La IA reconoció "${resultado.nombre}" como ${mejor.nombre} y sumó 1 sola.${nivelTexto} Stock actual: ${nueva}. Si se equivocó de producto, restá 1 acá abajo para corregir.`
        ));
      } catch (eAjuste) {
        console.error('Error sumando stock tras reconocer botella AYB:', eAjuste.message);
        return redirigirSiPosible(`/inventario-ayb/producto/${mejor.id}/ajustar?msg=` + encodeURIComponent(
          `La IA reconoció "${resultado.nombre}" como ${mejor.nombre}, pero no se pudo sumar solo al stock. Cargalo a mano acá abajo.`
        ));
      }
    }

    return redirigirSiPosible('/inventario-ayb/reconocer?msg=' + encodeURIComponent(
      `La IA reconoció "${resultado.nombre}"${nivelTexto} pero no encontró un producto igual ya cargado en el inventario. Buscalo a mano en "Ver todo el inventario" o cargalo como producto nuevo.`
    ));
  } catch (e) {
    console.error('Error reconociendo botella AYB con IA:', e.message);
    if (req.file) fs.unlink(req.file.path, () => {});
    redirigirSiPosible('/inventario-ayb/reconocer?msg=' + encodeURIComponent(mensajeErrorGemini(e)));
  }
});

// ── El resto del módulo (listado, alta/edición/borrado, etiquetas) es solo
//    para quien gestiona AYB ─────────────────────────────────────────────
router.use((req, res, next) => {
  if (!esGestorAyb(req)) return res.redirect('/horarios');
  next();
});

// ── Listado principal ─────────────────────────────────────────────
// La lista completa de productos ya no vive suelta en la pantalla (con
// muchos productos se hacía kilométrica) — ahora vive en un modal, con un
// cartel resumen arriba para abrirlo, mismo patrón que Insumos en Costos.
// Adentro, se separa por rubro (categoría) en vez de mostrar todo mezclado.
router.get('/', async (req, res) => {
  // Busca por nombre, categoría (útil para los productos importados de un
  // cierre de inventario, que traen la ubicación como categoría, ej. "210")
  // o código de barras — mismo criterio que los demás buscadores de la app
  // (insumos de Costos busca por nombre o código, Recetas por nombre o
  // categoría), no solo por nombre como antes.
  const q = (req.query.buscar || '').trim();
  const rubro = (req.query.rubro || '').trim();

  // El stock bajo y el total siempre se calculan sobre TODOS los productos
  // activos, nunca sobre lo que haya filtrado una búsqueda o un rubro — si
  // no, buscar algo específico hacía "desaparecer" productos del cartel de
  // alerta y del contador, aunque siguieran con stock bajo.
  const todosActivos = await db.all2("SELECT * FROM productos_ayb WHERE activo=true ORDER BY categoria NULLS LAST, nombre");
  const bajoStock = todosActivos.filter(p => p.stock_minimo != null && (p.stock_actual || 0) <= p.stock_minimo);
  const categoriasDisponibles = [...new Set(todosActivos.map(p => p.categoria || 'Sin categoría'))].sort((a, b) => a.localeCompare(b, 'es'));

  let productos;
  if (q) {
    productos = await db.all2(
      `SELECT * FROM productos_ayb WHERE activo=true AND (nombre ILIKE $1 OR categoria ILIKE $1 OR codigo_barras ILIKE $1) ORDER BY categoria NULLS LAST, nombre`,
      [`%${q}%`]
    );
  } else if (rubro) {
    productos = rubro === 'Sin categoría'
      ? todosActivos.filter(p => !p.categoria)
      : todosActivos.filter(p => p.categoria === rubro);
  } else {
    productos = todosActivos;
  }

  res.render('inventario_ayb', {
    productos,
    bajoStock,
    categoriasDisponibles,
    rubro,
    totalProductos: todosActivos.length,
    totalListado: productos.length,
    buscar: q,
    abrirModalLista: req.query.modal === 'productos',
    msg: req.query.msg || null,
    geminiConfigurado: !!process.env.GEMINI_API_KEY,
  });
});

// ── Alta manual de un producto ─────────────────────────────────────
router.post('/producto/nuevo', async (req, res) => {
  const nombre = (req.body.nombre || '').trim();
  if (!nombre) return res.redirect('/inventario-ayb?msg=' + encodeURIComponent('Falta el nombre del producto.'));

  try {
    await db.run2(
      `INSERT INTO productos_ayb (nombre, categoria, unidad_default, stock_minimo, stock_actual, codigo_barras)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        nombre,
        (req.body.categoria || '').trim() || null,
        (req.body.unidad_default || 'unidad').trim(),
        req.body.stock_minimo !== '' ? parseFloat(req.body.stock_minimo) : null,
        parseFloat(req.body.stock_actual) || 0,
        (req.body.codigo_barras || '').trim() || null,
      ]
    );
    res.redirect('/inventario-ayb?msg=' + encodeURIComponent('Producto agregado.'));
  } catch (e) {
    console.error('Error agregando producto de inventario AYB:', e.message);
    res.redirect('/inventario-ayb?msg=' + encodeURIComponent('Error agregando el producto: ' + e.message));
  }
});

// ── Editar datos de un producto (no la cantidad — eso es "ajustar") ──
// Arma el query string para volver a la lista de productos manteniendo el
// modal abierto en el mismo lugar donde estaba (todos / buscando / un
// rubro puntual) — mismo criterio que usa /producto/:id/ajustar.
function qsVolverListaProductos(req) {
  if (req.body.volver_lista !== '1') return '';
  const buscarActual = (req.body.buscar_actual || '').trim();
  const rubroActual = (req.body.rubro_actual || '').trim();
  if (buscarActual) return `&buscar=${encodeURIComponent(buscarActual)}`;
  if (rubroActual) return `&rubro=${encodeURIComponent(rubroActual)}`;
  return '&modal=productos';
}

router.post('/producto/:id/editar', async (req, res) => {
  const qs = qsVolverListaProductos(req);
  try {
    await db.run2(
      `UPDATE productos_ayb SET nombre=$1, categoria=$2, unidad_default=$3, stock_minimo=$4, codigo_barras=$5 WHERE id=$6`,
      [
        (req.body.nombre || '').trim(),
        (req.body.categoria || '').trim() || null,
        (req.body.unidad_default || 'unidad').trim(),
        req.body.stock_minimo !== '' ? parseFloat(req.body.stock_minimo) : null,
        (req.body.codigo_barras || '').trim() || null,
        req.params.id,
      ]
    );
    res.redirect('/inventario-ayb?msg=' + encodeURIComponent('Producto actualizado.') + qs);
  } catch (e) {
    console.error('Error editando producto de inventario AYB:', e.message);
    res.redirect('/inventario-ayb?msg=' + encodeURIComponent('Error actualizando el producto: ' + e.message) + qs);
  }
});

// ── Dar de baja un producto (soft delete — no se borra el historial) ──
router.post('/producto/:id/eliminar', async (req, res) => {
  const qs = qsVolverListaProductos(req);
  try {
    await db.run2(`UPDATE productos_ayb SET activo=false WHERE id=$1`, [req.params.id]);
    res.redirect('/inventario-ayb?msg=' + encodeURIComponent('Producto dado de baja.') + qs);
  } catch (e) {
    console.error('Error dando de baja producto de inventario AYB:', e.message);
    res.redirect('/inventario-ayb?msg=' + encodeURIComponent('Error: ' + e.message) + qs);
  }
});

// ── Importación masiva de productos (Excel/CSV) ─────────────────────
// Pensada para la carga inicial cuando hay "un montón" de productos: no
// pisa nada que ya exista (matchea por nombre, sin acentos/mayúsculas), solo
// agrega los que faltan. El stock de los que se crean arranca en 0 — el
// mínimo se toma del archivo si lo trae, si no queda vacío para cargarlo
// después a mano.
router.get('/importar/plantilla', async (req, res) => {
  const wb = await generarPlantillaProductosAyb();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=plantilla_productos_ayb.xlsx');
  await wb.xlsx.write(res);
  res.end();
});

router.post('/importar', uploadProductosAyb.single('archivo_productos'), async (req, res) => {
  if (!req.file) return res.redirect('/inventario-ayb?msg=' + encodeURIComponent('No se recibió ningún archivo.'));

  try {
    const { filas, hojasOmitidas } = await parsearArchivoProductosAyb(req.file.path, req.file.originalname);
    const resumen = await importarProductosAyb(filas, db);
    resumen.hojasOmitidas = hojasOmitidas;
    req.session.importacionProductosAybResumen = resumen;
    res.redirect('/inventario-ayb/importar/resultado');
  } catch (e) {
    console.error('Error importando productos de Inventario AYB:', e.message);
    res.redirect('/inventario-ayb?msg=' + encodeURIComponent('Error importando el archivo: ' + e.message));
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

router.get('/importar/resultado', async (req, res) => {
  const resumen = req.session.importacionProductosAybResumen || null;
  res.render('inventario_ayb_importar_resultado', { resumen });
});

// ── Reporte de consumo, por mes ─────────────────────────────────────
// Usa el historial que ya se venía guardando en cada ajuste (tabla
// inventario_ayb_movimientos) — no hace falta cargar nada nuevo, esto
// solo lo lee y lo agrupa. "Consumido" = todo lo restado (tipo='restar');
// "Repuesto" = todo lo sumado (tipo='sumar', ej. llegó mercadería nueva);
// "Corrección" = el neto de los ajustes por "Fijar" (tipo='establecer',
// ej. un recuento manual que no coincidía) — se muestra aparte porque no
// es ni una venta ni una compra, es un ajuste de lo que había cargado.
router.get('/reportes', async (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
  const [anio, mesNum] = mes.split('-').map(Number);
  const desde = `${mes}-01`;
  const finExclusivo = mesNum === 12 ? `${anio + 1}-01-01` : `${anio}-${String(mesNum + 1).padStart(2, '0')}-01`;

  try {
    const filas = await db.all2(`
      SELECT p.id, p.nombre, p.categoria, p.unidad_default,
        COALESCE(SUM(m.cantidad) FILTER (WHERE m.tipo = 'restar'), 0) AS consumido,
        COALESCE(SUM(m.cantidad) FILTER (WHERE m.tipo = 'sumar'), 0) AS repuesto,
        COALESCE(SUM(m.cantidad_nueva - m.cantidad_anterior) FILTER (WHERE m.tipo = 'establecer'), 0) AS correccion_neta,
        COUNT(m.id)::int AS movimientos
      FROM inventario_ayb_movimientos m
      JOIN productos_ayb p ON p.id = m.producto_id
      WHERE m.creado_en >= $1 AND m.creado_en < $2
      GROUP BY p.id, p.nombre, p.categoria, p.unidad_default
      ORDER BY consumido DESC, p.nombre
    `, [desde, finExclusivo]);

    const totales = filas.reduce((acc, f) => ({
      consumido: acc.consumido + Number(f.consumido),
      repuesto: acc.repuesto + Number(f.repuesto),
      movimientos: acc.movimientos + f.movimientos,
    }), { consumido: 0, repuesto: 0, movimientos: 0 });

    const mesAnterior = mesNum === 1 ? `${anio - 1}-12` : `${anio}-${String(mesNum - 1).padStart(2, '0')}`;
    const mesSiguiente = mesNum === 12 ? `${anio + 1}-01` : `${anio}-${String(mesNum + 1).padStart(2, '0')}`;
    const hoyYYYYMM = new Date().toISOString().slice(0, 7);

    res.render('inventario_ayb_reportes', {
      filas, totales, mes, mesAnterior, mesSiguiente,
      esMesActual: mes === hoyYYYYMM,
    });
  } catch (e) {
    console.error('Error generando reporte de consumo de Inventario AYB:', e.message);
    res.render('inventario_ayb_reportes', {
      filas: [], totales: { consumido: 0, repuesto: 0, movimientos: 0 },
      mes, mesAnterior: mes, mesSiguiente: mes, esMesActual: true,
      error: 'No se pudo generar el reporte: ' + e.message,
    });
  }
});

// ── Necesidad semanal: arma sola la lista de qué conviene pedir ─────
// No es un pedido formal ni se conecta con Compras (todavía no existe nada
// de eso en el sistema) — es una lista sugerida, para llevarle al
// proveedor, calculada solo con datos que ya se vienen cargando en cada
// ajuste de stock (inventario_ayb_movimientos), sin que haga falta cargar
// nada nuevo a mano.
//
// Por producto: cuánto se consumió en promedio por semana en las últimas
// 4 semanas (consumo_semanal), y cuánto falta para volver a estar en el
// mínimo (stock_minimo - stock_actual, nunca negativo). La cantidad
// sugerida es la suma de las dos cosas: lo que falta para el mínimo, más
// lo que se espera consumir en la semana que viene — así no solo se cubre
// el faltante actual sino que no se vuelve a quedar corto enseguida.
// Un producto sin stock_minimo cargado igual entra si tuvo consumo (se
// pide para cubrir la semana que viene), pero sin el término de faltante.
async function calcularNecesidadSemanal() {
  const filas = await db.all2(`
    SELECT p.id, p.nombre, p.categoria, p.unidad_default, p.stock_actual, p.stock_minimo,
      COALESCE(SUM(m.cantidad) FILTER (WHERE m.tipo = 'restar' AND m.creado_en >= NOW() - INTERVAL '28 days'), 0) AS consumido_28d
    FROM productos_ayb p
    LEFT JOIN inventario_ayb_movimientos m ON m.producto_id = p.id
    WHERE p.activo = true
    GROUP BY p.id, p.nombre, p.categoria, p.unidad_default, p.stock_actual, p.stock_minimo
  `);

  return filas
    .map(f => {
      const stockActual = Number(f.stock_actual) || 0;
      const stockMinimo = f.stock_minimo != null ? Number(f.stock_minimo) : null;
      const consumoSemanal = Number(f.consumido_28d) / 4;
      const faltanteParaMinimo = stockMinimo != null ? Math.max(0, stockMinimo - stockActual) : 0;
      const cantidadSugerida = Math.round((faltanteParaMinimo + consumoSemanal) * 10) / 10;
      return {
        id: f.id, nombre: f.nombre, categoria: f.categoria, unidad: f.unidad_default,
        stockActual, stockMinimo, consumoSemanal: Math.round(consumoSemanal * 10) / 10,
        cantidadSugerida,
        urgente: stockMinimo != null && stockActual <= stockMinimo,
      };
    })
    .filter(f => f.cantidadSugerida > 0.05)
    .sort((a, b) => (b.urgente - a.urgente) || (b.cantidadSugerida - a.cantidadSugerida));
}

router.get('/necesidad-semanal', async (req, res) => {
  try {
    const necesidad = await calcularNecesidadSemanal();
    res.render('inventario_ayb_necesidad', { necesidad });
  } catch (e) {
    console.error('Error calculando necesidad semanal de Inventario AYB:', e.message);
    res.render('inventario_ayb_necesidad', { necesidad: [], error: 'No se pudo calcular la necesidad semanal: ' + e.message });
  }
});

router.get('/necesidad-semanal/excel', async (req, res) => {
  const necesidad = await calcularNecesidadSemanal();

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Necesidad semanal');

  ws.mergeCells('A1:F1');
  const titulo = ws.getCell('A1');
  titulo.value = `NECESIDAD SEMANAL — INVENTARIO AYB — generado ${new Date().toLocaleDateString('es-AR')}`;
  titulo.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  titulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  titulo.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  const encRow = ws.addRow(['Producto', 'Categoría', 'Stock actual', 'Mínimo', 'Consumo semanal (prom.)', 'Cantidad sugerida']);
  encRow.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  necesidad.forEach(f => {
    const row = ws.addRow([
      f.nombre, f.categoria || '', f.stockActual, f.stockMinimo != null ? f.stockMinimo : '',
      f.consumoSemanal, f.cantidadSugerida,
    ]);
    row.eachCell((c, col) => {
      c.font = { size: 10, bold: col === 6 };
      c.alignment = { horizontal: col === 1 || col === 2 ? 'left' : 'center', vertical: 'middle' };
    });
    if (f.urgente) row.getCell(6).font = { size: 10, bold: true, color: { argb: 'FFDC2626' } };
  });

  ws.columns = [{ width: 28 }, { width: 18 }, { width: 13 }, { width: 11 }, { width: 20 }, { width: 18 }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=necesidad_semanal_ayb.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

// ── Etiquetas QR para imprimir/pegar en cada producto ──────────────
router.get('/etiquetas', async (req, res) => {
  const productos = await db.all2(`SELECT * FROM productos_ayb WHERE activo=true ORDER BY categoria NULLS LAST, nombre`);
  // Se arma acá (no en la vista) para no repetir la lógica de la URL en cada
  // <img>, y para que quede claro que depende de tener uno de estos dos
  // headers disponible al momento de generar la página.
  const origen = `${req.protocol}://${req.get('host')}`;
  res.render('inventario_ayb_etiquetas', { productos, origen });
});

module.exports = router;
