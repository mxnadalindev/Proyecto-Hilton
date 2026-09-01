// Script de diagnóstico TEMPORAL — no modifica nada, solo lee y muestra info.
// Se puede borrar después de usarlo.
const { Pool } = require('pg');

const DBPASS = process.env.DB_PASSWORD || 'hilton2026';
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'hilton_db',
  user: process.env.DB_USER || 'hilton_user',
  password: DBPASS,
});

const SECTORES = ['Supervisores','Comis de Recepción','Panadería','Pastelería AM','Pastelería PM','Faro AM','Faro PM','Nocturno','BQTs Fríos','BQTs Calientes','Farolito','Cocina I+D'];

function hex(str) {
  return Buffer.from(str, 'utf8').toString('hex');
}

async function main() {
  console.log('=== SECTORES tal cual estan en el codigo (personal.js) ===');
  SECTORES.forEach(s => {
    console.log(`  "${s}"  len=${s.length}  hex=${hex(s)}`);
  });

  console.log('');
  console.log('=== departamento DISTINCT tal cual estan en la base ===');
  const res = await pool.query('SELECT DISTINCT departamento FROM usuarios WHERE departamento IS NOT NULL ORDER BY departamento');
  res.rows.forEach(r => {
    const d = r.departamento;
    console.log(`  "${d}"  len=${d.length}  hex=${hex(d)}  ¿esta en SECTORES (===)? ${SECTORES.includes(d)}`);
  });

  console.log('');
  console.log('=== Prueba de la consulta real (departamento = ANY($1)) ===');
  const r2 = await pool.query('SELECT departamento, count(*) FROM usuarios WHERE departamento = ANY($1) GROUP BY departamento ORDER BY departamento', [SECTORES]);
  console.log('Sectores que SI matchean en la consulta real:');
  r2.rows.forEach(r => console.log(`  ${r.departamento}: ${r.count}`));

  await pool.end();
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
