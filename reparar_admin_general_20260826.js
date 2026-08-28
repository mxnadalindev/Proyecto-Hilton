/**
 * Arreglo puntual: la cuenta "admin general" (la que desbloquea Backups,
 * Auditoría y Seguridad en Configuración) es la que tiene rol='admin' Y
 * departamento en null/vacío — así lo define src/routes/configuracion.js
 * (función esAdminGeneral). Si esa cuenta terminó con un departamento
 * cargado (cocina/ayb/etc.), deja de contar como admin general y esas tres
 * secciones desaparecen para todo el mundo, porque el único botón que
 * cambia el departamento de alguien (Configuración → cambiar departamento)
 * también está reservado a un admin general — sin uno, nadie puede
 * arreglarlo desde la web. Este script lo arregla directo en la base.
 *
 * Uso: parado en la carpeta del proyecto (donde está server.js):
 *   node scripts_reparar_admin_general.js
 *
 * Por defecto apunta a admin@hilton.com (la cuenta que crea el sistema
 * por default). Si tu admin general real tiene otro email, pasalo como
 * argumento:
 *   node scripts_reparar_admin_general.js otroemail@hilton.com
 */
const db = require('./src/db/database');

(async () => {
  const email = process.argv[2] || 'admin@hilton.com';
  try {
    const usuario = await db.get2(
      'SELECT id, nombre, email, rol, departamento FROM usuarios WHERE email = $1',
      [email]
    );
    if (!usuario) {
      console.log(`No encontré ningún usuario con el email "${email}".`);
      console.log('Pasá el email correcto como argumento, ej:');
      console.log('  node scripts_reparar_admin_general.js tuadmin@hilton.com');
      process.exit(1);
    }
    console.log('Encontrado:', usuario);
    if (usuario.rol !== 'admin') {
      console.log(`Ojo: este usuario tiene rol "${usuario.rol}", no "admin". Lo actualizo igual, pero convendría que sea admin.`);
    }
    if (!usuario.departamento) {
      console.log('Ya tiene el departamento vacío — ya debería estar funcionando como admin general. Si igual no ves Backups/Auditoría/Seguridad, avisá y lo revisamos de otra forma.');
      process.exit(0);
    }
    await db.run2('UPDATE usuarios SET departamento = NULL WHERE id = $1', [usuario.id]);
    console.log(`Listo: a "${usuario.nombre}" (${usuario.email}) le vacié el departamento (antes: "${usuario.departamento}"). Ahora es admin general — entrá a Configuración con esta cuenta y deberías ver Backups, Auditoría y Seguridad.`);
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
