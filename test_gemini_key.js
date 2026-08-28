// Prueba rápida y aislada de GEMINI_API_KEY — no toca fotos ni la base de
// datos, solo hace una consulta de texto mínima para ver si la key
// responde. Correr parado en la carpeta del proyecto:
//   node test_gemini_key.js
require('dotenv').config();

const apiKey = process.env.GEMINI_API_KEY;
console.log('--------------------------------------------------');
console.log('GEMINI_API_KEY leída del .env:', apiKey ? `${apiKey.slice(0,6)}...${apiKey.slice(-4)} (${apiKey.length} caracteres)` : '(NO ESTÁ SETEADA)');
console.log('--------------------------------------------------');

if (!apiKey) {
  console.log('❌ No hay GEMINI_API_KEY en el .env. Revisá que el archivo .env tenga la línea GEMINI_API_KEY=tu_key_acá (sin comillas, sin espacios).');
  process.exit(1);
}

const MODELO = 'gemini-flash-latest';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${apiKey}`;

(async () => {
  const inicio = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Respondé solo con la palabra: OK' }] }] })
    });
    clearTimeout(timer);
    const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
    const texto = await resp.text();
    console.log(`Respondió en ${segundos}s con status HTTP ${resp.status}`);
    console.log('--------------------------------------------------');
    if (resp.ok) {
      console.log('✅ LA KEY FUNCIONA. Respuesta de Gemini:');
      console.log(texto.slice(0, 500));
    } else {
      console.log('❌ LA KEY DIO ERROR. Respuesta completa de Google:');
      console.log(texto.slice(0, 800));
      console.log('--------------------------------------------------');
      if (resp.status === 400) console.log('Pista: normalmente 400 = la key está mal copiada/es inválida.');
      if (resp.status === 403) console.log('Pista: normalmente 403 = a esa key/proyecto le falta habilitar la "Generative Language API" en Google Cloud, o la key tiene restricciones (IP/referrer) que bloquean esta PC.');
      if (resp.status === 429) console.log('Pista: 429 = se acabó la cuota gratuita de ese proyecto/key por hoy.');
    }
  } catch (e) {
    const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(`❌ NO HUBO RESPUESTA en ${segundos}s.`);
    console.log('Error:', e.message, e.cause || '');
    console.log('Pista: esto es de conexión (no de la key) — un firewall/antivirus/proxy puede estar bloqueando la salida a Google.');
  }
})();
