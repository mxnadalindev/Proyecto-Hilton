/**
 * Devuelve admin@hilton.com a ser admin de Cocina (departamento='cocina'),
 * como estaba antes de que lo convirtiéramos en "admin general" para
 * probar Backups/Auditoría/Seguridad. Esas cuentas de prueba (admin y
 * admin2) van a desaparecer cuando se den de alta los supervisores reales,
 * así que por ahora no hace falta mantener ningún admin general — solo
 * volver esta cuenta a Cocina para que Personal deje de mezclarla con AYB.
 *
 * Uso: parado en la carpeta del proyecto:
 *   node volver_admin_cocina.js
 */
const db = require('./src/db/database');

(async () => {
  try {
    const usuario = await db.get2(
      'SELECT id, nombre, email, rol, departamento FROM usuarios WHERE email = $1',
      ['admin@hilton.com']
    );
    if (!usuario) {
      console.log('No encontré ningún usuario con el email "admin@hilton.com".');
      process.exit(1);
    }
    console.log('Encontrado:', usuario);
    await db.run2("UPDATE usuarios SET departamento = 'cocina' WHERE id = $1", [usuario.id]);
    console.log(`Listo: "${usuario.nombre}" (${usuario.email}) vuelve a tener departamento='cocina'. En Personal ya no debería mezclarse con AYB. (Ojo: esta cuenta deja de ver Backups/Auditoría/Seguridad en Configuración — si necesitás eso, avisá y armamos una cuenta general aparte.)`);
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
