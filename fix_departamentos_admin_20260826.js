// Script de un solo uso para arreglar los departamentos de las cuentas
// admin que quedaron mal después de las últimas pruebas.
//
// Qué hace:
//   1. Muestra el estado actual de todas las cuentas con rol admin.
//   2. Pone a admin2 (admin2@hilton.com) en departamento = 'ayb'.
//   3. Le saca el departamento a Administrador (admin@hilton.com) para que
//      vuelva a ser el "admin general" (sin departamento propio) — es el
//      único tipo de cuenta que puede entrar a Configuración y cambiarle
//      el departamento a los demás, y ahora mismo no queda ninguna así.
//   4. Muestra el estado final para confirmar.
//
// Si NO querés que "Administrador" sea el admin general (por ejemplo, si
// preferís que sea otra cuenta), avisame y lo ajustamos — este script no
// borra ni inventa nada, solo corrige estos dos campos puntuales.
//
// Cómo correrlo (desde la carpeta del proyecto, con el server parado o
// prendido, da igual):
//   node fix_departamentos_admin_20260826.js

const db = require('./src/db/database');

async function main() {
  console.log('--- Estado actual (cuentas admin) ---');
  const antes = await db.all2(`SELECT id, nombre, email, rol, departamento FROM usuarios WHERE LOWER(rol) = 'admin' ORDER BY id`);
  console.table(antes);

  const admin2 = antes.find(u => (u.email || '').toLowerCase() === 'admin2@hilton.com');
  const general = antes.find(u => (u.email || '').toLowerCase() === 'admin@hilton.com');

  if (!admin2) {
    console.log('⚠️  No encontré ninguna cuenta admin con email admin2@hilton.com — no toqué nada de admin2. Revisá el email exacto arriba y avisame.');
  } else {
    await db.run2(`UPDATE usuarios SET departamento = 'ayb' WHERE id = $1`, [admin2.id]);
    console.log(`✓ admin2 (id ${admin2.id}) actualizado a departamento = 'ayb'`);
  }

  if (!general) {
    console.log('⚠️  No encontré ninguna cuenta admin con email admin@hilton.com — no toqué nada del admin general. Decime cuál cuenta querés que sea el admin general y lo ajusto.');
  } else {
    await db.run2(`UPDATE usuarios SET departamento = NULL WHERE id = $1`, [general.id]);
    console.log(`✓ Administrador (id ${general.id}) actualizado a departamento = NULL (admin general)`);
  }

  console.log('\n--- Estado final (cuentas admin) ---');
  const despues = await db.all2(`SELECT id, nombre, email, rol, departamento FROM usuarios WHERE LOWER(rol) = 'admin' ORDER BY id`);
  console.table(despues);

  process.exit(0);
}

main().catch(e => {
  console.error('Error corriendo el script:', e.message);
  process.exit(1);
});
