const fs = require('fs');
const db = require('../db/database');

// Parsea el archivo completo en filas, respetando comillas — incluso cuando una celda
// entre comillas contiene un salto de línea real adentro (pasa con encabezados como
// "Factor\ndesecho" exportados desde Excel). Parsear línea por línea rompía justo ahí.
function parsearFilasCsv(contenido) {
  const filas = [];
  let fila = [];
  let campo = '';
  let entreComillas = false;

  for (let i = 0; i < contenido.length; i++) {
    const ch = contenido[i];
    if (entreComillas) {
      if (ch === '"') {
        if (contenido[i + 1] === '"') { campo += '"'; i++; }
        else entreComillas = false;
      } else {
        campo += ch;
      }
    } else if (ch === '"') {
      entreComillas = true;
    } else if (ch === ',') {
      fila.push(campo);
      campo = '';
    } else if (ch === '\r') {
      // se ignora, el fin de fila real lo marca el \n
    } else if (ch === '\n') {
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = '';
    } else {
      campo += ch;
    }
  }
  if (campo !== '' || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }

  return filas.map(f => f.map(c => c.trim()));
}

// "0,600" -> 0.6   |   "2" -> 2   |   "" -> 0
function parsearNumero(str) {
  if (!str) return 0;
  const limpio = String(str).replace(',', '.').trim();
  const num = parseFloat(limpio);
  return isNaN(num) ? 0 : num;
}

// ── Matching por nombre, para ingredientes que vienen sin código (solo texto) ──
function normalizar(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function distanciaLevenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similitud(nombreA, nombreB) {
  const a = normalizar(nombreA);
  const b = normalizar(nombreB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const dist = distanciaLevenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - (dist / maxLen);
}

function buscarInsumoMasParecido(nombreBuscado, insumos) {
  let mejor = null, mejorScore = 0;
  for (const insumo of insumos) {
    const score = similitud(nombreBuscado, insumo.nombre);
    if (score > mejorScore) { mejorScore = score; mejor = insumo; }
  }
  return mejorScore >= 0.6 ? mejor : null;
}

/**
 * Parsea el archivo de costeo (formato: un bloque por plato, con nombre,
 * encabezado "Codigo,Productos,...", filas de ingredientes, y fila de totales).
 * Devuelve un array de platos: [{ nombre, porciones, ingredientes: [{codigo, peso_neto, factor_desecho, peso_bruto}] }]
 */
function parsearCsvPlatos(rutaArchivo) {
  const contenido = fs.readFileSync(rutaArchivo, 'utf8');
  const filas = parsearFilasCsv(contenido);

  const platos = [];
  let platoActual = null;

  for (const campos of filas) {
    const [c0, c1, c2, c3, c4, c5] = campos;
    if (!c0 && !c1 && !c2 && !c3 && !c4 && !c5) continue; // fila vacía

    // Fila de nombre de plato: solo la primera columna tiene contenido
    if (c0 && !c1?.trim() && !c2?.trim()) {
      if (platoActual) platos.push(platoActual);
      platoActual = { nombre: c0.trim(), porciones: 1, ingredientes: [] };
      continue;
    }

    // Fila de encabezado ("Codigo,Productos,...") — se ignora, no aporta datos
    if (c0 === 'Codigo') continue;

    // Fila de resumen ("Costo total" / "Costo unit" / "Costo x N pax") — no aporta ingredientes
    if (!c0 && c5 && /costo/i.test(c5)) {
      const match = c5.match(/Costo x (\d+)\s*pax/i);
      if (match && platoActual) platoActual.porciones = parseInt(match[1]);
      continue;
    }

    // Fila de ingrediente CON código: primera columna es numérica, y hay Peso Neto
    if (platoActual && /^\d+$/.test(c0) && c2) {
      platoActual.ingredientes.push({
        codigo: c0,
        nombre: null,
        peso_neto: parsearNumero(c2),
        factor_desecho: parsearNumero(c3),
        peso_bruto: parsearNumero(c4),
      });
      continue;
    }

    // Fila de ingrediente SIN código: primera columna vacía, pero hay nombre en la segunda y Peso Neto
    if (platoActual && !c0 && c1 && c1.trim() && c2) {
      platoActual.ingredientes.push({
        codigo: null,
        nombre: c1.trim(),
        peso_neto: parsearNumero(c2),
        factor_desecho: parsearNumero(c3),
        peso_bruto: parsearNumero(c4),
      });
    }
  }
  if (platoActual) platos.push(platoActual);

  return platos.filter(p => p.ingredientes.length > 0);
}

/**
 * Importa los platos parseados: upsert por nombre (case-insensitive).
 * - Plato nuevo -> se crea en platos_costo
 * - Plato existente -> se reemplazan sus insumos por los del archivo (reimportación limpia)
 * - Ingrediente cuyo código no matchea ningún insumo -> se reporta, no se agrega
 */
async function importarPlatos(platos, categoria) {
  const resumen = {
    platosNuevos: 0,
    platosActualizados: 0,
    detallePlatos: [], // {nombre, costoTotal, ingredientesOk, ingredientesFaltantes: [...]}
  };

  // Traemos todos los insumos una sola vez, para el matching por nombre (evita miles de consultas)
  const todosInsumos = await db.all2('SELECT * FROM insumos');

  for (const p of platos) {
    let plato = await db.get2('SELECT * FROM platos_costo WHERE LOWER(nombre)=LOWER($1)', [p.nombre]);
    let esNuevo = false;

    if (!plato) {
      const insertado = await db.get2(
        `INSERT INTO platos_costo (nombre, categoria, porciones, precio_venta, margen_ganancia)
         VALUES ($1,$2,$3,0,30) RETURNING *`,
        [p.nombre, categoria, p.porciones || 1]
      );
      plato = insertado;
      esNuevo = true;
      resumen.platosNuevos++;
    } else {
      await db.run2('UPDATE platos_costo SET categoria=$1, porciones=$2 WHERE id=$3',
        [categoria, p.porciones || 1, plato.id]);
      await db.run2('DELETE FROM plato_insumos WHERE plato_id=$1', [plato.id]);
      resumen.platosActualizados++;
    }

    const faltantes = [];
    let costoTotal = 0;
    let ok = 0;

    for (const ing of p.ingredientes) {
      let insumo = null;
      if (ing.codigo) {
        insumo = await db.get2('SELECT * FROM insumos WHERE codigo=$1', [ing.codigo]);
      } else if (ing.nombre) {
        insumo = buscarInsumoMasParecido(ing.nombre, todosInsumos);
      }

      if (!insumo) {
        faltantes.push(ing.codigo || ing.nombre || '(sin código ni nombre)');
        continue;
      }
      const cantidad = ing.peso_bruto; // costeamos por peso bruto (lo que realmente se compra/consume)
      const costoParcial = cantidad * (parseFloat(insumo.precio_unitario) || 0);
      await db.run2(
        `INSERT INTO plato_insumos (plato_id, insumo_id, cantidad, unidad, costo_parcial)
         VALUES ($1,$2,$3,$4,$5)`,
        [plato.id, insumo.id, cantidad, insumo.unidad, costoParcial]
      );
      costoTotal += costoParcial;
      ok++;
    }

    await db.run2('UPDATE platos_costo SET costo_total=$1 WHERE id=$2', [costoTotal, plato.id]);

    resumen.detallePlatos.push({
      nombre: p.nombre,
      esNuevo,
      costoTotal,
      ingredientesOk: ok,
      ingredientesFaltantes: faltantes,
    });
  }

  return resumen;
}

module.exports = { parsearCsvPlatos, importarPlatos };
