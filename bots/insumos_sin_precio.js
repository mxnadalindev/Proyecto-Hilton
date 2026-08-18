// bots/insumos_sin_precio.js
// Revisa qué insumos quedaron sin precio cargado, arma un resumen con IA
// (Gemini, la misma clave que ya usás para leer facturas), y lo guarda en
// un archivo de texto. Pensado para programarse con el Programador de
// tareas de Windows (corre solo, sin n8n).
//
// Uso manual: node bots/insumos_sin_precio.js   (desde la raíz del proyecto)

require('dotenv').config();
const db = require('../src/db/database');
const fs = require('fs');
const path = require('path');

const MODELO = 'gemini-2.5-flash';
const URL_GEMINI = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;

async function pedirResumenAGemini(listaTexto, cantidad) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return `Hay ${cantidad} insumos sin precio cargado. (No se pudo generar un resumen con IA: falta configurar GEMINI_API_KEY en el .env)`;
  }

  const prompt = `Redactá un mensaje corto y claro en español para el equipo de cocina de un hotel, avisando que hay ${cantidad} insumos sin precio cargado esta semana. Sé breve (máximo 4 líneas), profesional, y terminá invitando a cargarlos en el módulo de Costos del portal. Esta es la lista, resumila si son muchos (no hace falta nombrarlos todos):\n\n${listaTexto}`;

  const resp = await fetch(URL_GEMINI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    || `Hay ${cantidad} insumos sin precio cargado. (La IA no devolvió una respuesta válida)`;
}

async function main() {
  console.log('=== Bot: insumos sin precio ===\n');

  const insumos = await db.all2(`
    SELECT codigo, nombre, categoria
    FROM insumos
    WHERE precio_unitario IS NULL OR precio_unitario = 0
    ORDER BY categoria, nombre
  `);

  let mensajeFinal;
  if (insumos.length === 0) {
    mensajeFinal = 'Esta semana no hay insumos sin precio cargado. Todo al día. ✓';
    console.log(mensajeFinal);
  } else {
    const listaTexto = insumos
      .map(i => `- ${i.nombre} (${i.categoria || 'sin categoría'}, código ${i.codigo || 's/c'})`)
      .join('\n');
    console.log(`Encontrados ${insumos.length} insumos sin precio. Pidiéndole el resumen a Gemini...`);
    mensajeFinal = await pedirResumenAGemini(listaTexto, insumos.length);
    console.log('\n--- Mensaje generado ---\n' + mensajeFinal);
  }

  const carpeta = path.join(__dirname, '..', 'avisos-bot');
  if (!fs.existsSync(carpeta)) fs.mkdirSync(carpeta, { recursive: true });
  const archivo = path.join(carpeta, 'insumos-sin-precio.txt');
  fs.writeFileSync(archivo, mensajeFinal, 'utf8');

  console.log(`\n✓ Guardado en: ${archivo}`);
  process.exit(0);
}

main().catch(e => {
  console.error('✗ Error:', e.message);
  process.exit(1);
});
