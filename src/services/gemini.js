const fs = require('fs');

// Usamos el alias "gemini-flash-latest" en vez de un nombre de versión fijo
// (como "gemini-2.5-flash") porque Google va dando de baja versiones puntuales
// con el tiempo. El alias siempre apunta al modelo Flash vigente, así este
// código no se rompe de nuevo la próxima vez que cambien de versión.
const MODELO = 'gemini-flash-latest';
const URL_BASE = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;

const PROMPT = `Sos un asistente que lee documentos de compra de insumos gastronómicos (proveedores de un hotel).
Te paso la imagen de un documento. Devolvé ÚNICAMENTE un JSON, sin texto adicional, sin explicación, sin markdown ni backticks, con este formato exacto:

{"tipo_documento": "...", "proveedor": "...", "numero_factura": "...", "items": [...]}

Los campos "proveedor" (nombre del proveedor/emisor si figura en el documento) y "numero_factura" (número o identificador del comprobante si figura) son adicionales al array de items — van UNA sola vez para todo el documento, no por ítem. Si no aparecen en la imagen, dejalos como "" (string vacío). Nunca inventes estos datos.

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
{"tipo_documento":"factura","proveedor":"Distribuidora ABC S.A.","numero_factura":"0001-00023456","items":[{"nombre":"Harina 000 x 25kg","cantidad":2,"unidad":"unidad","precio_unitario":18500},{"nombre":"Aceite de girasol 5L","cantidad":4,"unidad":"unidad","precio_unitario":6200}]}
{"tipo_documento":"factura","proveedor":"","numero_factura":"","items":[{"nombre":"Chocolate Los Cuyanos","cantidad":1,"unidad":"unidad","precio_unitario":3922.65}]}
{"tipo_documento":"nota_credito","proveedor":"","numero_factura":"","items":[]}`;

function mimeDesdeExtension(rutaArchivo) {
  const ext = rutaArchivo.toLowerCase().split('.').pop();
  // Lista ampliada de extensiones de imagen que Gemini acepta directamente,
  // más "pdf" (Costos ahora también acepta facturas en PDF). Esto es un
  // RESPALDO — ver mimeParaGemini() más abajo, que primero intenta usar el
  // tipo real que reportó el navegador al subir el archivo (más confiable
  // que adivinar por la extensión, sobre todo en fotos de celular que a
  // veces llegan con extensiones raras o sin extensión).
  const mapa = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif',
    pdf: 'application/pdf',
  };
  return mapa[ext] || 'image/jpeg';
}

// Tipos de imagen (+ PDF) que la API de Gemini acepta como inline_data.
// Si el navegador nos dijo un mimetype real y es uno de estos, se usa ese
// directamente — es más confiable que adivinar por la extensión del
// archivo, que puede venir rara (sobre todo en fotos sacadas desde el
// celular). Si no vino un mimetype reconocible, se cae al respaldo de
// mimeDesdeExtension().
const MIME_TYPES_ACEPTADOS_GEMINI = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp',
  'image/heic', 'image/heif', 'application/pdf',
]);

function mimeParaGemini(rutaImagen, mimeTypeReal) {
  if (mimeTypeReal && MIME_TYPES_ACEPTADOS_GEMINI.has(mimeTypeReal.toLowerCase())) {
    return mimeTypeReal.toLowerCase();
  }
  return mimeDesdeExtension(rutaImagen);
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
 * @param {string} [mimeTypeReal] - el mimetype que reportó el navegador al subir el
 *   archivo (req.file.mimetype de multer). Opcional — si no se pasa, se adivina por
 *   la extensión del archivo como antes. Pasarlo hace el reconocimiento de "es una
 *   imagen válida" más confiable, sobre todo con fotos de celular que a veces tienen
 *   una extensión rara o poco común.
 * @returns {Promise<{tipoDocumento: string, proveedor: string, numeroFactura: string, items: Array<{nombre:string, cantidad:number, unidad:string, precio_unitario:number}>}>}
 */
async function analizarFactura(rutaImagen, mimeTypeReal) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta GEMINI_API_KEY en el archivo .env');
  }

  const bytes = fs.readFileSync(rutaImagen);
  const base64 = bytes.toString('base64');
  const mimeType = mimeParaGemini(rutaImagen, mimeTypeReal);

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
  const proveedor = Array.isArray(respuesta) ? '' : String(respuesta?.proveedor || '').trim();
  const numeroFactura = Array.isArray(respuesta) ? '' : String(respuesta?.numero_factura || '').trim();

  if (!Array.isArray(itemsCrudos)) {
    return { tipoDocumento, proveedor, numeroFactura, items: [] };
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

  return { tipoDocumento, proveedor, numeroFactura, items };
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

const PROMPT_BOTELLA_AYB = `Sos un asistente que reconoce botellas de bebidas (alcohólicas y no alcohólicas) para el inventario de bar de un hotel.
Te paso una foto de una botella — puede estar en la mano de alguien, parada en una estantería, sobre una mesa, etc.
Devolvé ÚNICAMENTE un JSON, sin texto adicional, sin explicación, sin markdown ni backticks, con este formato exacto:

{"reconocida": true/false, "nombre": "...", "categoria": "...", "nivel_estimado_pct": 0, "nivel_descripcion": "..."}

- "reconocida": true si se puede identificar con razonable confianza la marca/tipo de la botella en la foto; false si la imagen no muestra una botella reconocible (está borrosa, no es una botella, no hay nada, etc.).
- "nombre": el nombre del producto tal como lo reconocés (marca + tipo, ej: "Fernet Branca", "Absolut Vodka", "Coca-Cola"). Si "reconocida" es false, dejalo como "" (string vacío).
- "categoria": una categoría general breve (ej: "Fernet", "Vodka", "Gaseosa", "Vino", "Cerveza", "Whisky"). Si no podés determinarla, dejala como "".
- "nivel_estimado_pct": tu mejor estimación VISUAL de qué porcentaje de líquido le queda a la botella, mirando el nivel del líquido en la imagen (número entero de 0 a 100). Es una estimación a ojo, no una medición exacta — igual hacé la mejor estimación posible. Si la botella está cerrada/sin abrir, usá 100. Si NO se puede ver el nivel de líquido en la foto (botella de espaldas, tapada por la mano, lata, o "reconocida" es false), usá null (sin comillas, el valor JSON null).
- "nivel_descripcion": una frase corta en español describiendo el nivel (ej: "llena", "casi llena", "más de la mitad", "por la mitad", "menos de la mitad", "casi vacía", "vacía"). Si "nivel_estimado_pct" es null, dejalo como "".

Ejemplos de respuesta:
{"reconocida":true,"nombre":"Fernet Branca","categoria":"Fernet","nivel_estimado_pct":40,"nivel_descripcion":"menos de la mitad"}
{"reconocida":true,"nombre":"Absolut Vodka","categoria":"Vodka","nivel_estimado_pct":100,"nivel_descripcion":"llena"}
{"reconocida":false,"nombre":"","categoria":"","nivel_estimado_pct":null,"nivel_descripcion":""}`;

/**
 * Reconoce una botella a partir de una foto (nombre/marca + una estimación
 * VISUAL aproximada de cuánto líquido le queda) para el módulo Inventario
 * AYB. Mismo patrón que analizarRemitoCroutons/analizarPlanillaMozos: nunca
 * escribe nada solo en la base — devuelve el dato leído para que la
 * pantalla de ajuste lo muestre como ayuda y el encargado confirme la
 * cantidad a mano.
 *
 * OJO con "nivel_estimado_pct": es una estimación de la IA mirando la foto,
 * no una medición exacta (no hay balanza ni sensor de por medio) — se
 * muestra siempre como referencia, nunca se guarda solo en el stock.
 *
 * @param {string} rutaImagen - ruta al archivo de imagen ya subido
 * @param {string} [mimeTypeReal] - mimetype real reportado por el navegador (multer)
 * @returns {Promise<{reconocida: boolean, nombre: string, categoria: string, nivelPct: number|null, nivelDescripcion: string}>}
 */
async function analizarBotellaAyb(rutaImagen, mimeTypeReal) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta GEMINI_API_KEY en el archivo .env');
  }

  const bytes = fs.readFileSync(rutaImagen);
  const base64 = bytes.toString('base64');
  const mimeType = mimeParaGemini(rutaImagen, mimeTypeReal);

  const body = {
    contents: [{
      parts: [
        { text: PROMPT_BOTELLA_AYB },
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

  const reconocida = !!respuesta?.reconocida && !!String(respuesta?.nombre || '').trim();
  if (!reconocida) {
    return { reconocida: false, nombre: '', categoria: '', nivelPct: null, nivelDescripcion: '' };
  }

  let nivelPct = respuesta?.nivel_estimado_pct;
  nivelPct = (nivelPct === null || nivelPct === undefined || nivelPct === '') ? null : Math.max(0, Math.min(100, Math.round(parseFloat(nivelPct))));
  if (nivelPct !== null && isNaN(nivelPct)) nivelPct = null;

  return {
    reconocida: true,
    nombre: String(respuesta.nombre).trim(),
    categoria: respuesta.categoria ? String(respuesta.categoria).trim() : '',
    nivelPct,
    nivelDescripcion: nivelPct !== null ? String(respuesta.nivel_descripcion || '').trim() : '',
  };
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

// llamarGeminiConReintentos también se exporta: el asistente/chatbot
// (src/routes/asistente.js) la reusa para sus propias llamadas a Gemini,
// en vez de reimplementar el reintento con 503 por su cuenta y arriesgarse
// a que las dos versiones se desincronicen con el tiempo.
// ── Reporte de desayuno (Breakfast Package) para el módulo Desayuno ────
// El reporte que exporta el sistema de reservas (PMS) del hotel: una fila
// por habitación con hasta 15 páginas, nombres y "group name" que a veces
// se cortan en varias líneas dentro de la celda. Igual patrón que
// analizarPlanillaMozos: siempre devuelve una lista para revisar antes de
// aplicarla, nunca escribe directo en la base.
const PROMPT_REPORTE_DESAYUNO = `Sos un asistente que lee el reporte "Breakfast Package" de un hotel (Hilton Buenos Aires), generado por su sistema de reservas (PMS). El documento es una tabla de varias páginas, una fila por habitación, con estas columnas (en este orden, de izquierda a derecha): Room No., Full Name, Membership Level, Adults, Children, Arrival Date, Departure Date, Resv Status, Group Name, Company Name, Special Request, Ttl Pkg. Amt.

OJO: en el documento original, el texto de "Full Name" y de "Group Name" a veces se corta en dos o tres líneas dentro de la misma celda (por ejemplo, un nombre de grupo como "Air France Septiembre 2026" puede aparecer partido en dos renglones). Tenés que unir esas líneas cortadas en un solo valor de texto para esa fila, sin perder ninguna palabra.

Devolvé ÚNICAMENTE un JSON, sin texto adicional, sin explicación, sin markdown ni backticks, con este formato exacto:

{"tipo_documento": "...", "fecha_reporte": "YYYY-MM-DD", "filas": [...]}

PASO 1 — Identificá "tipo_documento":
- "reporte_desayuno": el documento es (o se parece a) este reporte de habitaciones con desayuno.
- "otro": cualquier otra cosa.

PASO 2 — "fecha_reporte": la fecha del reporte que figura arriba a la derecha de la primera página (formato dd-mm-aa, por ejemplo "15-09-26" es 15 de septiembre de 2026), convertida a "YYYY-MM-DD". Si no la encontrás, dejala como "".

PASO 3 — Si "tipo_documento" es "otro", "filas" va vacío: []. Si es "reporte_desayuno", incluí TODAS las filas de TODAS las páginas del documento, sin saltear ninguna ni inventar filas nuevas — cada elemento de "filas" es una habitación, con estos campos:
  - "habitacion": el número de habitación tal como figura en "Room No." (string, obligatorio).
  - "nombre": el nombre completo del huésped, columna "Full Name" (string, uniendo las líneas cortadas si hace falta).
  - "membership_level": el código de la columna "Membership Level" tal como aparece (una letra o vacío) — NO lo traduzcas ni inventes qué significa, copialo tal cual o dejalo "" si está vacío.
  - "adultos": número de la columna "Adults" (entero, 0 si no figura).
  - "ninos": número de la columna "Children" (entero, 0 si no figura).
  - "fecha_llegada": columna "Arrival Date", convertida de dd-mm-aa a "YYYY-MM-DD". "" si no figura.
  - "fecha_salida": columna "Departure Date", convertida igual. "" si no figura.
  - "estado": columna "Resv Status" tal como figura (ej: "CHECKED IN", "DUE OUT").
  - "group_name": columna "Group Name" tal como figura, uniendo líneas cortadas (string, "" si está vacía).
  - "company_name": columna "Company Name" tal como figura ("" si está vacía).
  - "special_request": columna "Special Request" tal como figura, con las comas tal cual las separa el documento (ej: "TR,Z1") ("" si está vacía).
  - "ttl_pkg_amt": columna "Ttl Pkg. Amt.", como número (sin separador de miles). Si dice "0" o está vacía, poné 0.

No te olvides de ninguna fila de ninguna página, incluida la última.`;

/**
 * Analiza el reporte "Breakfast Package" (PDF exportado del sistema de
 * reservas) con Gemini, extrayendo una fila normalizada por habitación.
 * Igual patrón que analizarPlanillaMozos: siempre devuelve una lista para
 * revisar en pantalla antes de aplicarla, nunca escribe directo en la base.
 *
 * maxOutputTokens explícito y alto: este reporte puede traer varios
 * cientos de filas (el de referencia trae 429, en 15 páginas) — con el
 * límite por default de la API, la respuesta se cortaba a mitad de camino
 * y quedaba un JSON incompleto.
 *
 * @param {string} rutaArchivo - ruta al PDF ya subido
 * @param {string} [mimeTypeReal] - mimetype que reportó el navegador al subir
 * @returns {Promise<{tipoDocumento: string, fechaReporte: string, filas: Array}>}
 */
async function analizarReporteDesayuno(rutaArchivo, mimeTypeReal) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta GEMINI_API_KEY en el archivo .env');
  }

  const bytes = fs.readFileSync(rutaArchivo);
  const base64 = bytes.toString('base64');
  const mimeType = mimeParaGemini(rutaArchivo, mimeTypeReal);

  const body = {
    contents: [{
      parts: [
        { text: PROMPT_REPORTE_DESAYUNO },
        { inline_data: { mime_type: mimeType, data: base64 } }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 65536
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
    // finishReason=MAX_TOKENS es la pista de que se cortó por el límite de
    // salida en vez de terminar el JSON — vale la pena distinguirlo en el
    // mensaje de error para no confundirlo con "Gemini no respondió nada".
    const razon = data?.candidates?.[0]?.finishReason;
    if (razon === 'MAX_TOKENS') {
      throw new Error('El reporte es demasiado largo para leerlo de una sola vez con IA — probá dividirlo en partes más chicas, o cargalo en Excel/CSV.');
    }
    throw new Error('Gemini no devolvió contenido legible.');
  }

  let respuesta;
  try {
    respuesta = JSON.parse(textoRespuesta);
  } catch (e) {
    throw new Error('No se pudo interpretar la respuesta de Gemini como JSON (puede que el reporte sea muy largo y se haya cortado a mitad de camino): ' + textoRespuesta.slice(0, 200));
  }

  const tipoDocumento = respuesta?.tipo_documento || 'otro';
  const fechaReporte = String(respuesta?.fecha_reporte || '').trim();
  const filasCrudas = Array.isArray(respuesta?.filas) ? respuesta.filas : [];

  const filas = filasCrudas
    .filter(f => f && f.habitacion && String(f.habitacion).trim())
    .map(f => ({
      habitacion: String(f.habitacion).trim(),
      nombre: f.nombre ? String(f.nombre).trim() : '',
      membershipLevel: f.membership_level ? String(f.membership_level).trim() : '',
      adultos: parseInt(f.adultos) || 0,
      ninos: parseInt(f.ninos) || 0,
      fechaLlegada: f.fecha_llegada ? String(f.fecha_llegada).trim() : '',
      fechaSalida: f.fecha_salida ? String(f.fecha_salida).trim() : '',
      estado: f.estado ? String(f.estado).trim() : '',
      groupName: f.group_name ? String(f.group_name).trim() : '',
      companyName: f.company_name ? String(f.company_name).trim() : '',
      specialRequest: f.special_request ? String(f.special_request).trim() : '',
      ttlPkgAmt: parseFloat(f.ttl_pkg_amt) || 0,
    }));

  return { tipoDocumento, fechaReporte, filas };
}

module.exports = { analizarFactura, analizarRemitoCroutons, analizarPlanillaMozos, analizarBotellaAyb, analizarReporteDesayuno, mensajeErrorGemini, llamarGeminiConReintentos };
