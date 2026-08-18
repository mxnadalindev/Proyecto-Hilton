// bots/vencimientos_ayb.js
// Revisa qué productos de Alimentos y Bebidas vencen en los próximos 15
// días, arma un aviso con IA, y lo guarda en un archivo de texto. Pensado
// para programarse con el Programador de tareas de Windows (corre solo).
//
// Uso manual: node bots/vencimientos_ayb.js   (desde la raíz del proyecto)

require('dotenv').config();
const db = require('../src/db/database');
const fs = require('fs');
const path = require('path');

const MODELO = 'gemini-2.5-flash';
const URL_GEMINI = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;

async function pedirResumenAGemini(listaTexto, cantidad) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return `Hay ${cantidad} productos por vencer en los próximos 15 días. (No se pudo generar un resumen con IA: falta configurar GEMINI_API_KEY en el .env)`;
  }

  const prompt = `Redactá un aviso corto y claro en español para el equipo de Alimentos y Bebidas de un hotel, avisando que hay ${cantidad} productos que vencen en los próximos 15 días. Sé breve (máximo 5 líneas), profesional y con sentido de urgencia moderada, e invitá a revisar el módulo de Inventario para tomar acción (usarlos, rotarlos o descartarlos) antes de que se echen a perder. Esta es la lista con nombre y días restantes:\n\n${listaTexto}`;

  const resp = await fetch(URL_GEMINI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    || `Hay ${cantidad} productos por vencer en los próximos 15 días. (La IA no devolvió una respuesta válida)`;
}

async function main() {
  console.log('=== Bot: vencimientos de Alimentos y Bebidas ===\n');

  const productos = await db.all2(`
    SELECT nombre, categoria, fecha_vencimiento,
           (fecha_vencimiento - CURRENT_DATE) AS dias_restantes
    FROM inventario_ayb
    WHERE fecha_vencimiento IS NOT NULL
      AND fecha_vencimiento <= CURRENT_DATE + INTERVAL '15 days'
    ORDER BY fecha_vencimiento ASC
  `);

  let mensajeFinal;
  if (productos.length === 0) {
    mensajeFinal = 'No hay productos por vencer en los próximos 15 días. Todo al día. ✓';
    console.log(mensajeFinal);
  } else {
    const listaTexto = productos
      .map(p => {
        const dias = parseInt(p.dias_restantes);
        const etiqueta = dias < 0 ? `VENCIDO hace ${Math.abs(dias)} días` : `vence en ${dias} días`;
        return `- ${p.nombre} (${p.categoria || 'sin categoría'}) — ${etiqueta}`;
      })
      .join('\n');
    console.log(`Encontrados ${productos.length} productos por vencer o vencidos. Pidiéndole el resumen a Gemini...`);
    mensajeFinal = await pedirResumenAGemini(listaTexto, productos.length);
    console.log('\n--- Mensaje generado ---\n' + mensajeFinal);
  }

  const carpeta = path.join(__dirname, '..', 'avisos-bot');
  if (!fs.existsSync(carpeta)) fs.mkdirSync(carpeta, { recursive: true });
  const archivo = path.join(carpeta, 'vencimientos-ayb.txt');
  fs.writeFileSync(archivo, mensajeFinal, 'utf8');

  console.log(`\n✓ Guardado en: ${archivo}`);
  process.exit(0);
}

main().catch(e => {
  console.error('✗ Error:', e.message);
  process.exit(1);
});
