// src/services/recoff.js — cálculo del RECOFF pendiente, antes duplicado
// en horarios.js y personal.js.
//
// Pendiente real = días adeudados (cargados a mano en Personal) - RECOFF que
// ya tiene puestos en la grilla de horarios (toda la grilla, no solo el rango visible).
const db = require('../db/database');

async function contarRecoffUsados(usuario_id) {
  const usados = await db.get2(
    "SELECT COUNT(*)::int AS c FROM horarios_semanales WHERE usuario_id=$1 AND UPPER(valor)='RECOFF'",
    [usuario_id]
  );
  return usados?.c || 0;
}

// Pendiente de un único empleado
async function calcularRecoffPendiente(usuario_id) {
  const fila = await db.get2('SELECT recoff_adeudado FROM usuarios WHERE id=$1', [usuario_id]);
  const usados = await contarRecoffUsados(usuario_id);
  return (fila?.recoff_adeudado || 0) - usados;
}

// Mapa { usuario_id: recoff_usados } para todos los empleados de una sola consulta,
// para no hacer una query por fila al pintar una grilla completa.
async function mapRecoffUsados() {
  const usadosRaw = await db.all2(`
    SELECT usuario_id, COUNT(*)::int AS usados
    FROM horarios_semanales WHERE UPPER(valor)='RECOFF' GROUP BY usuario_id
  `);
  const mapa = {};
  usadosRaw.forEach(r => { mapa[r.usuario_id] = r.usados; });
  return mapa;
}

module.exports = { calcularRecoffPendiente, contarRecoffUsados, mapRecoffUsados };
