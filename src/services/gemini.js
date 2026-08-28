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
- "factura": es CUALQUIER documento o anotación que muestre uno o más productos con su precio de compra — un remito, una factura A/B/C, un ticket de compra, el catálogo/lista de precios de un proveedor, e incluso una nota o anotación escrita a mano en un papel suelto (por ejemplo, alguien anotó a mano "Chocolate x unidad $3922"). NO hace falta que sea un comprobante fiscal formal ni que tenga membrete, CUIT, fecha, etc. — alcanza con que se pueda leer con confianza al menos un nombre de producto junto a un precio. La imagen puede estar rotada o inclinada, leela igual.
- "nota_credito": es una Nota de Crédito — un descuento, devolución o bonificación del proveedor. NO es una compra.
- "nota_debito": es una Nota de Débito — un cargo adicional del proveedor. Tampoco es una compra de insumos con precio unitario confiable.
- "otro": la imagen es ilegible, no tiene relación con productos/precios, o es una lista de personas/otro tipo de documento sin ningún producto con precio (ejemplo: una lista de empleados, un remito de mercadería sin precios, una foto sin texto).

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
{"tipo_documento":"factura","items":[{"nombre":"Chocolate Los Cuyanos","cantidad":1,"unidad":"unidad","precio_unitario":3922.65}]}
{"tipo_documento":"nota_credito","items":[]}`;

function mimeDesdeExtension(rutaArchivo) {
  const ext = rutaArchivo.toLowerCase().split('.').pop();
  const mapa = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  return mapa[ext] || 'image/jpeg';
}

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Llama a la API de Gemini con reintentos automáticos. Gemini devuelve
 * bastante seguido un 503 "high demand" (saturación transitoria del lado de
 * Google, no un error nuestro) — antes eso tiraba abajo la importación a la
 * primera. Ahora reintentamos hasta 3 veces con una espera creciente
 * (2s, 5s, 10s) antes de darnos por vencidos.
 *
 * OJO: solo reintenta en 503 (saturación transitoria). El 429 (cuota
 * agotada — "You exceeded your current quota") es un límite del plan, no
 * algo pasajero: la cuota gratuita se resetea recién al otro día, así que
 * reintentar unos segundos después no sirve de nada y solo demora el error.
 * En 429 cortamos al toque para que el mensaje llegue rápido.
 */
async function llamarGeminiConReintentos(url, opciones, intentos = 3) {
  const ESPERAS_MS = [2000, 5000, 10000];
  // Sin esto, si la conexión queda "colgada" (un firewall que descarta los
  // paquetes en silencio en vez de rechazarlos) el fetch nunca resuelve ni
  // rechaza — la pantalla se queda "pensando" para siempre y no queda nada
  // en el log del server para diagnosticar. Con el timeout, cortamos
  // nosotros mismos y al menos queda un error claro.
  // Subido de 25s a 45s: en redes corporativas con antivirus/EDR que
  // inspeccionan el tráfico HTTPS (como la de Hilton), ese análisis agrega
  // demora real antes de que el pedido llegue a destino — no significa que
  // esté cortado, solo que tarda más. Con 25s lo estábamos cortando
  // nosotros mismos antes de que Google llegara a responder.
  const TIMEOUT_MS = 45000;
  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    let resp;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      resp = await fetch(url, { ...opciones, signal: controller.signal });
    } catch (e) {
      // Esto NO es una respuesta de Gemini — es que el fetch ni siquiera
      // llegó a conectar (DNS, timeout, conexión rechazada, un firewall o
      // antivirus interceptando el certificado, etc.). Node solo dice
      // "fetch failed" y esconde el motivo real en e.cause, así que lo
      // sumamos al mensaje para poder diagnosticarlo la próxima vez.
      // Reintentamos igual que con el 503: puede ser un corte pasajero.
      if (e.name === 'AbortError') {
        ultimoError = new Error(`Gemini no respondió en ${TIMEOUT_MS / 1000}s — se cortó la espera. Probablemente la conexión a internet de esta PC está bloqueada, muy lenta, o algo (firewall/antivirus/proxy) está interceptando la conexión a Google.`);
      } else {
        const causa = e.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : '';
        ultimoError = new Error(`No se pudo conectar con Gemini: ${e.message}${causa}`);
      }
      if (i === intentos - 1) throw ultimoError;
      await esperar(ESPERAS_MS[i] || 10000);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (resp.ok) return resp;

    const reintentable = resp.status === 503;
    const errText = await resp.text();
    ultimoError = new Error(`Gemini respondió ${resp.status}: ${errText}`);

    if (!reintentable || i === intentos - 1) throw ultimoError;
    await esperar(ESPERAS_MS[i] || 10000);
  }
  throw ultimoError;
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

  const resp = await llamarGeminiConReintentos(`${URL_BASE}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

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

const PROMPT_REMITO_CROUTONS = `Sos un asistente que lee remitos, etiquetas de caja o fotos de mercadería de croutons recibida en la cocina de un hotel.
Te paso la imagen. Devolvé ÚNICAMENTE un JSON, sin texto adicional, sin explicación, sin markdown ni backticks, con este formato exacto:

{"tipo_documento": "...", "items": [...]}

PASO 1 — Identificá "tipo_documento":
- "remito": es un remito, etiqueta de caja/bolsa, ticket de entrega, o cualquier documento/foto donde se pueda leer un producto con su fecha de vencimiento.
- "otro": cualquier otra cosa (imagen ilegible, no tiene relación con una entrega de mercadería, etc.)

PASO 2 — Armá "items":
- Si "tipo_documento" es "otro", "items" va vacío: [].
- Si es "remito", cada elemento de "items" debe tener estos campos:
  - "nombre": el nombre del producto tal como figura (ej: "Croutons clásicos", "Croutons de ajo y hierbas"). Si no se especifica variedad, usá "Croutons".
  - "cantidad": la cantidad recibida (número, usá 1 si no está claro)
  - "unidad": la unidad (ej: "kg", "unidad", "caja", "bolsa", "paquete")
  - "proveedor": el nombre del proveedor si figura en la imagen (string, dejalo vacío "" si no aparece)
  - "fecha_vencimiento": la fecha de vencimiento o "vencimiento"/"consumir antes de"/"best before" del producto, SIEMPRE en formato "YYYY-MM-DD". Si en la imagen la fecha viene como DD/MM/YYYY convertila. Si no podés leer una fecha de vencimiento con confianza para ese ítem, NO incluyas ese ítem (una fecha de vencimiento es obligatoria).

Ejemplo de respuesta:
{"tipo_documento":"remito","items":[{"nombre":"Croutons clásicos","cantidad":5,"unidad":"kg","proveedor":"Distribuidora ABC","fecha_vencimiento":"2026-11-20"}]}
{"tipo_documento":"otro","items":[]}`;

/**
 * Analiza una foto de remito/etiqueta de mercadería de croutons con Gemini,
 * extrayendo producto, cantidad, proveedor y fecha de vencimiento de cada ítem.
 * A diferencia de analizarFactura, acá la fecha de vencimiento es el dato
 * clave — un ítem sin fecha legible se descarta directamente.
 *
 * @param {string} rutaImagen - ruta al archivo de imagen ya subido
 * @returns {Promise<{tipoDocumento: string, items: Array<{nombre:string, cantidad:number, unidad:string, proveedor:string, fecha_vencimiento:string}>}>}
 */
async function analizarRemitoCroutons(rutaImagen) {
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
        { text: PROMPT_REMITO_CROUTONS },
        { inline_data: { mime_type: mimeType, data: base64 } }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  const resp = await llamarGeminiConReintentos(`${URL_BASE}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

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

  const tipoDocumento = respuesta?.tipo_documento || 'otro';
  const itemsCrudos = Array.isArray(respuesta?.items) ? respuesta.items : [];

  const REGEX_FECHA = /^\d{4}-\d{2}-\d{2}$/;

  const items = itemsCrudos
    .filter(it => it && it.nombre && it.fecha_vencimiento && REGEX_FECHA.test(String(it.fecha_vencimiento).trim()))
    .map(it => ({
      nombre: String(it.nombre).trim(),
      cantidad: parseFloat(it.cantidad) || 1,
      unidad: it.unidad ? String(it.unidad).trim() : 'kg',
      proveedor: it.proveedor ? String(it.proveedor).trim() : '',
      fecha_vencimiento: String(it.fecha_vencimiento).trim()
    }));

  return { tipoDocumento, items };
}

const PROMPT_PLANILLA_MOZOS = `Sos un asistente que lee planillas, listas o cuadros con el personal eventual (mozos) de Alimentos y Bebidas de un hotel.
Te paso una imagen — puede ser una foto de una hoja impresa, una lista escrita a mano, una captura de pantalla de una planilla de cálculo, o cualquier formato con nombres de personas.
Devolvé ÚNICAMENTE un JSON, sin texto adicional, sin explicación, sin markdown ni backticks, con este formato exacto:

{"tipo_documento": "...", "items": [...]}

PASO 1 — Identificá "tipo_documento":
- "planilla": la imagen tiene una lista reconocible de personas (nombres de mozos/empleados), aunque le falten columnas.
- "otro": cualquier otra cosa (imagen ilegible, no tiene relación con una lista de personal, etc.)

PASO 2 — Armá "items":
- Si "tipo_documento" es "otro", "items" va vacío: [].
- Si es "planilla", cada elemento de "items" corresponde a UNA persona y debe tener estos campos:
  - "nombre": nombre y apellido tal como figura (string, obligatorio — si no se puede leer un nombre para una fila, no incluyas esa fila).
  - "cuil": el CUIL o DNI de esa persona si figura en la imagen, como string de solo números sin guiones ni espacios (ej: "20432824927"). Si no aparece, dejalo como "" (vacío) — no inventes un número.
  - "modalidad": tiene que ser EXACTAMENTE uno de estos 3 valores: "Eventual", "Fijo" o "Agencia". Elegilo según lo que diga la planilla (columna de tipo/modalidad/contrato). Si no hay forma de saberlo, usá "Eventual" (es el valor más común para mozos de A&B).

No repitas la misma persona dos veces. Ignorá encabezados de columna, totales, o filas vacías.

Ejemplo de respuesta:
{"tipo_documento":"planilla","items":[{"nombre":"Juan Pérez","cuil":"20321456789","modalidad":"Eventual"},{"nombre":"María Gómez","cuil":"","modalidad":"Fijo"}]}
{"tipo_documento":"otro","items":[]}`;

/**
 * Analiza una foto de planilla/lista de personal de A&B con Gemini,
 * extrayendo nombre, CUIL (si figura) y modalidad de cada persona.
 * Igual patrón que analizarRemitoCroutons: siempre devuelve una lista para
 * revisar y corregir a mano antes de cargarla, nunca inserta directo.
 *
 * @param {string} rutaImagen - ruta al archivo de imagen ya subido
 * @returns {Promise<{tipoDocumento: string, items: Array<{nombre:string, cuil:string, modalidad:string}>}>}
 */
async function analizarPlanillaMozos(rutaImagen) {
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
        { text: PROMPT_PLANILLA_MOZOS },
        { inline_data: { mime_type: mimeType, data: base64 } }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  const resp = await llamarGeminiConReintentos(`${URL_BASE}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

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

  const tipoDocumento = respuesta?.tipo_documento || 'otro';
  const itemsCrudos = Array.isArray(respuesta?.items) ? respuesta.items : [];
  const MODALIDADES_VALIDAS = ['Eventual', 'Fijo', 'Agencia'];

  const items = itemsCrudos
    .filter(it => it && it.nombre && String(it.nombre).trim())
    .map(it => ({
      nombre: String(it.nombre).trim(),
      cuil: it.cuil ? String(it.cuil).replace(/[^0-9]/g, '') : '',
      modalidad: MODALIDADES_VALIDAS.includes(it.modalidad) ? it.modalidad : 'Eventual'
    }));

  return { tipoDocumento, items };
}

// Traduce cualquier error que puedan tirar analizarFactura /
// analizarRemitoCroutons / analizarPlanillaMozos a un mensaje en criollo
// para mostrarle al usuario. Centralizado acá para que las tres pantallas
// (Costos, Croutons, Personal) digan siempre lo mismo ante el mismo
// problema, en vez de tener la misma lógica de clasificación repetida y
// pudiendo desincronizarse en cada archivo.
function mensajeErrorGemini(e) {
  const msg = (e && e.message) || String(e);
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
    return 'Se acabó la cuota gratuita diaria de lectura de imágenes con IA. Se resetea sola al otro día — mientras tanto podés cargarlo a mano.';
  }
  if (/503|UNAVAILABLE|high demand/i.test(msg)) {
    return 'El servicio de lectura de imágenes está con mucha demanda en este momento. Esperá un minuto y probá de nuevo.';
  }
  if (/No se pudo conectar con Gemini|fetch failed|no respondió en/i.test(msg)) {
    return 'No se pudo conectar a internet para leer la imagen con IA. Revisá que esta PC tenga conexión a internet (y que ningún firewall, antivirus o proxy esté bloqueando la conexión) y probá de nuevo. Mientras tanto podés cargarlo a mano.';
  }
  return 'Error analizando la imagen: ' + msg;
}

module.exports = { analizarFactura, analizarRemitoCroutons, analizarPlanillaMozos, mensajeErrorGemini };
