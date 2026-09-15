// scripts/cargar_tragos_clasicos.js
//
// Carga los 34 tragos clásicos de la planilla "Septiembre 26 1.xlsx" (hoja
// "Tragos clasicos") en Costos → AYB, con sus ingredientes.
//
// CÓMO USARLO: parado en la carpeta del proyecto (C:\Users\HILTON\Desktop\
// hilton_v2), con el servidor DETENIDO (para no pisarse con conexiones a
// la base), correr:
//
//     node scripts/cargar_tragos_clasicos.js
//
// Qué hace, con cuidado de no romper ni inventar nada:
//   1. Por cada trago de la planilla: si YA existe un trago con ese mismo
//      nombre en Costos → AYB, lo SALTEA por completo (no lo toca, no lo
//      duplica).
//   2. Si no existe, lo crea. Para cada ingrediente de la receta, busca un
//      producto con ese nombre en tu Inventario AYB real:
//        - Si lo encuentra (con nombre igual o muy parecido, sin dudas),
//          usa ESE producto con SU precio actual — nunca el precio viejo
//          de la planilla (esos precios son de 2022 y ya no sirven).
//        - Si NO lo encuentra, o encuentra más de un producto parecido y
//          no está claro cuál es, NO inventa nada: no crea el producto,
//          no adivina, y lo deja anotado en el reporte final para que vos
//          decidas.
//   3. Al final imprime un reporte completo: qué tragos se crearon, cuáles
//      ya existían, y qué ingredientes quedaron sin cargar (para que los
//      agregues a mano en Inventario AYB y corras el script de nuevo, o
//      los cargues manualmente en el trago desde su pantalla de detalle).
//
// Se puede correr más de una vez sin problema: los tragos que ya existen
// no se tocan, así que si corrés esto, agregás los productos que faltaban
// en Inventario AYB, y lo volvés a correr, va a completar solo los
// ingredientes que antes no había podido encontrar (siempre que el trago
// en sí no se haya creado ya con ese ingrediente faltante — en ese caso,
// agregalo a mano desde la pantalla del trago, que ya tiene el buscador).

const db = require('../src/db/database');
const tragos = require('./tragos_clasicos_datos.json');

function normalizar(txt) {
  return (txt || '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buscarProducto(nombreIngrediente, catalogo) {
  const norm = normalizar(nombreIngrediente);

  // 1) Coincidencia exacta (normalizada).
  const exactos = catalogo.filter(p => p._norm === norm);
  if (exactos.length === 1) return { producto: exactos[0], tipo: 'exacto' };
  if (exactos.length > 1) return { producto: null, tipo: 'ambiguo', candidatos: exactos };

  // 2) El nombre del ingrediente está contenido en el nombre del producto
  //    (ej. "Aperol" adentro de "Aperol - Italia"), o al revés.
  const parciales = catalogo.filter(p => p._norm.includes(norm) || norm.includes(p._norm));
  if (parciales.length === 1) return { producto: parciales[0], tipo: 'parcial' };
  if (parciales.length > 1) return { producto: null, tipo: 'ambiguo', candidatos: parciales };

  return { producto: null, tipo: 'no encontrado' };
}

async function main() {
  await db.listaParaUsar;

  const catalogoRaw = await db.all2("SELECT id, nombre, unidad_default, precio_unitario FROM productos_ayb WHERE activo=true");
  const catalogo = catalogoRaw.map(p => ({ ...p, _norm: normalizar(p.nombre) }));

  const reporte = {
    creados: [],
    salteados: [],
    ingredientesFaltantes: [], // { trago, ingrediente, motivo, candidatos }
  };

  for (const trago of tragos) {
    const existente = await db.get2(
      "SELECT id FROM platos_costo WHERE departamento='ayb' AND lower(nombre)=lower($1)",
      [trago.nombre]
    );
    if (existente) {
      reporte.salteados.push(trago.nombre);
      continue;
    }

    const resultado = await db.run2(
      "INSERT INTO platos_costo (nombre,categoria,porciones,precio_venta,margen_ganancia,departamento) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [trago.nombre, 'Tragos clásicos', 1, 0, 30, 'ayb']
    );
    const platoId = resultado.lastID;

    let costoTotal = 0;
    for (const ing of trago.ingredientes) {
      const { producto, tipo, candidatos } = buscarProducto(ing.nombre, catalogo);
      if (!producto) {
        reporte.ingredientesFaltantes.push({
          trago: trago.nombre,
          ingrediente: ing.nombre,
          motivo: tipo,
          candidatos: (candidatos || []).map(c => c.nombre),
        });
        continue;
      }
      const cantidad = parseFloat(ing.cantidad) || 0;
      const costoParcial = cantidad * producto.precio_unitario;
      await db.run2(
        "INSERT INTO plato_insumos_ayb (plato_id,insumo_id,cantidad,unidad,costo_parcial) VALUES ($1,$2,$3,$4,$5)",
        [platoId, producto.id, cantidad, producto.unidad_default, costoParcial]
      );
      costoTotal += costoParcial;
    }

    await db.run2("UPDATE platos_costo SET costo_total=$1 WHERE id=$2", [costoTotal, platoId]);
    reporte.creados.push({ nombre: trago.nombre, id: platoId, ingredientesCargados: trago.ingredientes.length - trago.ingredientes.filter(i => reporte.ingredientesFaltantes.some(f => f.trago === trago.nombre && f.ingrediente === i.nombre)).length, ingredientesTotal: trago.ingredientes.length });
  }

  console.log('\n========== REPORTE: CARGA DE TRAGOS CLÁSICOS ==========\n');
  console.log(`Tragos creados: ${reporte.creados.length}`);
  reporte.creados.forEach(t => console.log(`  ✓ ${t.nombre} — ${t.ingredientesCargados}/${t.ingredientesTotal} ingredientes cargados`));

  console.log(`\nTragos salteados (ya existían con ese nombre): ${reporte.salteados.length}`);
  reporte.salteados.forEach(n => console.log(`  · ${n}`));

  console.log(`\nIngredientes que NO se pudieron cargar automáticamente: ${reporte.ingredientesFaltantes.length}`);
  reporte.ingredientesFaltantes.forEach(f => {
    if (f.motivo === 'ambiguo') {
      console.log(`  ⚠ "${f.ingrediente}" (en ${f.trago}): hay más de un producto parecido en Inventario AYB (${f.candidatos.join(' / ')}) — no adiviné cuál, agregalo a mano desde la pantalla del trago.`);
    } else {
      console.log(`  ✗ "${f.ingrediente}" (en ${f.trago}): no existe ningún producto parecido en Inventario AYB — creá el producto ahí y después agregalo a mano desde la pantalla del trago (o volvé a correr este script si el trago no se había creado todavía).`);
    }
  });
  console.log('\n=========================================================\n');

  await db.pool.end();
}

main().catch(err => {
  console.error('Error cargando los tragos clásicos:', err);
  process.exit(1);
});
