// public/js/ui-comun.js — funciones de interfaz compartidas por varias
// pantallas del portal (ventanas emergentes y el desplegable "Otras
// opciones" del encabezado). Antes cada vista tenía su propia copia de
// estas mismas funciones, copiada y pegada — showModal/hideModal estaban
// repetidas en costos.ejs, croutons.ejs, horarios_ayb.ejs, horas_extra.ejs,
// inventario_ayb.ejs y personal.ejs, y toggleOtrasOpciones en horarios.ejs,
// horas_extra.ejs, inventario_ayb.ejs y personal.ejs. Si había que corregir
// un detalle de cómo se abren/cierran (como pasó esta misma sesión, con el
// hover verde de Editar/Eliminar en Inventario AYB), había que acordarse de
// tocarlo en cada vista por separado. Ahora es un solo archivo, compartido.
//
// showModal admite un segundo parámetro opcional, "selectorFoco", para el
// único caso (el modal de "Agregar horas extra") que necesitaba enfocar un
// <select> en vez de un <input> al abrirse — se mantiene ese comportamiento
// puntual sin forzarlo en el resto de los modales del sitio.

function showModal(id, selectorFoco) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'flex';
  setTimeout(() => {
    // Buscado DENTRO del modal (el.querySelector, no document.querySelector)
    // para que un selector con coma (como el de horas extra, más abajo)
    // quede bien delimitado a este modal — cada parte de la lista separada
    // por comas se evalúa igual contra los descendientes de "el".
    const campo = el.querySelector(selectorFoco || 'input:not([type=hidden])');
    if (campo) campo.focus();
  }, 100);
}

function hideModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function toggleOtrasOpciones(ev) {
  if (ev) ev.stopPropagation();
  const dd = document.getElementById('dropdown-otras-opciones');
  if (dd) dd.classList.toggle('abierto');
}
