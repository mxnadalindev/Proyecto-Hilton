// Borra el plato "basura" que quedó cargado por el bug del parser viejo
// (mezcló todos los ingredientes de los 33 platos de Pastelería en uno solo).
// Uso: node limpiar_plato_basura.js
const db = require('./src/db/database');

(async () => {
  try {
    const encontrados = await db.all2(
      "SELECT id, nombre FROM platos_costo WHERE nombre ILIKE '%desecho%' OR nombre ILIKE '%Peso Bruto%'"
    );
    if (encontrados.length === 0) {
      console.log('No se encontró ningún plato basura para borrar.');
    } else {
      for (const p of encontrados) {
        await db.run2('DELETE FROM plato_insumos WHERE plato_id=$1', [p.id]);
        await db.run2('DELETE FROM platos_costo WHERE id=$1', [p.id]);
        console.log('Borrado:', p.nombre);
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    process.exit(0);
  }
})();
