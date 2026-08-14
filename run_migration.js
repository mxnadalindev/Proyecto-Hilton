// Corre la migración de Recetas (receta_insumos + receta_fotos)
// usando la misma conexión a Postgres que ya tiene el proyecto.
//
// Uso: parado en la raíz del proyecto, correr:
//   node run_migration.js

const fs = require('fs');
const path = require('path');
const db = require('./src/db/database');

async function main() {
  const sqlPath = path.join(__dirname, 'migration_recetas.sql');
  const sqlCompleto = fs.readFileSync(sqlPath, 'utf8');

  // Separa por statement (por ; al final de línea), ignorando comentarios y líneas vacías
  const statements = sqlCompleto
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.split('\n').every(l => l.trim().startsWith('--') || l.trim() === ''));

  console.log(`Ejecutando ${statements.length} sentencias SQL...`);

  for (const stmt of statements) {
    const primeraLinea = stmt.split('\n').find(l => l.trim() && !l.trim().startsWith('--'))?.trim() || stmt.slice(0, 60);
    try {
      await db.run2(stmt);
      console.log('OK  ->', primeraLinea.slice(0, 70));
    } catch (err) {
      console.error('ERROR en:', primeraLinea.slice(0, 70));
      console.error(err.message);
      process.exit(1);
    }
  }

  console.log('\nMigración completada correctamente.');
  process.exit(0);
}

main().catch(err => {
  console.error('Error inesperado:', err);
  process.exit(1);
});
