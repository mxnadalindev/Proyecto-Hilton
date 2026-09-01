// Arregla el doble-encoding UTF-8 en "departamento", "nombre" y "puesto".
// A diferencia del intento anterior con un archivo .sql, este script hace
// todo en JavaScript (que lee sus propios acentos bien, ya lo confirmamos
// con diagnostico_encoding.js) y manda los valores ya corregidos a Postgres
// como parámetros — nunca como texto SQL con acentos, así que no depende
// de cómo la consola de Windows/psql interpreten archivos con tildes.
const { Pool } = require('pg');

const DBPASS = process.env.DB_PASSWORD || 'hilton2026';
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'hilton_db',
  user: process.env.DB_USER || 'hilton_user',
  password: DBPASS,
});

// Revierte el doble-encoding: si el texto está corrupto (se codificó UTF-8
// y esos bytes se volvieron a leer como Latin1), reinterpretarlo como
// Latin1 y decodificarlo de nuevo como UTF-8 devuelve el texto original.
function arreglar(texto) {
  if (!texto) return texto;
  try {
    const reparado = Buffer.from(texto, 'latin1').toString('utf8');
    // Si el resultado tiene el caracter de reemplazo (U+FFFD), no era
    // corrupción de este tipo — dejamos el texto como estaba.
    if (reparado.includes('�')) return texto;
    return reparado;
  } catch (e) {
    return texto;
  }
}

async function arreglarColumna(columna) {
  const res = await pool.query(`SELECT id, ${columna} AS valor FROM usuarios WHERE ${columna} IS NOT NULL AND ${columna} LIKE '%Ã%'`);
  console.log(`Columna "${columna}": ${res.rows.length} fila(s) con el patrón de corrupción.`);
  for (const row of res.rows) {
    const arreglado = arreglar(row.valor);
    if (arreglado !== row.valor) {
      await pool.query(`UPDATE usuarios SET ${columna} = $1 WHERE id = $2`, [arreglado, row.id]);
      console.log(`  id=${row.id}: "${row.valor}" -> "${arreglado}"`);
    }
  }
}

async function main() {
  await arreglarColumna('departamento');
  await arreglarColumna('nombre');
  await arreglarColumna('puesto');

  const SECTORES = ['Supervisores','Comis de Recepción','Panadería','Pastelería AM','Pastelería PM','Faro AM','Faro PM','Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'];
  const check = await pool.query(
    `SELECT count(*) AS total FROM usuarios WHERE departamento = ANY($1) AND LOWER(rol) != 'admin'`,
    [SECTORES]
  );
  console.log('');
  console.log('=== Verificación final: total que debería ver Miembros de equipo ===');
  console.log(check.rows[0].total, '(debería ser 42)');

  await pool.end();
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
