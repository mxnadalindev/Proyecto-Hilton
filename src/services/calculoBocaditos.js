// src/services/calculoBocaditos.js — Lógica de cálculo para eventos de
// Cocina, a partir del catálogo de bocaditos (ver bocaditos_catalogo y
// scripts/cargar_bocaditos_cocina.js). Confirmada con Maxi en la
// conversación donde armamos esto — cada regla está anotada con el
// ejemplo real del documento que la justifica.
//
// Reglas:
//  - Fríos y Calientes: 0,82 bocados por persona de CADA plato elegido,
//    fijo, sin importar cuántos platos se elijan en esa categoría.
//    (Sale de 41 bocados / 50 comensales = 0,82 — el documento muestra
//    41 tanto para 3 platos elegidos como para 5, así que es un valor
//    por plato, no un total a repartir entre la cantidad elegida.)
//  - Platos principales: si se elige 1 solo, 1,5 bocados por persona
//    (margen extra a propósito, al no haber otra opción). Si se eligen
//    2 o más, 1 bocado por persona de cada uno (fijo).
//  - Postres: (2 bocados por persona × comensales) ÷ cantidad de
//    postres elegidos — reparte el total entre los elegidos.
const BOCADOS_POR_PERSONA_FRIOS_CALIENTES = 0.82;
const BOCADOS_POR_PERSONA_PRINCIPAL_UNICO = 1.5;
const BOCADOS_POR_PERSONA_PRINCIPAL_MULTIPLE = 1;
const BOCADOS_POR_PERSONA_POSTRES_TOTAL = 2;

/**
 * @param {Array} seleccion - [{ id, categoria, nombre, vajilla_texto, vajilla_capacidad, costo_unitario }]
 *   categoria: 'frios' | 'calientes' | 'principales' | 'postres'
 *   costo_unitario: costo de UN bocado de ese plato (opcional, default 0)
 * @param {number} comensales
 * @returns {Array} mismos items, con bocados_totales, vajilla_cantidad y costo_total calculados
 */
function calcularBocaditos(seleccion, comensales) {
  const pax = Math.max(0, parseInt(comensales, 10) || 0);
  const cantidadPorCategoria = { frios: 0, calientes: 0, principales: 0, postres: 0 };
  for (const item of seleccion) {
    if (cantidadPorCategoria[item.categoria] !== undefined) cantidadPorCategoria[item.categoria]++;
  }

  return seleccion.map(item => {
    let bocadosPorPersona = 0;
    if (item.categoria === 'frios' || item.categoria === 'calientes') {
      bocadosPorPersona = BOCADOS_POR_PERSONA_FRIOS_CALIENTES;
    } else if (item.categoria === 'principales') {
      bocadosPorPersona = cantidadPorCategoria.principales <= 1
        ? BOCADOS_POR_PERSONA_PRINCIPAL_UNICO
        : BOCADOS_POR_PERSONA_PRINCIPAL_MULTIPLE;
    } else if (item.categoria === 'postres') {
      const nPostres = cantidadPorCategoria.postres || 1;
      bocadosPorPersona = (BOCADOS_POR_PERSONA_POSTRES_TOTAL) / nPostres;
    }

    const bocadosTotales = Math.round(bocadosPorPersona * pax);
    const capacidad = parseInt(item.vajilla_capacidad, 10) || 1;
    const vajillaCantidad = bocadosTotales > 0 ? Math.ceil(bocadosTotales / capacidad) : 0;
    const costoUnitario = parseFloat(item.costo_unitario) || 0;
    const costoTotal = Math.round(bocadosTotales * costoUnitario * 100) / 100;

    return { ...item, bocados_totales: bocadosTotales, vajilla_cantidad: vajillaCantidad, costo_unitario: costoUnitario, costo_total: costoTotal };
  });
}

/**
 * Personal requerido: 2 cocineros de servicio + 4 de producción cada 50
 * comensales, redondeando siempre hacia arriba por bloque de 50 (nunca
 * queda corto de personal, aunque el evento tenga pocos invitados de más
 * sobre el bloque anterior).
 */
function calcularPersonalRequerido(comensales) {
  const pax = Math.max(0, parseInt(comensales, 10) || 0);
  const bloques = pax > 0 ? Math.ceil(pax / 50) : 0;
  return { servicio: bloques * 2, produccion: bloques * 4 };
}

module.exports = { calcularBocaditos, calcularPersonalRequerido };
