// importar_categorias_croutons.js
// Carga (o actualiza) en el catálogo productos_ayb la categoría de cada
// producto de las listas que pasó Carolina. Si el producto ya existe
// (por nombre, sin importar mayúsculas), le actualiza la categoría sin
// tocar el stock mínimo que ya tuviera cargado. Si no existe, lo crea.
//
// Uso: node importar_categorias_croutons.js   (desde la raíz del proyecto)

require('dotenv').config();
const db = require('./src/db/database');

const productos = [
  // ── Golosinas (lista 1) ──
  { nombre: 'Snacky Terrabusi', categoria: 'Golosinas' },
  { nombre: 'Rocklets 40gr', categoria: 'Golosinas' },
  { nombre: 'Snickers 48gr', categoria: 'Golosinas' },
  { nombre: 'Chocolate Cachafaz', categoria: 'Golosinas' },
  { nombre: 'Galletita Cachafaz', categoria: 'Golosinas' },
  { nombre: 'Chocolate Kinder', categoria: 'Golosinas' },
  { nombre: 'Galletitas Donuts', categoria: 'Golosinas' },
  { nombre: 'Chocolate Block 38gr', categoria: 'Golosinas' },
  { nombre: 'Chocolate Milka Leche', categoria: 'Golosinas' },
  { nombre: 'Chocolate Milka Almendra 110 fgra', categoria: 'Golosinas' },
  { nombre: 'Toblerone 100gr', categoria: 'Golosinas' },
  { nombre: 'Mini Oreo', categoria: 'Golosinas' },
  { nombre: 'Snack de Coco', categoria: 'Golosinas' },
  { nombre: 'Snack caju', categoria: 'Golosinas' },
  { nombre: 'Fruta seca con chocolate', categoria: 'Golosinas' },
  { nombre: 'Barra Muecas', categoria: 'Golosinas' },
  { nombre: 'Papas Boutiques', categoria: 'Golosinas' },
  { nombre: 'Frasco Dulce de leche Cachafaz', categoria: 'Golosinas' },
  { nombre: 'tic tac', categoria: 'Golosinas' },
  { nombre: 'Alfajor de yerba mate', categoria: 'Golosinas' },
  { nombre: 'Franui', categoria: 'Golosinas' },

  // ── Bebidas (lista 1) ──
  { nombre: 'Te caja x 12 saquitos', categoria: 'Bebidas' },
  { nombre: 'Lecha chocolatada', categoria: 'Bebidas' },
  { nombre: 'Jugo citrix 200 cc', categoria: 'Bebidas' },
  { nombre: 'Gin Heredero', categoria: 'Bebidas' },
  { nombre: 'Gin Heredero lata', categoria: 'Bebidas' },
  { nombre: 'Coloreada', categoria: 'Bebidas' }, // revisar nombre, texto poco claro en la lista original
  { nombre: 'Lemon tonic', categoria: 'Bebidas' },
  { nombre: 'Mate', categoria: 'Bebidas' },
  { nombre: 'Tonica mate', categoria: 'Bebidas' },
  { nombre: 'Yerba', categoria: 'Bebidas' },
  { nombre: 'Agua Perrier lata x 250 ml', categoria: 'Bebidas' },

  // ── Sin categoría clara — revisar ──
  { nombre: 'Aceite de oliva estuche', categoria: 'Almacén' },

  // ── Golosinas (lista 2, ya venía con el título "Golosinas") ──
  { nombre: 'Cja de Alfajores chocolate x 6', categoria: 'Golosinas' },
  { nombre: 'Cja de Alfajores Maicena x 6', categoria: 'Golosinas' },
  { nombre: 'Cja de Alfajores Mousee x 6', categoria: 'Golosinas' },
  { nombre: 'Cja de Conitos x6', categoria: 'Golosinas' },
  { nombre: 'Conito individual', categoria: 'Golosinas' },
  { nombre: 'Alfajor individual', categoria: 'Golosinas' },
  { nombre: 'Alfajor Vegano dulce de leche', categoria: 'Golosinas' },
  { nombre: 'Alfajor vegano de mani', categoria: 'Golosinas' },
  { nombre: 'Alfajor blanco Veganos', categoria: 'Golosinas' },
  { nombre: 'Alfajor de membrillo', categoria: 'Golosinas' },
  { nombre: 'Alfajor Dubai', categoria: 'Golosinas' },
  { nombre: 'Kit Kat 41,5 Grms (unidad)', categoria: 'Golosinas' },
  { nombre: 'Skittles 61,5 Grms', categoria: 'Golosinas' },
  { nombre: 'Vauquita', categoria: 'Golosinas' },
  { nombre: 'Vauquita XL', categoria: 'Golosinas' },
  { nombre: 'Cabsha 48 unid', categoria: 'Golosinas' },
  { nombre: 'Gomitas Mogul 12 unid', categoria: 'Golosinas' },
  { nombre: 'Mogul 360°', categoria: 'Golosinas' },
  { nombre: 'Marroc 60 unid', categoria: 'Golosinas' },
  { nombre: 'Marroc Cachafaz 54 unid', categoria: 'Golosinas' },
  { nombre: 'Ferrero x 3 unid', categoria: 'Golosinas' },
  { nombre: 'Ferrero x 8 unid', categoria: 'Golosinas' },
  { nombre: 'Crackers Natural', categoria: 'Golosinas' },
  { nombre: 'M & M', categoria: 'Golosinas' },
  { nombre: 'Mini Rodehisia', categoria: 'Golosinas' }, // revisar nombre, texto poco claro en la lista original
];

async function main() {
  console.log(`Importando categorías para ${productos.length} productos...\n`);
  let creados = 0;
  let actualizados = 0;

  for (const p of productos) {
    try {
      const existente = await db.get2(
        `SELECT id FROM productos_ayb WHERE LOWER(nombre) = LOWER($1) LIMIT 1`,
        [p.nombre]
      );
      if (existente) {
        await db.run2(`UPDATE productos_ayb SET categoria = $1 WHERE id = $2`, [p.categoria, existente.id]);
        actualizados++;
        console.log(`~ Actualizado: ${p.nombre} → ${p.categoria}`);
      } else {
        await db.run2(`INSERT INTO productos_ayb (nombre, categoria) VALUES ($1, $2)`, [p.nombre, p.categoria]);
        creados++;
        console.log(`+ Creado: ${p.nombre} → ${p.categoria}`);
      }
    } catch (e) {
      console.error(`✗ Error con "${p.nombre}":`, e.message);
    }
  }

  console.log(`\n✓ Listo. ${creados} creados, ${actualizados} actualizados de ${productos.length} totales.`);
  process.exit(0);
}

main().catch(e => {
  console.error('✗ Error general:', e.message);
  process.exit(1);
});
