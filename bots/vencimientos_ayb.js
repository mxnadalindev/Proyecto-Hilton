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
const { enviarATodos } = require('../src/services/push');

// Usamos el alias "gemini-flash-latest" en vez de una versión fija — Google va
// dando de baja versiones puntuales con el tiempo, y el alias siempre apunta
// al modelo Flash vigente.
const MODELO = 'gemini-flash-latest';
const URL_GEMINI = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;

// Arma un fallback legible con los nombres, para cuando no hay API key o
// Gemini no devuelve nada útil — nunca queda un mensaje vacío o genérico.
function armarFallback(productos) {
  const listaCorta = productos
    .map(p => {
      const dias = parseInt(p.dias_restantes);
      return dias < 0 ? `${p.nombre} (vencido hace ${Math.abs(dias)}d)` : `${p.nombre} (vence en ${dias}d)`;
    })
    .join(', ');
  return `Hay ${productos.length} producto${productos.length !== 1 ? 's' : ''} por vencer en los próximos 15 días: ${listaCorta}.`;
}

async function pedirResumenAGemini(listaTexto, productos) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return `${armarFallback(productos)} (No se pudo generar un resumen con IA: falta configurar GEMINI_API_KEY en el .env)`;
  }

  const prompt = `Redactá un aviso corto y claro en español para el equipo de Alimentos y Bebidas de un hotel, avisando que hay ${productos.length} productos que vencen en los próximos 15 días. Sé breve (máximo 5 líneas), profesional y con sentido de urgencia moderada, e invitá a revisar el módulo de Inventario para tomar acción (usarlos, rotarlos o descartarlos) antes de que se echen a perder. Esta es la lista con nombre y días restantes:\n\n${listaTexto}`;

  try {
    const resp = await fetch(URL_GEMINI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await resp.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return texto || armarFallback(productos);
  } catch (e) {
    console.error('(!) Error consultando Gemini, se usa el fallback con nombres:', e.message);
    return armarFallback(productos);
  }
}

// El cuerpo del push SIEMPRE se arma con los nombres reales, sin pasar por
// la IA — así nunca depende de que Gemini responda bien. Se recorta a los
// primeros productos para que entre cómodo en una notificación.
function armarCuerpoPush(productos) {
  const MAX_NOMBRES = 4;
  const nombres = productos.map(p => {
    const dias = parseInt(p.dias_restantes);
    return dias < 0 ? `${p.nombre} (vencido)` : `${p.nombre} (${dias}d)`;
  });
  let cuerpo = nombres.slice(0, MAX_NOMBRES).join(', ');
  if (nombres.length > MAX_NOMBRES) {
    cuerpo += ` y ${nombres.length - MAX_NOMBRES} más`;
  }
  return cuerpo;
}

async function main() {
  console.log('=== Bot: vencimientos de Alimentos y Bebidas ===\n');

  const productos = await db.all2(`
    SELECT producto AS nombre, fecha_vencimiento,
           (fecha_vencimiento - CURRENT_DATE) AS dias_restantes
    FROM croutons_lotes
    WHERE estado = 'activo'
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
        return `- ${p.nombre} — ${etiqueta}`;
      })
      .join('\n');
    console.log(`Encontrados ${productos.length} productos por vencer o vencidos. Pidiéndole el resumen a Gemini...`);
    mensajeFinal = await pedirResumenAGemini(listaTexto, productos);
    console.log('\n--- Mensaje generado ---\n' + mensajeFinal);
  }

  const carpeta = path.join(__dirname, '..', 'avisos-bot');
  if (!fs.existsSync(carpeta)) fs.mkdirSync(carpeta, { recursive: true });
  const archivo = path.join(carpeta, 'vencimientos-ayb.txt');
  fs.writeFileSync(archivo, mensajeFinal, 'utf8');
  console.log(`\n✓ Guardado en: ${archivo}`);

  // Solo manda la notificación push si hay algo urgente que avisar — no
  // molesta al equipo con un push todos los días diciendo "todo bien".
  // canal: 'croutons' — solo le llega a quien activó los avisos desde esta
  // pantalla específica, nadie de otro módulo de A&B recibe esto.
  if (productos.length > 0) {
    const resultadoPush = await enviarATodos({
      titulo: `${productos.length} producto${productos.length !== 1 ? 's' : ''} por vencer`,
      cuerpo: armarCuerpoPush(productos),
      url: '/croutons',
      canal: 'croutons',
    });
    if (!resultadoPush.configurado) {
      console.log('\n(!) Notificaciones push no configuradas — faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en el .env');
    } else {
      console.log(`\n✓ Push enviado a ${resultadoPush.enviados} dispositivo(s) suscripto(s)${resultadoPush.fallidos ? ` (${resultadoPush.fallidos} fallaron)` : ''}.`);
    }
  }

  // Limpieza: borra definitivamente los lotes marcados "consumido" hace
  // más de 15 días. Los que están dentro de ese plazo se pueden restaurar
  // desde el panel de "Consumidos" en la web — recién después de 15 días
  // se van de verdad, sin vuelta atrás.
  try {
    const borrados = await db.run2(
      "DELETE FROM croutons_lotes WHERE estado='consumido' AND consumido_en < NOW() - INTERVAL '15 days'"
    );
    if (borrados?.changes > 0) {
      console.log(`\n✓ Limpieza: ${borrados.changes} lote(s) consumido(s) hace más de 15 días se borraron definitivamente.`);
    }
  } catch (e) {
    console.error('\n(!) Error en la limpieza de consumidos:', e.message);
  }

  process.exit(0);
}

main().catch(e => {
  console.error('✗ Error:', e.message);
  process.exit(1);
});
