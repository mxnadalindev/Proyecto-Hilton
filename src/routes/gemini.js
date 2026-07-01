const fs = require('fs');

const MODELO = 'gemini-2.5-flash';
const URL_BASE = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;

const PROMPT = `Sos un asistente que lee facturas de insumos gastronómicos (proveedores de un hotel).
Te paso la imagen de una factura. Devolvé ÚNICAMENTE un JSON array, sin texto adicional, sin explicación, sin markdown ni backticks.

Cada elemento del array debe tener estos campos:
- "nombre": el nombre del producto tal como figura en la factura (string)
- "cantidad": la cantidad comprada (número, usá 1 si no está claro)
- "unidad": la unidad (ej: "kg", "lt", "unidad", "caja", "paquete")
- "precio_unitario": el precio unitario en pesos, SIN el símbolo $ y SIN separador de miles (número, ej: 18500.50)

Si no podés leer algún campo con confianza, no incluyas ese ítem en el array.
Si la imagen no es una factura o no se puede leer, devolvé un array vacío: []

Ejemplo de formato de respuesta:
[{"nombre":"Harina 000 x 25kg","cantidad":2,"unidad":"unidad","precio_unitario":18500},{"nombre":"Aceite de girasol 5L","cantidad":4,"unidad":"unidad","precio_unitario":6200}]`;

function mimeDesdeExtension(rutaArchivo) {
  const ext = rutaArchivo.toLowerCase().split('.').pop();
  const mapa = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  return mapa[ext] || 'image/jpeg';
}

/**
 * Analiza una imagen de factura con Gemini y devuelve un array de ítems detectados.
 * @param {string} rutaImagen - ruta absoluta o relativa al archivo de imagen ya subido
 * @returns {Promise<Array<{nombre:string, cantidad:number, unidad:string, precio_unitario:number}>>}
 */
async function analizarFactura(rutaImagen) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta GEMINI_API_KEY en el archivo .env');
  }

  const bytes = fs.readFileSync(rutaImagen);
  const base64 = bytes.toString('base64');
  const mimeType = mimeDesdeExtension(rutaImagen);

  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: mimeType, data: base64 } }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  const resp = await fetch(`${URL_BASE}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini respondió ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const textoRespuesta = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textoRespuesta) {
    throw new Error('Gemini no devolvió contenido legible.');
  }

  let items;
  try {
    items = JSON.parse(textoRespuesta);
  } catch (e) {
    throw new Error('No se pudo interpretar la respuesta de Gemini como JSON: ' + textoRespuesta.slice(0, 200));
  }

  if (!Array.isArray(items)) return [];

  // Sanitizamos y descartamos ítems incompletos
  return items
    .filter(it => it && it.nombre && it.precio_unitario != null)
    .map(it => ({
      nombre: String(it.nombre).trim(),
      cantidad: parseFloat(it.cantidad) || 1,
      unidad: it.unidad ? String(it.unidad).trim() : '',
      precio_unitario: parseFloat(it.precio_unitario) || 0
    }));
}

module.exports = { analizarFactura };
