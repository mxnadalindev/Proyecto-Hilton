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

// ── Idioma ────────────────────────────────────────────────────────────
// El sitio ya tiene un selector de idioma (ES/EN/PT) al lado del logo
// "Hilton" (ver public/js/i18n.js + views/partials/nav.ejs) que guarda la
// elección en localStorage. El front (enviarMensajeAsistente, en
// partials/nav.ejs) manda ese mismo idioma en cada mensaje al bot, así el
// asistente contesta siempre en el idioma que la persona tiene elegido en
// el sitio en ese momento — sin importar en qué idioma haya escrito el
// mensaje (Gemini entiende los tres perfectamente igual).
const IDIOMAS_VALIDOS = ['es', 'en', 'pt'];
function idiomaDesdeRequest(req) {
  return IDIOMAS_VALIDOS.includes(req.body.idioma) ? req.body.idioma : 'es';
}
const NOMBRE_IDIOMA = { es: 'español', en: 'inglés (English)', pt: 'portugués (Português)' };

// Elige uno de los tres textos ya redactados según el idioma actual. Se usa
// para los mensajes que arma el servidor "a mano" (confirmaciones, errores,
// resultados de acciones) — los que NO pasan por Gemini para redactarse,
// así que si no los tradujéramos acá quedarían siempre en español pase lo
// que pase con el selector de idioma del sitio.
function msj(idioma, es, en, pt) {
  if (idioma === 'en') return en;
  if (idioma === 'pt') return pt;
  return es;
}

// Red de seguridad: si el watchdog de 55s de server.js ya mandó su propia
// respuesta de timeout sobre esta misma conexión (ver el comentario ahí),
// esta función evita el crash "Cannot set headers after they are sent" que
// tiraba el proceso cuando el asistente terminaba de procesar un ratito
// después y trataba de mandar SU respuesta sobre una conexión ya cerrada.
function enviarJson(res, payload) {
  if (!res.headersSent) res.json(payload);
}

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
      name: 'consultar_consumo_ayb',
      description: 'Devuelve un ranking de los productos de Inventario AYB (bebidas) más consumidos en un período reciente, usando el historial real de movimientos de stock (los ajustes de tipo "restar"). Útil para preguntas como "qué se vendió más la semana pasada", "cuál es el producto más consumido este mes", o "cuánto se consumió de Fernet en los últimos 15 días".',
      parameters: {
        type: 'OBJECT',
        properties: {
          dias: { type: 'NUMBER', description: 'Cantidad de días hacia atrás a considerar. Si no lo dice, usar 7 ("la semana pasada"/"últimos días"). Para "este mes" usar 30.' },
          nombre_producto: { type: 'STRING', description: 'Nombre (o parte del nombre) de un producto puntual, si preguntan por uno solo. Opcional — si no lo dice, traer el ranking de todos.' },
          limite: { type: 'NUMBER', description: 'Cantidad de productos a devolver en el ranking. Si no lo dice, usar 10.' },
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
- El sitio ahora se puede ver en español, inglés o portugués con el selector de banderas que está al lado de la palabra "Hilton", arriba a la izquierda — y este asistente ahora también entiende y responde en los tres idiomas.
- Nuevo módulo "Inventario" (Alimentos y Bebidas): permite ajustar el stock de bebidas a mano (Sumar/Restar/Fijar), o sacándole una foto a la botella para que la IA la reconozca y sume 1 unidad sola. Cada producto tiene una etiqueta QR imprimible para hacer el ajuste rápido desde el celular, escaneándola en el bar.
- Dentro de Inventario hay una sección "Reportes de consumo": muestra mes a mes, por producto, cuánto se consumió, cuánto se repuso y las correcciones manuales (Fijar), usando el historial real de movimientos.
- El sistema avisa automáticamente cuando algún producto de Inventario está por debajo del stock mínimo cargado (se muestra como alerta acá mismo, en este chat, y también como aviso en la pantalla de Inventario).
- Este chat ahora también puede armar un ranking de los productos de Inventario AYB más consumidos en un período (por ejemplo "qué se vendió más la semana pasada" o "cuánto se consumió de Fernet este mes").
- En Miembro de equipo (Alimentos y Bebidas) las opciones secundarias (Ver en Horarios, Importar mozos por CSV, Cargar con foto) ahora están agrupadas en un botón "Otras opciones", igual que ya funcionaba en Horarios.
- La sección que antes decía "Eventos de Alimentos y Bebidas" ahora se llama simplemente "Horarios".
- Nuevo módulo "Horas extra" (Cocina, solo admin): permite cargar las horas extra de cada empleado por fecha puntual, con nota opcional, y ver el informe acumulado por persona en el mes.
`;

// Descripción de TODO lo que tiene el sistema hoy, módulo por módulo — así
// el asistente puede responder preguntas generales de "qué hace" o "cómo
// se usa" cada parte del portal (aunque no exista una herramienta puntual
// para eso), no solo ejecutar consultas/acciones puntuales de datos.
// Hay que sumar acá cualquier módulo nuevo que se agregue más adelante,
// igual que ya se hace con NOVEDADES_RECIENTES.
const DESCRIPCION_SISTEMA = `
Módulos y funcionalidades del sistema (para responder preguntas generales sobre qué hace o cómo se usa cada parte, aunque no haya una herramienta puntual):
- Inicio: pantalla de entrada, con tarjetas de acceso rápido a cada módulo según el sector y rol del usuario.
- Eventos (Cocina): alta y gestión de eventos gastronómicos, con sus menús y platos asociados; detalle de cada evento.
- Miembro de equipo (Cocina y AYB): alta y gestión de empleados/mozos; en Cocina se elige un rango de fechas en un calendario y se carga el estado de cada día por persona (Normal, OFF, VAC, RECOFF, LIBRE, ART, LICENCIA, CUMPLE, MUDANZA), con un cartel de confirmación al guardar; se pueden marcar feriados en el calendario; en AYB además se pueden importar mozos por planilla CSV o sacándoles una foto (lectura con IA) y agrupa "Ver en Horarios"/"Importar"/"Cargar con foto" en un botón "Otras opciones".
- Horarios (Cocina y AYB): vista de los horarios ya cargados por período, para ver de un vistazo quién trabaja cada día y con qué estado.
- Recetas (Cocina): recetario con los ingredientes de cada plato y su costo.
- Costos (Cocina y AYB): administración de insumos y su precio unitario, con historial de variación de precios (qué subió/bajó y cuánto); costeo de platos armados a partir de recetas; e importación de facturas de compra con reconocimiento por IA — se sube la foto o el PDF de la factura y el sistema sugiere los insumos/precios para revisar y confirmar antes de cargarlos.
- Croutons (AYB): control de stock de croutons con fecha de vencimiento, cargado a mano o leyendo el remito/etiqueta con IA.
- Inventario (AYB): stock de bebidas del bar. Se ajusta a mano (sumar/restar/fijar cantidad) o sacando una foto a la botella para que la IA la reconozca y sume una unidad; cada producto tiene una etiqueta QR imprimible para ajustar rápido desde el celular escaneándola en el bar; avisa cuando algo queda por debajo del stock mínimo; tiene reportes de consumo mes a mes por producto.
- Horas extra (Cocina, solo administradores): carga de horas extra por empleado y fecha puntual, con nota opcional, e informe acumulado por persona y mes — pensado para liquidación de sueldos.
- Configuración (solo administradores): administración de las cuentas/usuarios del sistema.
- Selector de idioma: arriba a la izquierda, al lado de la palabra "Hilton", hay banderitas para ver todo el sitio en español, inglés o portugués.
- Este asistente (el chat, ese mismo con el que está hablando el usuario ahora): además de explicar cómo funciona cada módulo, puede CONSULTAR datos reales del sistema (insumos sin precio cargado, quién trabaja tal día, horas trabajadas de un empleado en un mes, variación de precios de insumos, qué recetas usan un insumo puntual, ranking de insumos más usados en platos, stock de Inventario AYB, ranking de los productos de Inventario AYB más consumidos en un período —por ejemplo "qué se vendió más la semana pasada"—, horas extra cargadas) y hacer algunas ACCIONES puntuales que siempre piden confirmación antes de aplicarse (actualizar el precio de un insumo, poner o sacar RECOFF a un empleado en una fecha, cargar horas extra).
`;

function armarSystemPrompt(idioma) {
  const nombreIdioma = NOMBRE_IDIOMA[idioma] || NOMBRE_IDIOMA.es;
  return `Sos el asistente virtual interno del Portal Hilton Buenos Aires, para el equipo de cocina y alimentos y bebidas.
Entendés perfectamente mensajes escritos en español, inglés o portugués — la persona puede escribirte en cualquiera de los tres idiomas y vas a entender igual lo que pide.
Respondé SIEMPRE en ${nombreIdioma} — es el idioma que la persona tiene elegido ahora mismo en el selector de idioma del sitio — sin importar en qué idioma haya escrito su mensaje, salvo que te pida explícitamente cambiar de idioma dentro de la conversación.
Sé breve, claro y amable. Hoy es ${new Date().toISOString().slice(0, 10)}.
Cuando el usuario pida algo que corresponda a una de tus herramientas, usala. Si falta un dato imprescindible (ej. no dijo la fecha), preguntá antes de usar la herramienta.
Nunca inventes datos: si una consulta no devuelve resultados, decilo tal cual.
${DESCRIPCION_SISTEMA}
${NOVEDADES_RECIENTES}`;
}

// ── Ejecuta las herramientas de solo consulta ────────────────────────────
async function ejecutarConsulta(nombre, args, idioma) {
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
    if (candidatos.length === 0) return { error: msjNoEncontreEmpleado(idioma, args.nombre_empleado) };
    if (candidatos.length > 1) return { error: msjVariosEmpleados(idioma, args.nombre_empleado, candidatos) };
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
    if (insumos.length === 0) return { error: msjNoEncontreInsumo(idioma, args.nombre_insumo) };
    if (insumos.length > 1) return { error: msjVariosInsumos(idioma, args.nombre_insumo, insumos) };
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
      return {
        total: 0,
        mensaje: args.nombre_producto
          ? msj(idioma,
              `No encontré ningún producto de Inventario AYB que coincida con "${args.nombre_producto}".`,
              `I couldn't find any AYB Inventory product matching "${args.nombre_producto}".`,
              `Não encontrei nenhum produto do Inventário AYB que corresponda a "${args.nombre_producto}".`)
          : msj(idioma, 'No hay productos que cumplan ese filtro.', 'There are no products matching that filter.', 'Não há produtos que atendam a esse filtro.'),
      };
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

  if (nombre === 'consultar_consumo_ayb') {
    const dias = Number.isFinite(args.dias) && args.dias > 0 ? Math.min(args.dias, 365) : 7;
    const limite = Number.isFinite(args.limite) && args.limite > 0 ? Math.min(args.limite, 30) : 10;

    const params = [dias];
    let filtroNombre = '';
    if (args.nombre_producto) { filtroNombre = 'AND p.nombre ILIKE $2'; params.push(`%${args.nombre_producto}%`); }

    const filas = await db.all2(`
      SELECT p.nombre, p.categoria, p.unidad_default,
        COALESCE(SUM(m.cantidad) FILTER (WHERE m.tipo = 'restar'), 0) AS consumido
      FROM inventario_ayb_movimientos m
      JOIN productos_ayb p ON p.id = m.producto_id
      WHERE m.creado_en >= NOW() - ($1 || ' days')::interval ${filtroNombre}
      GROUP BY p.nombre, p.categoria, p.unidad_default
      HAVING COALESCE(SUM(m.cantidad) FILTER (WHERE m.tipo = 'restar'), 0) > 0
      ORDER BY consumido DESC
      LIMIT $${params.length + 1}
    `, [...params, limite]);

    if (filas.length === 0) {
      return {
        dias,
        mensaje: args.nombre_producto
          ? msj(idioma,
              `No encontré consumo registrado de "${args.nombre_producto}" en los últimos ${dias} días.`,
              `I couldn't find any recorded consumption of "${args.nombre_producto}" in the last ${dias} days.`,
              `Não encontrei consumo registrado de "${args.nombre_producto}" nos últimos ${dias} dias.`)
          : msj(idioma, `No hay consumo registrado de Inventario AYB en los últimos ${dias} días.`, `There's no recorded AYB Inventory consumption in the last ${dias} days.`, `Não há consumo registrado do Inventário AYB nos últimos ${dias} dias.`),
      };
    }
    return {
      dias,
      ranking: filas.map(f => ({ producto: f.nombre, categoria: f.categoria, unidad: f.unidad_default, consumido: Math.round(Number(f.consumido) * 10) / 10 })),
    };
  }

  if (nombre === 'consultar_horas_extra') {
    const mes = /^\d{4}-\d{2}$/.test(args.mes || '') ? args.mes : new Date().toISOString().slice(0, 7);

    if (args.nombre_empleado) {
      const candidatos = await buscarEmpleadoCocinaPorNombre(args.nombre_empleado);
      if (candidatos.length === 0) return { error: msjNoEncontreEmpleadoCocina(idioma, args.nombre_empleado) };
      if (candidatos.length > 1) return { error: msjVariosEmpleados(idioma, args.nombre_empleado, candidatos) };
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
    if (rows.length === 0) return { mes, mensaje: msj(idioma, 'No hay horas extra cargadas ese mes.', 'There are no overtime hours logged that month.', 'Não há horas extras lançadas nesse mês.') };
    return {
      mes,
      ranking: rows.map(r => ({ empleado: r.nombre, horas_extra_totales: Math.round(Number(r.total) * 10) / 10, registros: r.registros })),
    };
  }

  return { error: msj(idioma, 'Herramienta de consulta desconocida', 'Unknown query tool', 'Ferramenta de consulta desconhecida') };
}

// ── Mensajes de "no encontré"/"encontré varios", en los tres idiomas ────
function msjNoEncontreEmpleado(idioma, texto) {
  return msj(idioma,
    `No encontré ningún empleado que coincida con "${texto}".`,
    `I couldn't find any employee matching "${texto}".`,
    `Não encontrei nenhum funcionário que corresponda a "${texto}".`);
}
function msjNoEncontreEmpleadoCocina(idioma, texto) {
  return msj(idioma,
    `No encontré ningún empleado de Cocina que coincida con "${texto}".`,
    `I couldn't find any Kitchen employee matching "${texto}".`,
    `Não encontrei nenhum funcionário da Cozinha que corresponda a "${texto}".`);
}
function msjVariosEmpleados(idioma, texto, candidatos) {
  const nombres = candidatos.map(c => c.nombre).join(', ');
  return msj(idioma,
    `Encontré varios empleados que coinciden con "${texto}": ${nombres}. Decime cuál exactamente.`,
    `I found several employees matching "${texto}": ${nombres}. Tell me which one exactly.`,
    `Encontrei vários funcionários que correspondem a "${texto}": ${nombres}. Me diga qual exatamente.`);
}
function msjNoEncontreInsumo(idioma, texto) {
  return msj(idioma,
    `No encontré ningún insumo que coincida con "${texto}".`,
    `I couldn't find any supply item matching "${texto}".`,
    `Não encontrei nenhum insumo que corresponda a "${texto}".`);
}
function msjVariosInsumos(idioma, texto, candidatos) {
  const nombres = candidatos.map(c => c.nombre).join(', ');
  return msj(idioma,
    `Encontré varios insumos que coinciden con "${texto}": ${nombres}. Decime cuál exactamente.`,
    `I found several supply items matching "${texto}": ${nombres}. Tell me which one exactly.`,
    `Encontrei vários insumos que correspondem a "${texto}": ${nombres}. Me diga qual exatamente.`);
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
async function prepararAccion(req, nombre, args, idioma) {
  if (nombre === 'actualizar_precio_insumo') {
    const candidatos = await buscarInsumoPorNombre(args.nombre_insumo);
    if (candidatos.length === 0) return { error: msjNoEncontreInsumo(idioma, args.nombre_insumo) };
    if (candidatos.length > 1) return { error: msjVariosInsumos(idioma, args.nombre_insumo, candidatos) };
    const insumo = candidatos[0];
    req.session.accionPendiente = { tipo: nombre, insumo_id: insumo.id };
    const precioNuevo = Number(args.precio_nuevo).toFixed(2);
    const precioActual = Number(insumo.precio_unitario || 0).toFixed(2);
    return {
      confirmacion: msj(idioma,
        `¿Confirmás que actualizo el precio de "${insumo.nombre}" a $${precioNuevo}? (Precio actual: $${precioActual})`,
        `Do you confirm I update the price of "${insumo.nombre}" to $${precioNuevo}? (Current price: $${precioActual})`,
        `Confirma que vou atualizar o preço de "${insumo.nombre}" para $${precioNuevo}? (Preço atual: $${precioActual})`),
      valorNuevo: args.precio_nuevo,
    };
  }

  if (nombre === 'asignar_recoff' || nombre === 'quitar_recoff') {
    const candidatos = await buscarEmpleadoPorNombre(args.nombre_empleado);
    if (candidatos.length === 0) return { error: msjNoEncontreEmpleado(idioma, args.nombre_empleado) };
    if (candidatos.length > 1) return { error: msjVariosEmpleados(idioma, args.nombre_empleado, candidatos) };
    const emp = candidatos[0];
    req.session.accionPendiente = { tipo: nombre, usuario_id: emp.id, fecha: args.fecha };
    const confirmacion = nombre === 'asignar_recoff'
      ? msj(idioma,
          `¿Confirmás que le pongo RECOFF a ${emp.nombre} el ${args.fecha}?`,
          `Do you confirm I set RECOFF for ${emp.nombre} on ${args.fecha}?`,
          `Confirma que vou colocar RECOFF para ${emp.nombre} no dia ${args.fecha}?`)
      : msj(idioma,
          `¿Confirmás que le saco el RECOFF a ${emp.nombre} el ${args.fecha}?`,
          `Do you confirm I remove RECOFF from ${emp.nombre} on ${args.fecha}?`,
          `Confirma que vou remover o RECOFF de ${emp.nombre} no dia ${args.fecha}?`);
    return { confirmacion };
  }

  if (nombre === 'cargar_horas_extra') {
    const candidatos = await buscarEmpleadoCocinaPorNombre(args.nombre_empleado);
    if (candidatos.length === 0) return { error: msjNoEncontreEmpleadoCocina(idioma, args.nombre_empleado) };
    if (candidatos.length > 1) return { error: msjVariosEmpleados(idioma, args.nombre_empleado, candidatos) };
    const horas = Number(args.horas);
    if (!horas || horas <= 0 || horas > 24 || !/^\d{4}-\d{2}-\d{2}$/.test(args.fecha || '')) {
      return {
        error: msj(idioma,
          'Revisá la fecha o la cantidad de horas — no me quedó un dato válido para cargar.',
          'Check the date or the number of hours — I didn\'t get a valid value to log.',
          'Verifique a data ou a quantidade de horas — não ficou um dado válido para lançar.'),
      };
    }
    const emp = candidatos[0];
    req.session.accionPendiente = { tipo: nombre, usuario_id: emp.id, fecha: args.fecha, horas, nota: args.nota || null };
    const notaTexto = args.nota
      ? msj(idioma, ` (nota: "${args.nota}")`, ` (note: "${args.nota}")`, ` (observação: "${args.nota}")`)
      : '';
    return {
      confirmacion: msj(idioma,
        `¿Confirmás que cargo ${horas}hs extra para ${emp.nombre} el ${args.fecha}${notaTexto}?`,
        `Do you confirm I log ${horas}h overtime for ${emp.nombre} on ${args.fecha}${notaTexto}?`,
        `Confirma que vou lançar ${horas}h extras para ${emp.nombre} no dia ${args.fecha}${notaTexto}?`),
    };
  }

  return { error: msj(idioma, 'Acción desconocida', 'Unknown action', 'Ação desconhecida') };
}

// ── Ejecuta la acción ya confirmada, guardada en sesión ──────────────────
async function ejecutarAccionPendiente(req, idioma) {
  const accion = req.session.accionPendiente;
  if (!accion) return msj(idioma, 'No tengo ninguna acción pendiente para confirmar.', 'I don\'t have any pending action to confirm.', 'Não tenho nenhuma ação pendente para confirmar.');

  if (accion.tipo === 'actualizar_precio_insumo') {
    await db.run2(`UPDATE insumos SET precio_unitario=$1, actualizado_en=NOW() WHERE id=$2`, [accion.valorNuevo, accion.insumo_id]);
    delete req.session.accionPendiente;
    return msj(idioma, 'Listo, actualicé el precio. ✓', 'Done, I updated the price. ✓', 'Pronto, atualizei o preço. ✓');
  }

  if (accion.tipo === 'asignar_recoff') {
    await db.run2(`
      INSERT INTO horarios_semanales (usuario_id, fecha, valor) VALUES ($1,$2,'RECOFF')
      ON CONFLICT (usuario_id, fecha) DO UPDATE SET valor='RECOFF'
    `, [accion.usuario_id, accion.fecha]);
    delete req.session.accionPendiente;
    return msj(idioma, 'Listo, le asigné RECOFF ese día. ✓', 'Done, I set RECOFF for that day. ✓', 'Pronto, atribuí RECOFF nesse dia. ✓');
  }

  if (accion.tipo === 'quitar_recoff') {
    await db.run2(`DELETE FROM horarios_semanales WHERE usuario_id=$1 AND fecha=$2`, [accion.usuario_id, accion.fecha]);
    delete req.session.accionPendiente;
    return msj(idioma, 'Listo, saqué el RECOFF de ese día. ✓', 'Done, I removed RECOFF from that day. ✓', 'Pronto, removi o RECOFF desse dia. ✓');
  }

  if (accion.tipo === 'cargar_horas_extra') {
    await db.run2(`
      INSERT INTO horas_extra (usuario_id, fecha, horas, nota, creado_por, creado_por_nombre)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [accion.usuario_id, accion.fecha, accion.horas, accion.nota, req.session.usuario.id, req.session.usuario.nombre]);
    delete req.session.accionPendiente;
    return msj(idioma, 'Listo, cargué las horas extra. ✓', 'Done, I logged the overtime hours. ✓', 'Pronto, lancei as horas extras. ✓');
  }

  delete req.session.accionPendiente;
  return msj(idioma, 'No supe cómo aplicar esa acción.', 'I didn\'t know how to apply that action.', 'Não consegui aplicar essa ação.');
}

// Reconoce confirmar/cancelar en los tres idiomas — el botón "Sí, confirmar"
// / "No, cancelar" del panel del asistente ya se traduce en pantalla (ver
// agregarBotonesConfirmacion en partials/nav.ejs), pero la persona también
// puede escribir la respuesta a mano en cualquiera de los tres idiomas.
function esAfirmativo(msg) {
  return /^(si|sí|dale|confirmo|confirmar|ok|listo|s|yes|y|sim|s)$/i.test(msg.trim());
}
function esNegativo(msg) {
  return /^(no|cancelar|cancela|nop|n|não|nao)$/i.test(msg.trim());
}

router.post('/mensaje', loginRequerido, async (req, res) => {
  const mensaje = (req.body.mensaje || '').trim();
  const idioma = idiomaDesdeRequest(req);
  if (!mensaje) return enviarJson(res, { ok: false, error: msj(idioma, 'Mensaje vacío', 'Empty message', 'Mensagem vazia') });

  try {
    // Si hay una acción pendiente de confirmar, resolvemos eso primero
    if (req.session.accionPendiente) {
      if (esAfirmativo(mensaje)) {
        const texto = await ejecutarAccionPendiente(req, idioma);
        return enviarJson(res, { ok: true, texto });
      }
      if (esNegativo(mensaje)) {
        delete req.session.accionPendiente;
        return enviarJson(res, { ok: true, texto: msj(idioma, 'Cancelado, no hice ningún cambio.', 'Cancelled, I didn\'t make any changes.', 'Cancelado, não fiz nenhuma alteração.') });
      }
      // Si escribió otra cosa, cancelamos la pendiente y seguimos como mensaje nuevo
      delete req.session.accionPendiente;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return enviarJson(res, { ok: true, texto: msj(idioma, 'El asistente todavía no está configurado (falta GEMINI_API_KEY).', 'The assistant isn\'t configured yet (missing GEMINI_API_KEY).', 'O assistente ainda não está configurado (falta GEMINI_API_KEY).') });

    const systemPrompt = armarSystemPrompt(idioma);

    // llamarGeminiConReintentos reintenta sola hasta 3 veces (con espera
    // creciente) cuando Gemini devuelve 503 "alta demanda" — eso era lo que
    // realmente causaba el "No entendí bien" para cualquier pregunta: no
    // era el modelo, era que acá no había ningún reintento y un solo 503
    // (algo esperable y transitorio, no un error real) tiraba todo abajo.
    const primeraLlamada = await llamarGeminiConReintentos(URL_GEMINI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
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
      // Gemini exige que, al reenviarle su propio functionCall en el turno
      // siguiente (para las herramientas de consulta, más abajo), venga
      // acompañado del "thoughtSignature" que mandó junto con ESE mismo
      // functionCall en la primera respuesta — si no, devuelve un 400
      // ("Function call is missing a thought_signature..."). Esto es lo
      // que realmente rompía "cuál es el producto de mayor stock", no un
      // problema de idioma ni de conexión: el bot armaba bien la consulta,
      // pero la segunda llamada (la que redacta la respuesta final con el
      // resultado) le fallaba a Gemini con ese 400 antes de contestar.
      const thoughtSignature = parte.thoughtSignature;

      if (HERRAMIENTAS_SOLO_ADMIN.includes(name) && !esAdminSesion(req)) {
        return enviarJson(res, { ok: true, texto: msj(idioma, 'Las horas extra son una función solo para administradores.', 'Overtime hours are an admin-only feature.', 'Horas extras são uma função exclusiva para administradores.') });
      }

      if (HERRAMIENTAS_DE_ACCION.includes(name)) {
        const resultado = await prepararAccion(req, name, args || {}, idioma);
        if (resultado.error) return enviarJson(res, { ok: true, texto: resultado.error });
        return enviarJson(res, { ok: true, texto: resultado.confirmacion, requiereConfirmacion: true });
      }

      // Es una consulta: la ejecutamos y le devolvemos el resultado a Gemini para que redacte la respuesta
      const resultadoConsulta = await ejecutarConsulta(name, args || {}, idioma);
      const parteFunctionCall = { functionCall: { name, args } };
      if (thoughtSignature) parteFunctionCall.thoughtSignature = thoughtSignature;
      const segundaLlamada = await llamarGeminiConReintentos(URL_GEMINI, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [
            { role: 'user', parts: [{ text: mensaje }] },
            { role: 'model', parts: [parteFunctionCall] },
            { role: 'user', parts: [{ functionResponse: { name, response: resultadoConsulta } }] },
          ],
          tools: HERRAMIENTAS,
        }),
      });
      const dataFinal = await segundaLlamada.json();
      if (dataFinal?.error) console.error('Error de Gemini (asistente, 2da llamada):', JSON.stringify(dataFinal.error));
      const partesFinal = dataFinal?.candidates?.[0]?.content?.parts || [];
      const textoFinal = partesFinal.find(p => p.text)?.text || msj(idioma, 'No pude generar una respuesta.', 'I couldn\'t generate a reply.', 'Não consegui gerar uma resposta.');
      return enviarJson(res, { ok: true, texto: textoFinal });
    }

    // No llamó a ninguna función: respuesta de texto directa
    const texto = parte?.text || msj(idioma, 'No entendí bien, ¿podés reformular la pregunta?', 'I didn\'t quite understand, could you rephrase that?', 'Não entendi bem, você pode reformular a pergunta?');
    enviarJson(res, { ok: true, texto });
  } catch (e) {
    console.error('Error en asistente:', e.message);
    enviarJson(res, { ok: false, error: mensajeErrorAsistente(e, idioma) });
  }
});

// Mismo criterio de clasificación que mensajeErrorGemini (en
// services/gemini.js, usado por "Reconocer con foto"), pero con el texto
// adaptado al chat en vez de a la lectura de imágenes, y en los tres idiomas.
function mensajeErrorAsistente(e, idioma) {
  const msgOriginal = (e && e.message) || String(e);
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(msgOriginal)) {
    return msj(idioma,
      'Se acabó la cuota gratuita diaria del asistente. Se resetea sola al otro día.',
      'The assistant\'s free daily quota ran out. It resets automatically the next day.',
      'A cota gratuita diária do assistente acabou. Ela se reinicia sozinha no dia seguinte.');
  }
  if (/503|UNAVAILABLE|high demand/i.test(msgOriginal)) {
    return msj(idioma,
      'El asistente está con mucha demanda en este momento (ya reintenté varias veces). Esperá un minuto y probá de nuevo.',
      'The assistant is experiencing high demand right now (I already retried several times). Wait a minute and try again.',
      'O assistente está com muita demanda no momento (já tentei várias vezes). Espere um minuto e tente novamente.');
  }
  if (/No se pudo conectar con Gemini|fetch failed|no respondió en/i.test(msgOriginal)) {
    return msj(idioma,
      'No pude conectarme a internet para responder. Revisá la conexión de esta PC y probá de nuevo.',
      'I couldn\'t connect to the internet to reply. Check this computer\'s connection and try again.',
      'Não consegui me conectar à internet para responder. Verifique a conexão deste computador e tente novamente.');
  }
  return msj(idioma,
    'Tuve un problema para responder. Probá de nuevo en un momento.',
    'I had a problem replying. Try again in a moment.',
    'Tive um problema para responder. Tente novamente em instantes.');
}

module.exports = router;
