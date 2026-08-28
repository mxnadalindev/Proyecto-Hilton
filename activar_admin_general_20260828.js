/**
 * Marca a admin@hilton.com y admin2@hilton.com como "admin general"
 * (acceso completo en Configuración) usando la nueva columna
 * es_admin_general, SIN tocar su departamento — así cada uno sigue viendo
 * solo su propio sector en Personal/Horarios (sin mezclar Cocina con AYB),
 * pero ambos conservan Backups/Auditoría completa/Usuarios sin acotar en
 * Configuración.
 *
 * Requiere haber reiniciado el servidor al menos una vez con el código
 * nuevo (para que la migración cree la columna es_admin_general).
 *
 * Uso: parado en la carpeta del proyecto:
 *   node activar_admin_general_20260828.js
 */
const db = require('./src/db/database');

const CUENTAS = [
  { email: 'admin@hilton.com',  departamento: 'cocina' },
  { email: 'admin2@hilton.com', departamento: 'ayb' },
];

(async () => {
  try {
    for (const cuenta of CUENTAS) {
      const u = await db.get2('SELECT id, nombre, email, departamento, es_admin_general FROM usuarios WHERE email=$1', [cuenta.email]);
      if (!u) {
        console.log(`⚠️  No encontré "${cuenta.email}" — lo salteo.`);
        continue;
      }
      await db.run2('UPDATE usuarios SET departamento=$1, es_admin_general=true WHERE id=$2', [cuenta.departamento, u.id]);
      console.log(`✅ "${u.nombre}" (${u.email}): departamento='${cuenta.departamento}' + es_admin_general=true`);
    }
    console.log('\nListo. Cada cuenta ve solo su propio sector en Personal/Horarios, y las dos tienen acceso completo en Configuración (Backups, Auditoría sin acotar, Usuarios sin acotar, reasignar departamentos).');
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
