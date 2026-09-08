// ── Traducción del portal (Español / English / Português) ──
// Enfoque: el idioma vive en localStorage (por navegador, igual que las
// "cuentas guardadas" del login), y las traducciones se aplican del lado
// del cliente después de que la página ya cargó en español (el idioma real
// de los datos en la base). Si algo no tiene traducción cargada, se queda
// en español — nunca se rompe ni queda en blanco.
//
// Las claves de traducción son el propio texto en español (ej.
// dict['Eventos'] === 'Events'), así no hace falta inventar un nombre de
// clave por cada frase: basta con agregar data-i18n a un elemento para que
// se traduzca solo, usando su propio texto como clave.
(function () {
  const LS_KEY = 'hilton_idioma';
  const SUPPORTED = ['es', 'en', 'pt'];
  let dict = {};

  function idiomaActual() {
    try {
      const g = localStorage.getItem(LS_KEY);
      if (g && SUPPORTED.includes(g)) return g;
    } catch (e) { /* localStorage bloqueado: seguimos en español */ }
    return 'es';
  }

  function aplicarTraducciones() {
    const idioma = idiomaActual();
    document.documentElement.setAttribute('lang', idioma);

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      // Guardamos el texto original en español la primera vez que vemos
      // el elemento, para poder "volver" a español sin perder el texto.
      if (el.dataset.i18nOriginal === undefined) el.dataset.i18nOriginal = el.textContent;
      const original = el.dataset.i18nOriginal;
      const clave = el.getAttribute('data-i18n') || original.trim();
      el.textContent = dict[clave] || original;
    });

    document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      const clave = el.getAttribute('data-i18n-ph');
      if (el.dataset.i18nPhOriginal === undefined) el.dataset.i18nPhOriginal = el.getAttribute('placeholder') || '';
      el.setAttribute('placeholder', dict[clave] || el.dataset.i18nPhOriginal);
    });

    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const clave = el.getAttribute('data-i18n-title');
      if (el.dataset.i18nTitleOriginal === undefined) el.dataset.i18nTitleOriginal = el.getAttribute('title') || '';
      el.setAttribute('title', dict[clave] || el.dataset.i18nTitleOriginal);
    });

    document.querySelectorAll('.selector-idioma').forEach((sel) => { sel.value = idioma; });

    document.dispatchEvent(new CustomEvent('hilton:idioma-aplicado', { detail: { idioma } }));
  }

  async function cargarDiccionario(idioma) {
    if (idioma === 'es') {
      dict = {};
      aplicarTraducciones();
      return;
    }
    try {
      const resp = await fetch('/i18n/' + idioma + '.json', { cache: 'force-cache' });
      dict = resp.ok ? await resp.json() : {};
    } catch (e) {
      dict = {}; // sin conexión al archivo de traducciones: se queda en español, no rompe nada
    }
    aplicarTraducciones();
  }

  // Cambia el idioma de todo el sitio (se usa desde el selector del header
  // y el del login) y lo recuerda en este navegador.
  window.cambiarIdiomaHilton = function (idioma) {
    if (!SUPPORTED.includes(idioma)) return;
    try { localStorage.setItem(LS_KEY, idioma); } catch (e) { /* no persiste, pero traduce igual esta visita */ }
    cargarDiccionario(idioma);
  };

  // Para traducir texto generado por JS (ej. el carrusel de Inicio que
  // reescribe nombre/detalle del módulo al navegar entre tarjetas).
  window.tHilton = function (textoEspanol) {
    return dict[textoEspanol] || textoEspanol;
  };

  document.addEventListener('DOMContentLoaded', function () {
    cargarDiccionario(idiomaActual());
  });
})();
