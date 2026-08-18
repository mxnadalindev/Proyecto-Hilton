const fs = require('fs');

// Usamos el alias "gemini-flash-latest" en vez de un nombre de versión fijo
// (como "gemini-2.5-flash") porque Google va dando de baja versiones puntuales
// con el tiempo. El alias siempre apunta al modelo Flash vigente, así este
// código no se rompe de nuevo la próxima vez que cambien de versión.
const MODELO = 'gemini-flash-latest';
const URL_BASE = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;

const PROMPT = `Sos un asistente que lee documentos de compra de insumos gastronómicos (proveedores de un hotel).
Te paso la imagen de un documento. Devolvé ÚNICAMENTE un JSON, sin texto adicional, sin explicación, sin markdown ni backticks, con este formato exacto:

{"tipo_documento": "...", "items": [...]}

PASO 1 — Identificá "tipo_documento". Puede ser uno de estos 4 valores:
- "factura": es una factura de compra real (remito, factura A/B/C, ticket de compra).
- "nota_credito": es una Nota de Crédito — un descuento, devolución o bonificación del proveedor. NO es una compra.
- "nota_debito": es una Nota de Débito — un cargo adicional del proveedor. Tampoco es una compra de insumos con precio unitario confiable.
- "otro": cualquier otra cosa (imagen ilegible, no es un documento de compra, etc.)

PASO 2 — Armá "items":
- Si "tipo_documento" NO es "factura", "items" tiene que ir SIEMPRE vacío: []. Nunca extraigas productos ni montos de una nota de crédito o de débito, aunque la imagen tenga una tabla con productos y números — esos montos son ajustes, no precios de compra, y no hay que usarlos para actualizar precios.
- Si "tipo_documento" SÍ es "factura", cada elemento de "items" debe tener estos campos:
  - "nombre": el nombre del producto tal como figura en la factura (string)
  - "cantidad": la cantidad comprada (número, usá 1 si no está claro)
  - "unidad": la unidad (ej: "kg", "lt", "unidad", "caja", "paquete")
  - "precio_unitario": el precio unitario en pesos, SIN el símbolo $ y SIN separador de miles (número, ej: 18500.50). SIEMPRE tiene que ser un número POSITIVO mayor a cero. Si en la factura ese renglón aparece como negativo, como una bonificación, o como un descuento aplicado dentro de la misma factura, NO incluyas ese ítem en el array.

Si no podés leer algún campo con confianza, no incluyas ese ítem.

Ejemplos de respuesta:
{"tipo_documento":"factura","items":[{"nombre":"Harina 000 x 25kg","cantidad":2,"unidad":"unidad","precio_unitario":18500},{"nombre":"Aceite de girasol 5L","cantidad":4,"unidad":"unidad","precio_unitario":6200}]}
{"tipo_documento":"nota_credito","items":[]}`;

function mimeDesdeExtension(rutaArchivo) {
  const ext = rutaArchivo.toLowerCase().split('.').pop();
  const mapa = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  return mapa[ext] || 'image/jpeg';
}

/**
 * Analiza una imagen de documento de compra con Gemini.
 * Identifica si es una factura real o una nota de crédito/débito (que NO se procesa),
 * y descarta cualquier ítem con precio negativo o cero como capa de seguridad extra,
 * por si el modelo no respetara la instrucción del prompt.
 *
 * @param {string} rutaImagen - ruta absoluta o relativa al archivo de imagen ya subido
 * @returns {Promise<{tipoDocumento: string, items: Array<{nombre:string, cantidad:number, unidad:string, precio_unitario:number}>}>}
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

  let respuesta;
  try {
    respuesta = JSON.parse(textoRespuesta);
  } catch (e) {
    throw new Error('No se pudo interpretar la respuesta de Gemini como JSON: ' + textoRespuesta.slice(0, 200));
  }

  // Compatibilidad: si por algún motivo Gemini devolviera el formato viejo
  // (un array suelto en vez de {tipo_documento, items}), lo tratamos como factura.
  const tipoDocumento = Array.isArray(respuesta) ? 'factura' : (respuesta?.tipo_documento || 'otro');
  const itemsCrudos = Array.isArray(respuesta) ? respuesta : (respuesta?.items || []);

  if (!Array.isArray(itemsCrudos)) {
    return { tipoDocumento, items: [] };
  }

  // Sanitizamos: descartamos ítems incompletos y, como capa de seguridad extra,
  // CUALQUIER precio en 0 o negativo — sin importar lo que haya dicho el modelo.
  const items = itemsCrudos
    .filter(it => it && it.nombre && it.precio_unitario != null)
    .map(it => ({
      nombre: String(it.nombre).trim(),
      cantidad: parseFloat(it.cantidad) || 1,
      unidad: it.unidad ? String(it.unidad).trim() : '',
      precio_unitario: parseFloat(it.precio_unitario) || 0
    }))
    .filter(it => it.precio_unitario > 0);

  return { tipoDocumento, items };
}

module.exports = { analizarFactura };
