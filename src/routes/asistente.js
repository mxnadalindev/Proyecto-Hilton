const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { loginRequerido } = require('./middleware');
const { horasDelMes } = require('../services/horasTrabajadas');

const MODELO = 'gemini-2.5-flash';
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

const HERRAMIENTAS_DE_ACCION = ['actualizar_precio_insumo', 'asignar_recoff', 'quitar_recoff'];

const SYSTEM_PROMPT = `Sos el asistente virtual interno del Portal Hilton Buenos Aires, para el equipo de cocina y alimentos y bebidas.
Respondé siempre en español, de forma breve, clara y amable. Hoy es ${new Date().toISOString().slice(0, 10)}.
Cuando el usuario pida algo que corresponda a una de tus herramientas, usala. Si falta un dato imprescindible (ej. no dijo la fecha), preguntá antes de usar la herramienta.
Nunca inventes datos: si una consulta no devuelve resultados, decilo tal cual.`;

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

    const primeraLlamada = await fetch(URL_GEMINI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: mensaje }] }],
        tools: HERRAMIENTAS,
      }),
    });
    const dataInicial = await primeraLlamada.json();
    const parte = dataInicial?.candidates?.[0]?.content?.parts?.[0];

    // ¿El modelo decidió llamar a una función?
    if (parte?.functionCall) {
      const { name, args } = parte.functionCall;

      if (HERRAMIENTAS_DE_ACCION.includes(name)) {
        const resultado = await prepararAccion(req, name, args || {});
        if (resultado.error) return res.json({ ok: true, texto: resultado.error });
        return res.json({ ok: true, texto: resultado.confirmacion, requiereConfirmacion: true });
      }

      // Es una consulta: la ejecutamos y le devolvemos el resultado a Gemini para que redacte la respuesta
      const resultadoConsulta = await ejecutarConsulta(name, args || {});
      const segundaLlamada = await fetch(URL_GEMINI, {
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
      const textoFinal = dataFinal?.candidates?.[0]?.content?.parts?.[0]?.text || 'No pude generar una respuesta.';
      return res.json({ ok: true, texto: textoFinal });
    }

    // No llamó a ninguna función: respuesta de texto directa
    const texto = parte?.text || 'No entendí bien, ¿podés reformular la pregunta?';
    res.json({ ok: true, texto });
  } catch (e) {
    console.error('Error en asistente:', e.message);
    res.json({ ok: false, error: 'Tuve un problema para responder. Probá de nuevo en un momento.' });
  }
});

module.exports = router;
