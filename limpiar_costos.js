// Script de limpieza — vacía las tablas de Costos para volver a probar desde cero.
// Uso: node limpiar_costos.js   (correr desde la raíz del proyecto)
const db = require('./src/db/database');

(async () => {
  try {
    await db.run2('DELETE FROM plato_insumos');
    await db.run2('DELETE FROM historial_precios');
    await db.run2('DELETE FROM platos_costo');
    await db.run2('DELETE FROM insumos');
    console.log('Listo — insumos, platos y historial de precios vaciados.');
  } catch (e) {
    console.error('Error limpiando:', e.message);
  } finally {
    process.exit(0);
  }
})();
