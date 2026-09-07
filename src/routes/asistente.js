const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');
const { horasDelMes } = require('../services/horasTrabajadas');
// Reutilizamos la misma función que ya usa la pantalla de Costos para el
// modal de "Variación de precios" — así el bot informa exactamente lo mismo
// que ve el usuario ahí, sin inventar ni recalcular nada por su cuenta.
const { calcularVariacionPrecios } = require('./costos');
// Mismo reintento con backoff (3 intentos, 45s de timeout por intento) que
// ya usa "Reconocer con foto" — el bug real detrás del "No entendí bien"
// no era el nombre del modelo (ese ya estaba bien) sino que acá no había
// NINGÚN reintento: apenas Gemini devolvía un 503 de "alta demanda"
// (algo transitorio y esperable, confirmado en el log real del servidor
// de Maxi) el chatbot se rendía en el primer intento.
const { llamarGeminiConReintentos } = require('../services/gemini');
// Misma lista de sectores de Cocina que ya usan Miembro de equipo y Horas
// extra — para que el chatbot busque empleados de Cocina con el mismo
// criterio exacto, en vez de reinventar el filtro por su cuenta.
const { SECTORES: SECTORES_COCINA } = require('./personal');

// Alias en vez de una versión fija — mismo criterio que src/services/gemini.js
// (ver el comentario ahí): un nombre de versión puntual como "gemini-2.5-flash"
// deja de existir en algún momento y todas las llamadas empiezan a fallar en
// silencio (Gemini devuelve un error, no candidates, y el bot cae siempre al
// mensaje genérico "No entendí bien"). "gemini-flash-latest" apunta siempre
// a la versión flash vigente.
const MODELO = 'gemini-flash-latest';
const URL_GEMINI = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;

// ── Definición de herramientas que el asistente puede usar ──────────────
const HERRAMIENTAS = [{
  functionDeclarations: [
    {
      name: 'consultar_insumos_sin_precio',
      description: 'Devuelve la lista de insumos que todavía no tienen precio unitario cargado.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'consultar_horario',
      description: 'Devuelve qué empleados trabajan (y sus estados: RECOFF, VAC, LIBRE, etc.) en una fecha determinada, opcionalmente filtrando por sector.',
      parameters: {
        type: 'OBJECT',
        properties: {
          fecha: { type: 'STRING', description: 'Fecha exacta en formato YYYY-MM-DD' },
          sector: { type: 'STRING', description: 'Nombre del sector para filtrar (opcional), ej: Panadería' },
        },
        required: ['fecha'],
      },
    },
    {
      name: 'consultar_horas_trabajadas',
      description: 'Devuelve cuántas horas trabajó un empleado en un mes determinado (sumando sus eventos AYB con asistencia confirmada, o sus horarios cargados en Cocina). Útil para informes de horas y para ayudar a decidir a quién asignarle un evento.',
      parameters: {
        type: 'OBJECT',
        properties: {
          nombre_empleado: { type: 'STRING', description: 'Nombre (o parte del nombre) del empleado' },
          mes: { type: 'STRING', description: 'Mes a consultar en formato YYYY-MM. Si no lo dice, usar el mes actual.' },
        },
        required: ['nombre_empleado'],
      },
    },
    {
      name: 'consultar_variacion_precios',
      description: 'Devuelve qué insumos subieron o bajaron de precio (y en qué porcentaje) en un período reciente, usando el historial de cambios de precio real de la aplicación. Útil para preguntas como "qué precios aumentaron", "cuál fue el mayor aumento", "mostrame los aumentos superiores a X%".',
      parameters: {
        type: 'OBJECT',
        properties: {
          dias: { type: 'NUMBER', description: 'Cantidad de días hacia atrás a considerar. Si no lo dice, usar 7.' },
          tipo: { type: 'STRING', description: 'Uno de: "subieron" (default), "bajaron" o "iguales" (se mantuvieron).' },
          porcentaje_minimo: { type: 'NUMBER', description: 'Si el usuario pide un piso (ej. "superiores al 20%"), filtrar solo variaciones con ese % o más en valor absoluto. Opcional.' },
        },
        required: [],
      },
    },
    {
      name: 'consultar_recetas_por_insumo',
      description: 'Dado el nombre de un insumo/ingrediente, devuelve qué recetas/platos lo usan y su costo total actual. Útil para preguntas como "qué recetas usan el pollo" o "qué platos se ven afectados si sube tal ingrediente".',
      parameters: {
        type: 'OBJECT',
        properties: {
          nombre_insumo: { type: 'STRING', description: 'Nombre (o parte del nombre) del insumo' },
        },
        required: ['nombre_insumo'],
      },
    },
    {
      name: 'consultar_insumos_mas_usados',
      description: 'Devuelve un ranking de los insumos que se usan en más platos del costeo (Costos → Platos). Útil para preguntas como "cuál es el producto que más se usa", "qué insumo aparece en más platos", "el ingrediente más usado en costeo de platos".',
      parameters: {
        type: 'OBJECT',
        properties: {
          limite: { type: 'NUMBER', description: 'Cantidad de insumos a devolver en el ranking. Si no lo dice, usar 10.' },
        },
        required: [],
      },
    },
    {
      name: 'consultar_stock_ayb',
      description: 'Devuelve el stock actual de productos del Inventario de Alimentos y Bebidas (botellas/bebidas), como "cuántas botellas de Sidra hay", "qué stock tiene el Fernet", o "qué productos están por debajo del stock mínimo". Si no se pasa nombre_producto, devuelve todos los productos activos.',
      parameters: {
        type: 'OBJECT',
        properties: {
          nombre_producto: { type: 'STRING', description: 'Nombre (o parte del nombre) del producto a buscar. Opcional — si no lo dice, traer todos.' },
          solo_bajo_stock: { type: 'BOOLEAN', description: 'true si el usuario pregunta específicamente por productos con stock bajo/por debajo del mínimo. Default false.' },
        },
        required: [],
      },
    },
    {
      name: 'consultar_horas_extra',
      description: 'Solo para administradores. Devuelve las horas extra cargadas de un empleado de Cocina en un mes (o, si no se especifica empleado, el ranking de todos los que tienen horas extra cargadas ese mes). Útil para preguntas como "cuántas horas extra tiene Juan este mes" o "quién tiene más horas extra cargadas".',
      parameters: {
        type: 'OBJECT',
        properties: {
          nombre_empleado: { type: 'STRING', description: 'Nombre (o parte del nombre) del empleado de Cocina. Opcional — si no lo dice, traer el ranking de todos.' },
          mes: { type: 'STRING', description: 'Mes a consultar en formato YYYY-MM. Si no lo dice, usar el mes actual.' },
        },
        required: [],
      },
    },
    {
      name: 'cargar_horas_extra',
      description: 'Solo para administradores. ACCIÓN que modifica datos reales: carga un registro de horas extra para un empleado de Cocina en una fecha puntual. Requiere confirmación del usuario antes de aplicarse.',
      parameters: {
        type: 'OBJECT',
        properties: {
          nombre_empleado: { type: 'STRING', description: 'Nombre (o parte del nombre) del empleado de Cocina' },
          fecha: { type: 'STRING', description: 'Fecha exacta en formato YYYY-MM-DD' },
          horas: { type: 'NUMBER', description: 'Cantidad de horas extra a cargar' },
          nota: { type: 'STRING', description: 'Nota opcional, ej: "cubrió un evento"' },
        },
        required: ['nombre_empleado', 'fecha', 'horas'],
      },
    },
    {
      name: 'actualizar_precio_insumo',
      description: 'ACCIÓN que modifica datos reales: actualiza el precio unitario de un insumo existente. Requiere confirmación del usuario antes de aplicarse.',
      parameters: {
        type: 'OBJECT',
        properties: {
          nombre_insumo: { type: 'STRING', description: 'Nombre (o parte del nombre) del insumo a actualizar' },
          precio_nuevo: { type: 'NUMBER', description: 'Nuevo precio unitario en pesos' },
        },
        required: ['nombre_insumo', 'precio_nuevo'],
      },
    },
    {
      name: 'asignar_recoff',
      description: 'ACCIÓN que modifica datos reales: le pone el estado RECOFF a un empleado en una fecha puntual. Requiere confirmación del usuario antes de aplicarse.',
      parameters: {
        type: 'OBJECT',
        properties: {
          nombre_empleado: { type: 'STRING', description: 'Nombre (o parte del nombre) del empleado' },
          fecha: { type: 'STRING', description: 'Fecha exacta en formato YYYY-MM-DD' },
        },
        required: ['nombre_empleado', 'fecha'],
      },
    },
    {
      name: 'quitar_recoff',
      description: 'ACCIÓN que modifica datos reales: saca el estado RECOFF de un empleado en una fecha, dejando ese día en blanco/Normal. Requiere confirmación del usuario antes de aplicarse.',
      parameters: {
        type: 'OBJECT',
        properties: {
          nombre_empleado: { type: 'STRING', description: 'Nombre (o parte del nombre) del empleado' },
          fecha: { type: 'STRING', description: 'Fecha exacta en formato YYYY-MM-DD' },
        },
        required: ['nombre_empleado', 'fecha'],
      },
    },
  ],
}];

const HERRAMIENTAS_DE_ACCION = ['actualizar_precio_insumo', 'asignar_recoff', 'quitar_recoff', 'cargar_horas_extra'];

// Igual que la pantalla de Horas extra (soloAdmin en horasExtra.js): es
// información pensada para liquidar sueldos, no algo que cualquiera que
// abra el chat deba poder consultar o cargar.
const HERRAMIENTAS_SOLO_ADMIN = ['consultar_horas_extra', 'cargar_horas_extra'];
function esAdminSesion(req) {
  return (req.session.usuario?.rol || '').toLowerCase() === 'admin';
}

// Resumen de las novedades del sistema agregadas en los últimos días — así
// el asistente puede responder directo si alguien pregunta "qué cambió"
// o "qué hay nuevo", sin necesitar una herramienta ni una tabla de cambios
// en la base de datos (no existe ninguna, esto es texto fijo que hay que
// actualizar a mano cuando se agreguen novedades importantes).
const NOVEDADES_RECIENTES = `
Novedades recientes del sistema (por si el usuario pregunta "qué cambió", "qué hay nuevo" o similar):
- Nuevo módulo "Inventario" (Alimentos y Bebidas): permite ajustar el stock de bebidas a mano (Sumar/Restar/Fijar), o sacándole una foto a la botella para que la IA la reconozca y sume 1 unidad sola. Cada producto tiene una etiqueta QR imprimible para hacer el ajuste rápido desde el celular, escaneándola en el bar.
- Dentro de Inventario hay una sección "Reportes de consumo": muestra mes a mes, por producto, cuánto se consumió, cuánto se repuso y las correcciones manuales (Fijar), usando el historial real de movimientos.
- El sistema avisa automáticamente cuando algún producto de Inventario está por debajo del stock mínimo cargado (se muestra como alerta acá mismo, en este chat, y también como aviso en la pantalla de Inventario).
- En Miembro de equipo (Alimentos y Bebidas) las opciones secundarias (Ver en Horarios, Importar mozos por CSV, Cargar con foto) ahora están agrupadas en un botón "Otras opciones", igual que ya funcionaba en Horarios.
- La sección que antes decía "Eventos de Alimentos y Bebidas" ahora se llama simplemente "Horarios".
- Nuevo módulo "Horas extra" (Cocina, solo admin): permite cargar las horas extra de cada empleado por fecha puntual, con nota opcional, y ver el informe acumulado por persona en el mes.
`;

const SYSTEM_PROMPT = `Sos el asistente virtual interno del Portal Hilton Buenos Aires, para el equipo de cocina y alimentos y bebidas.
Respondé siempre en español, de forma breve, clara y amable. Hoy es ${new Date().toISOString().slice(0, 10)}.
Cuando el usuario pida algo que corresponda a una de tus herramientas, usala. Si falta un dato imprescindible (ej. no dijo la fecha), preguntá antes de usar la herramienta.
Nunca inventes datos: si una consulta no devuelve resultados, decilo tal cual.
${NOVEDADES_RECIENTES}`;

// ── Ejecuta las herramientas de solo consulta ────────────────────────────
async function ejecutarConsulta(nombre, args) {
  if (nombre === 'consultar_insumos_sin_precio') {
    const rows = await db.all2(`
      SELECT nombre, categoria FROM insumos
      WHERE precio_unitario IS NULL OR precio_unitario = 0
      ORDER BY categoria, nombre LIMIT 40
    `);
    return { total: rows.length, insumos: rows.map(r => r.nombre) };
  }

  if (nombre === 'consultar_horario') {
    const params = [args.fecha];
    let filtroSector = '';
    if (args.sector) { filtroSector = 'AND u.departamento ILIKE $2'; params.push(`%${args.sector}%`); }
    const rows = await db.all2(`
      SELECT u.nombre, u.departamento, h.valor
      FROM usuarios u
      LEFT JOIN horarios_semanales h ON h.usuario_id = u.id AND h.fecha = $1
      WHERE u.activo = 1 ${filtroSector}
      ORDER BY u.departamento, u.nombre
    `, params);
    return {
      fecha: args.fecha,
      empleados: rows.map(r => ({ nombre: r.nombre, sector: r.departamento, estado: r.valor || 'Normal' })),
    };
  }

  if (nombre === 'consultar_horas_trabajadas') {
    const candidatos = await buscarEmpleadoPorNombre(args.nombre_empleado);
    if (candidatos.length === 0) return { error: `No encontré ningún empleado que coincida con "${args.nombre_empleado}".` };
    if (candidatos.length > 1) return { error: `Encontré varios empleados que coinciden con "${args.nombre_empleado}": ${candidatos.map(c => c.nombre).join(', ')}. Decime cuál exactamente.` };
    const emp = candidatos[0];
    const mes = /^\d{4}-\d{2}$/.test(args.mes || '') ? args.mes : new Date().toISOString().slice(0, 7);
    const resultado = await horasDelMes(emp.id, emp.departamento, mes);
    return {
      empleado: emp.nombre,
      mes,
      horas_trabajadas: resultado.horas,
      dias_trabajados: resultado.dias,
      eventos_trabajados: resultado.eventos,
    };
  }

  if (nombre === 'consultar_variacion_precios') {
    const dias = [7, 14, 21, 28].includes(Number(args.dias)) ? Number(args.dias) : 7;
    const tipo = ['subieron', 'bajaron', 'iguales'].includes(args.tipo) ? args.tipo : 'subieron';
    let filas = await calcularVariacionPrecios(dias, tipo, 20);
    if (args.porcentaje_minimo != null && !isNaN(Number(args.porcentaje_minimo))) {
      const piso = Number(args.porcentaje_minimo);
      filas = filas.filter(f => Math.abs(f.variacion_pct) >= piso);
    }
    return {
      dias, tipo, total: filas.length,
      insumos: filas.map(f => ({
        nombre: f.nombre, precio_antes: f.precio_inicio, precio_actual: f.precio_actual,
        variacion_pct: f.variacion_pct, variacion_abs: f.variacion_abs,
      })),
    };
  }

  if (nombre === 'consultar_recetas_por_insumo') {
    const insumos = await buscarInsumoPorNombre(args.nombre_insumo);
    if (insumos.length === 0) return { error: `No encontré ningún insumo que coincida con "${args.nombre_insumo}".` };
    if (insumos.length > 1) return { error: `Encontré varios insumos que coinciden con "${args.nombre_insumo}": ${insumos.map(c => c.nombre).join(', ')}. Decime cuál exactamente.` };
    const insumo = insumos[0];
    const recetas = await db.all2(`
      SELECT p.nombre, p.costo_total, pi.cantidad, pi.unidad
      FROM plato_insumos pi JOIN platos_costo p ON p.id = pi.plato_id
      WHERE pi.insumo_id = $1 ORDER BY p.nombre
    `, [insumo.id]);
    return {
      insumo: insumo.nombre, precio_actual: insumo.precio_unitario,
      total_recetas: recetas.length,
      recetas: recetas.map(r => ({ nombre: r.nombre, costo_total_actual: r.costo_total, cantidad_usada: r.cantidad, unidad: r.unidad })),
    };
  }

  if (nombre === 'consultar_insumos_mas_usados') {
    const limite = Number.isInteger(Number(args.limite)) && Number(args.limite) > 0
      ? Math.min(Number(args.limite), 30) : 10;
    const rows = await db.all2(`
      SELECT i.nombre, i.precio_unitario,
             COUNT(DISTINCT pi.plato_id)::int AS cantidad_platos,
             SUM(pi.costo_parcial)::numeric AS costo_total_en_platos
      FROM plato_insumos pi JOIN insumos i ON i.id = pi.insumo_id
      GROUP BY i.nombre, i.precio_unitario
      ORDER BY cantidad_platos DESC, costo_total_en_platos DESC
      LIMIT $1
    `, [limite]);
    return {
      total: rows.length,
      ranking: rows.map(r => ({
        insumo: r.nombre,
        precio_actual: r.precio_unitario,
        cantidad_platos_que_lo_usan: r.cantidad_platos,
        costo_total_que_representa_en_esos_platos: r.costo_total_en_platos,
      })),
    };
  }

  if (nombre === 'consultar_stock_ayb') {
    const params = [];
    let filtroNombre = '';
    if (args.nombre_producto) { filtroNombre = 'AND nombre ILIKE $1'; params.push(`%${args.nombre_producto}%`); }
    const rows = await db.all2(`
      SELECT nombre, categoria, unidad_default, stock_actual, stock_minimo
      FROM productos_ayb
      WHERE activo=true ${filtroNombre}
      ORDER BY categoria NULLS LAST, nombre
      LIMIT 40
    `, params);
    let filas = rows;
    if (args.solo_bajo_stock) {
      filas = filas.filter(r => r.stock_minimo != null && (r.stock_actual || 0) <= r.stock_minimo);
    }
    if (filas.length === 0) {
      return { total: 0, mensaje: args.nombre_producto ? `No encontré ningún producto de Inventario AYB que coincida con "${args.nombre_producto}".` : 'No hay productos que cumplan ese filtro.' };
    }
    return {
      total: filas.length,
      productos: filas.map(r => ({
        nombre: r.nombre, categoria: r.categoria, unidad: r.unidad_default,
        stock_actual: r.stock_actual || 0, stock_minimo: r.stock_minimo,
        bajo_stock: r.stock_minimo != null && (r.stock_actual || 0) <= r.stock_minimo,
      })),
    };
  }

  if (nombre === 'consultar_horas_extra') {
    const mes = /^\d{4}-\d{2}$/.test(args.mes || '') ? args.mes : new Date().toISOString().slice(0, 7);

    if (args.nombre_empleado) {
      const candidatos = await buscarEmpleadoCocinaPorNombre(args.nombre_empleado);
      if (candidatos.length === 0) return { error: `No encontré ningún empleado de Cocina que coincida con "${args.nombre_empleado}".` };
      if (candidatos.length > 1) return { error: `Encontré varios empleados que coinciden con "${args.nombre_empleado}": ${candidatos.map(c => c.nombre).join(', ')}. Decime cuál exactamente.` };
      const emp = candidatos[0];
      const registros = await db.all2(`
        SELECT fecha::text AS fecha, horas, nota FROM horas_extra
        WHERE usuario_id=$1 AND to_char(fecha,'YYYY-MM')=$2
        ORDER BY fecha
      `, [emp.id, mes]);
      const total = registros.reduce((n, r) => n + Number(r.horas), 0);
      return {
        empleado: emp.nombre, mes,
        horas_extra_totales: Math.round(total * 10) / 10,
        registros: registros.map(r => ({ fecha: r.fecha, horas: Number(r.horas), nota: r.nota || null })),
      };
    }

    // Sin empleado puntual: ranking de todos los de Cocina ese mes.
    const rows = await db.all2(`
      SELECT u.nombre, SUM(h.horas)::numeric AS total, COUNT(*)::int AS registros
      FROM horas_extra h JOIN usuarios u ON u.id = h.usuario_id
      WHERE to_char(h.fecha,'YYYY-MM')=$1
      GROUP BY u.nombre
      ORDER BY total DESC
      LIMIT 20
    `, [mes]);
    if (rows.length === 0) return { mes, mensaje: 'No hay horas extra cargadas ese mes.' };
    return {
      mes,
      ranking: rows.map(r => ({ empleado: r.nombre, horas_extra_totales: Math.round(Number(r.total) * 10) / 10, registros: r.registros })),
    };
  }

  return { error: 'Herramienta de consulta desconocida' };
}

// Busca un insumo o empleado por nombre aproximado. Devuelve null si no hay match único.
async function buscarInsumoPorNombre(texto) {
  const rows = await db.all2(`SELECT id, nombre, precio_unitario FROM insumos WHERE nombre ILIKE $1 LIMIT 5`, [`%${texto}%`]);
  return rows;
}
async function buscarEmpleadoPorNombre(texto) {
  const rows = await db.all2(`SELECT id, nombre, departamento FROM usuarios WHERE nombre ILIKE $1 AND activo=1 LIMIT 5`, [`%${texto}%`]);
  return rows;
}
// Igual que buscarEmpleadoPorNombre, pero acotado a empleados de Cocina
// (por sector, no por la palabra "cocina" — ver el mismo comentario en
// horasExtra.js) y sin cuentas admin — mismo criterio que usa la pantalla
// de Horas extra, para que el chatbot encuentre exactamente a la misma
// gente que ves ahí.
async function buscarEmpleadoCocinaPorNombre(texto) {
  const rows = await db.all2(`
    SELECT id, nombre FROM usuarios
    WHERE nombre ILIKE $1 AND activo=1 AND departamento = ANY($2) AND LOWER(rol) != 'admin'
    LIMIT 5
  `, [`%${texto}%`, SECTORES_COCINA]);
  return rows;
}

// ── Arma el texto de confirmación + guarda la acción pendiente en sesión ──
async function prepararAccion(req, nombre, args) {
  if (nombre === 'actualizar_precio_insumo') {
    const candidatos = await buscarInsumoPorNombre(args.nombre_insumo);
    if (candidatos.length === 0) return { error: `No encontré ningún insumo que coincida con "${args.nombre_insumo}".` };
    if (candidatos.length > 1) return { error: `Encontré varios insumos que coinciden con "${args.nombre_insumo}": ${candidatos.map(c => c.nombre).join(', ')}. Decime cuál exactamente.` };
    const insumo = candidatos[0];
    req.session.accionPendiente = { tipo: nombre, insumo_id: insumo.id };
    return { confirmacion: `¿Confirmás que actualizo el precio de "${insumo.nombre}" a $${Number(args.precio_nuevo).toFixed(2)}? (Precio actual: $${Number(insumo.precio_unitario || 0).toFixed(2)})`, valorNuevo: args.precio_nuevo };
  }

  if (nombre === 'asignar_recoff' || nombre === 'quitar_recoff') {
    const candidatos = await buscarEmpleadoPorNombre(args.nombre_empleado);
    if (candidatos.length === 0) return { error: `No encontré ningún empleado que coincida con "${args.nombre_empleado}".` };
    if (candidatos.length > 1) return { error: `Encontré varios empleados que coinciden con "${args.nombre_empleado}": ${candidatos.map(c => c.nombre).join(', ')}. Decime cuál exactamente.` };
    const emp = candidatos[0];
    req.session.accionPendiente = { tipo: nombre, usuario_id: emp.id, fecha: args.fecha };
    const accionTexto = nombre === 'asignar_recoff' ? `ponerle RECOFF a` : `sacarle el RECOFF a`;
    return { confirmacion: `¿Confirmás que le ${accionTexto === 'ponerle RECOFF a' ? 'pongo RECOFF a' : 'saco el RECOFF a'} ${emp.nombre} el ${args.fecha}?` };
  }

  if (nombre === 'cargar_horas_extra') {
    const candidatos = await buscarEmpleadoCocinaPorNombre(args.nombre_empleado);
    if (candidatos.length === 0) return { error: `No encontré ningún empleado de Cocina que coincida con "${args.nombre_empleado}".` };
    if (candidatos.length > 1) return { error: `Encontré varios empleados que coinciden con "${args.nombre_empleado}": ${candidatos.map(c => c.nombre).join(', ')}. Decime cuál exactamente.` };
    const horas = Number(args.horas);
    if (!horas || horas <= 0 || horas > 24 || !/^\d{4}-\d{2}-\d{2}$/.test(args.fecha || '')) {
      return { error: 'Revisá la fecha o la cantidad de horas — no me quedó un dato válido para cargar.' };
    }
    const emp = candidatos[0];
    req.session.accionPendiente = { tipo: nombre, usuario_id: emp.id, fecha: args.fecha, horas, nota: args.nota || null };
    return { confirmacion: `¿Confirmás que cargo ${horas}hs extra para ${emp.nombre} el ${args.fecha}${args.nota ? ` (nota: "${args.nota}")` : ''}?` };
  }

  return { error: 'Acción desconocida' };
}

// ── Ejecuta la acción ya confirmada, guardada en sesión ──────────────────
async function ejecutarAccionPendiente(req) {
  const accion = req.session.accionPendiente;
  if (!accion) return 'No tengo ninguna acción pendiente para confirmar.';

  if (accion.tipo === 'actualizar_precio_insumo') {
    await db.run2(`UPDATE insumos SET precio_unitario=$1, actualizado_en=NOW() WHERE id=$2`, [accion.valorNuevo, accion.insumo_id]);
    delete req.session.accionPendiente;
    return 'Listo, actualicé el precio. ✓';
  }

  if (accion.tipo === 'asignar_recoff') {
    await db.run2(`
      INSERT INTO horarios_semanales (usuario_id, fecha, valor) VALUES ($1,$2,'RECOFF')
      ON CONFLICT (usuario_id, fecha) DO UPDATE SET valor='RECOFF'
    `, [accion.usuario_id, accion.fecha]);
    delete req.session.accionPendiente;
    return 'Listo, le asigné RECOFF ese día. ✓';
  }

  if (accion.tipo === 'quitar_recoff') {
    await db.run2(`DELETE FROM horarios_semanales WHERE usuario_id=$1 AND fecha=$2`, [accion.usuario_id, accion.fecha]);
    delete req.session.accionPendiente;
    return 'Listo, saqué el RECOFF de ese día. ✓';
  }

  if (accion.tipo === 'cargar_horas_extra') {
    await db.run2(`
      INSERT INTO horas_extra (usuario_id, fecha, horas, nota, creado_por, creado_por_nombre)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [accion.usuario_id, accion.fecha, accion.horas, accion.nota, req.session.usuario.id, req.session.usuario.nombre]);
    delete req.session.accionPendiente;
    return 'Listo, cargué las horas extra. ✓';
  }

  delete req.session.accionPendiente;
  return 'No supe cómo aplicar esa acción.';
}

function esAfirmativo(msg) {
  return /^(si|sí|dale|confirmo|confirmar|ok|listo|s)$/i.test(msg.trim());
}
function esNegativo(msg) {
  return /^(no|cancelar|cancela|nop)$/i.test(msg.trim());
}

router.post('/mensaje', loginRequerido, async (req, res) => {
  const mensaje = (req.body.mensaje || '').trim();
  if (!mensaje) return res.json({ ok: false, error: 'Mensaje vacío' });

  try {
    // Si hay una acción pendiente de confirmar, resolvemos eso primero
    if (req.session.accionPendiente) {
      if (esAfirmativo(mensaje)) {
        const texto = await ejecutarAccionPendiente(req);
        return res.json({ ok: true, texto });
      }
      if (esNegativo(mensaje)) {
        delete req.session.accionPendiente;
        return res.json({ ok: true, texto: 'Cancelado, no hice ningún cambio.' });
      }
      // Si escribió otra cosa, cancelamos la pendiente y seguimos como mensaje nuevo
      delete req.session.accionPendiente;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.json({ ok: true, texto: 'El asistente todavía no está configurado (falta GEMINI_API_KEY).' });

    // llamarGeminiConReintentos reintenta sola hasta 3 veces (con espera
    // creciente) cuando Gemini devuelve 503 "alta demanda" — eso era lo que
    // realmente causaba el "No entendí bien" para cualquier pregunta: no
    // era el modelo, era que acá no había ningún reintento y un solo 503
    // (algo esperable y transitorio, no un error real) tiraba todo abajo.
    const primeraLlamada = await llamarGeminiConReintentos(URL_GEMINI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: mensaje }] }],
        tools: HERRAMIENTAS,
      }),
    });
    const dataInicial = await primeraLlamada.json();
    if (dataInicial?.error) {
      // Esto ya no debería pasar casi nunca (llamarGeminiConReintentos
      // tira una excepción propia si Gemini termina fallando después de
      // reintentar) — se deja como red de contención por si Gemini
      // devuelve 200 con un cuerpo de error igual.
      console.error('Error de Gemini (asistente):', JSON.stringify(dataInicial.error));
    }
    // El modelo puede devolver varias "parts" (a veces incluye alguna de
    // razonamiento antes de la respuesta final) — buscamos la que tenga la
    // función o el texto en vez de asumir que es siempre parts[0].
    const partes = dataInicial?.candidates?.[0]?.content?.parts || [];
    const parte = partes.find(p => p.functionCall) || partes.find(p => p.text) || partes[0];

    // ¿El modelo decidió llamar a una función?
    if (parte?.functionCall) {
      const { name, args } = parte.functionCall;

      if (HERRAMIENTAS_SOLO_ADMIN.includes(name) && !esAdminSesion(req)) {
        return res.json({ ok: true, texto: 'Las horas extra son una función solo para administradores.' });
      }

      if (HERRAMIENTAS_DE_ACCION.includes(name)) {
        const resultado = await prepararAccion(req, name, args || {});
        if (resultado.error) return res.json({ ok: true, texto: resultado.error });
        return res.json({ ok: true, texto: resultado.confirmacion, requiereConfirmacion: true });
      }

      // Es una consulta: la ejecutamos y le devolvemos el resultado a Gemini para que redacte la respuesta
      const resultadoConsulta = await ejecutarConsulta(name, args || {});
      const segundaLlamada = await llamarGeminiConReintentos(URL_GEMINI, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [
            { role: 'user', parts: [{ text: mensaje }] },
            { role: 'model', parts: [{ functionCall: { name, args } }] },
            { role: 'user', parts: [{ functionResponse: { name, response: resultadoConsulta } }] },
          ],
          tools: HERRAMIENTAS,
        }),
      });
      const dataFinal = await segundaLlamada.json();
      if (dataFinal?.error) console.error('Error de Gemini (asistente, 2da llamada):', JSON.stringify(dataFinal.error));
      const partesFinal = dataFinal?.candidates?.[0]?.content?.parts || [];
      const textoFinal = partesFinal.find(p => p.text)?.text || 'No pude generar una respuesta.';
      return res.json({ ok: true, texto: textoFinal });
    }

    // No llamó a ninguna función: respuesta de texto directa
    const texto = parte?.text || 'No entendí bien, ¿podés reformular la pregunta?';
    res.json({ ok: true, texto });
  } catch (e) {
    console.error('Error en asistente:', e.message);
    res.json({ ok: false, error: mensajeErrorAsistente(e) });
  }
});

// Mismo criterio de clasificación que mensajeErrorGemini (en
// services/gemini.js, usado por "Reconocer con foto"), pero con el texto
// adaptado al chat en vez de a la lectura de imágenes.
function mensajeErrorAsistente(e) {
  const msg = (e && e.message) || String(e);
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
    return 'Se acabó la cuota gratuita diaria del asistente. Se resetea sola al otro día.';
  }
  if (/503|UNAVAILABLE|high demand/i.test(msg)) {
    return 'El asistente está con mucha demanda en este momento (ya reintenté varias veces). Esperá un minuto y probá de nuevo.';
  }
  if (/No se pudo conectar con Gemini|fetch failed|no respondió en/i.test(msg)) {
    return 'No pude conectarme a internet para responder. Revisá la conexión de esta PC y probá de nuevo.';
  }
  return 'Tuve un problema para responder. Probá de nuevo en un momento.';
}

module.exports = router;
