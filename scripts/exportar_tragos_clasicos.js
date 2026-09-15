// scripts/exportar_tragos_clasicos.js
//
// Genera "Tragos Clasicos - actualizado.xlsx", con el mismo formato de la
// planilla original (cada trago con su nombre, la lista de ingredientes
// con peso neto / unidad / costo, y los totales), pero con los datos
// ACTUALES de Costos → AYB: los tragos que ya tenías, más los que se
// hayan cargado con cargar_tragos_clasicos.js, con los precios de hoy.
//
// CÓMO USARLO:
//     node scripts/exportar_tragos_clasicos.js
//
// El archivo queda en la carpeta del proyecto. Se puede correr las veces
// que hagan falta — cada vez que cambian precios o se agregan tragos, para
// tener siempre una planilla actualizada para imprimir o compartir.

const ExcelJS = require('exceljs');
const db = require('../src/db/database');

async function main() {
  await db.listaParaUsar;

  const tragos = await db.all2(
    "SELECT * FROM platos_costo WHERE departamento='ayb' ORDER BY categoria NULLS LAST, nombre"
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tragos clásicos');
  ws.columns = [{ width: 30 }, { width: 16 }, { width: 14 }, { width: 18 }, { width: 16 }];

  let fila = 1;
  for (const trago of tragos) {
    const ingredientes = await db.all2(
      `SELECT pi.cantidad, pi.unidad, pi.costo_parcial, pr.nombre AS insumo_nombre, pr.precio_unitario
       FROM plato_insumos_ayb pi JOIN productos_ayb pr ON pi.insumo_id = pr.id
       WHERE pi.plato_id = $1 ORDER BY pr.nombre`,
      [trago.id]
    );

    // Encabezado del trago
    ws.mergeCells(fila, 1, fila, 5);
    const cabecera = ws.getCell(fila, 1);
    cabecera.value = trago.nombre.toUpperCase();
    cabecera.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    cabecera.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    cabecera.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(fila).height = 22;
    fila++;

    // Encabezado de columnas
    const filaEncabezado = ws.getRow(fila);
    filaEncabezado.values = ['INGREDIENTE', 'CANTIDAD', 'UNIDAD', 'PRECIO UNITARIO', 'COSTO'];
    filaEncabezado.eachCell(c => {
      c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    fila++;

    if (ingredientes.length === 0) {
      const filaVacia = ws.getRow(fila);
      filaVacia.values = ['Sin ingredientes cargados todavía', '', '', '', ''];
      filaVacia.getCell(1).font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
      fila++;
    }

    ingredientes.forEach(ing => {
      const row = ws.getRow(fila);
      row.values = [
        ing.insumo_nombre,
        Number(ing.cantidad) || 0,
        ing.unidad || '',
        Number(ing.precio_unitario) || 0,
        Number(ing.costo_parcial) || 0,
      ];
      row.eachCell((c, col) => {
        c.font = { size: 10 };
        c.alignment = { horizontal: col === 1 ? 'left' : 'center', vertical: 'middle' };
        c.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
        if (col === 4 || col === 5) c.numFmt = '"$"#,##0.00';
      });
      fila++;
    });

    const costo = parseFloat(trago.costo_total) || 0;
    const margen = parseFloat(trago.margen_ganancia) || 0;
    const precioVenta = costo * (1 + margen / 100);

    ws.mergeCells(fila, 1, fila, 4);
    ws.getCell(fila, 1).value = 'TOTAL COSTO';
    ws.getCell(fila, 1).font = { bold: true, size: 10 };
    ws.getCell(fila, 1).alignment = { horizontal: 'right' };
    ws.getCell(fila, 5).value = costo;
    ws.getCell(fila, 5).numFmt = '"$"#,##0.00';
    ws.getCell(fila, 5).font = { bold: true, size: 10 };
    fila++;

    ws.mergeCells(fila, 1, fila, 4);
    ws.getCell(fila, 1).value = `PRECIO DE VENTA SUGERIDO (margen ${margen}%)`;
    ws.getCell(fila, 1).font = { bold: true, size: 10, color: { argb: 'FF16A34A' } };
    ws.getCell(fila, 1).alignment = { horizontal: 'right' };
    ws.getCell(fila, 5).value = precioVenta;
    ws.getCell(fila, 5).numFmt = '"$"#,##0.00';
    ws.getCell(fila, 5).font = { bold: true, size: 10, color: { argb: 'FF16A34A' } };
    fila++;

    fila++; // fila en blanco entre tragos
  }

  const nombreArchivo = 'Tragos Clasicos - actualizado.xlsx';
  await wb.xlsx.writeFile(nombreArchivo);
  console.log(`Listo: se generó "${nombreArchivo}" con ${tragos.length} tragos.`);

  await db.pool.end();
}

main().catch(err => {
  console.error('Error exportando la planilla de tragos clásicos:', err);
  process.exit(1);
});
