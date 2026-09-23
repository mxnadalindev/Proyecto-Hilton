// actualizar_precios_por_codigo.js
//
// Actualiza el precio de Inventario AYB usando la lista real de "Location
// 220" (Item Code + Description + Average Cost) que pasó Maxi. A
// diferencia del script anterior (que matcheaba por nombre), este matchea
// por CÓDIGO exacto (Item Code = codigo_barras que ya está guardado en
// cada producto desde la carga original de Inventario AYB) — así que no
// hay ambigüedad ni riesgo de matchear mal.
//
// El precio se guarda en el sistema en pesos POR ML (no por botella) — así
// lo usa la pantalla de Costos. Por eso este script convierte el "Average
// Cost" (precio por botella) a precio por ml, usando el tamaño de botella
// que se puede leer del propio nombre del producto (ej. "x750cc", "X 1L").
//
// Los productos de bebidas sin alcohol / cerveza / gaseosas (códigos que
// empiezan con 22, 24 o 27 — latas, porrones, barriles, cajones) NO se
// actualizan automáticamente: su "unidad de venta" no es simple de
// convertir a ml sin adivinar (una lata, un barril de 50L, un pack x24),
// así que sólo se listan para que decidas vos cómo cargarlos.
//
// Seguridad: igual que el script anterior, por defecto SOLO actualiza
// productos que hoy están en $0 — no pisa un precio ya cargado, salvo que
// agregues --forzar-todos.
//
// Uso:
//   1) Modo prueba (no cambia nada):
//        node actualizar_precios_por_codigo.js
//   2) Si el reporte se ve bien:
//        node actualizar_precios_por_codigo.js --ejecutar
//   3) Para además actualizar los que ya tienen un precio distinto:
//        node actualizar_precios_por_codigo.js --ejecutar --forzar-todos

const db = require('./src/db/database');
const ejecutar = process.argv.includes('--ejecutar');
const forzarTodos = process.argv.includes('--forzar-todos');

// Trata de sacar el tamaño de botella (en ml) del propio nombre del
// producto. Reconoce los formatos que aparecen en esta lista: "x750cc",
// "X 1L", "x L" (= por litro = 1000ml), "750 ML", "x 980", etc.
function parsearTamanoMl(nombre) {
  const n = nombre.toUpperCase();
  let m = n.match(/X\s?(\d{3,4})\s?(CC|ML|C)?\b/);
  if (m) return parseInt(m[1], 10);
  m = n.match(/(\d{3,4})\s?(CC|ML)\b/);
  if (m) return parseInt(m[1], 10);
  if (/X\s?1\s?L\b/.test(n) || /X\s?L\b/.test(n) || /X\s?1LT\b/.test(n)) return 1000;
  return null; // no se pudo determinar
}

// Tamaños de botella conocidos por la OTRA planilla que pasó Maxi
// ("Destilados Aperitivos", Sept 2026) — se usa como respaldo cuando el
// nombre de este listado no trae el tamaño (ej. "GIN HEREDERO ORIGINAL"
// no dice el tamaño acá, pero en la otra planilla figura "Heredero" = 500ml).
const TAMANOS_CONOCIDOS = [
  {
    "nombre": "Antica Formula – Italia",
    "bottleMl": 1000
  },
  {
    "nombre": "Aperol - Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Campari – Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Fernet Branca - Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Carpano Dry, Bianco - Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Pimms- Inglaterra",
    "bottleMl": 750
  },
  {
    "nombre": "Brancamenta – Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Gancia",
    "bottleMl": 750
  },
  {
    "nombre": "Cynar - Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Punt E Mes – Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Amargo Obrero - Argentina",
    "bottleMl": 750
  },
  {
    "nombre": "Cinzano",
    "bottleMl": 750
  },
  {
    "nombre": "Jerez Tio Pepe",
    "bottleMl": 750
  },
  {
    "nombre": "Monkey 47 - Alemania",
    "bottleMl": 500
  },
  {
    "nombre": "Mare - Barcelona",
    "bottleMl": 750
  },
  {
    "nombre": "Hendricks - Escocia",
    "bottleMl": 500
  },
  {
    "nombre": "The Botanist - Inglaterra",
    "bottleMl": 750
  },
  {
    "nombre": "Martin Miller´s - Inglaterra",
    "bottleMl": 750
  },
  {
    "nombre": "Apóstoles - Argentina",
    "bottleMl": 750
  },
  {
    "nombre": "Bombay Sapphire - Inglaterra",
    "bottleMl": 750
  },
  {
    "nombre": "Brokers - Inglaterra",
    "bottleMl": 750
  },
  {
    "nombre": "Beefeater - Inglaterra",
    "bottleMl": 750
  },
  {
    "nombre": "Gordons - Inglaterra",
    "bottleMl": 750
  },
  {
    "nombre": "Bulldog - Inglaterra",
    "bottleMl": 750
  },
  {
    "nombre": "Heredero",
    "bottleMl": 500
  },
  {
    "nombre": "Tanqueray",
    "bottleMl": 750
  },
  {
    "nombre": "Zacapa xo - Guatemala",
    "bottleMl": 750
  },
  {
    "nombre": "Zacapa 23 - Guatemala",
    "bottleMl": 750
  },
  {
    "nombre": "Havana club añejo - Cuba",
    "bottleMl": 750
  },
  {
    "nombre": "Malibú - Barbados",
    "bottleMl": 750
  },
  {
    "nombre": "Havana club 7 años - Cuba",
    "bottleMl": 750
  },
  {
    "nombre": "Bacardi blanco",
    "bottleMl": 750
  },
  {
    "nombre": "Bacardi Dorado",
    "bottleMl": 750
  },
  {
    "nombre": "Cachaca",
    "bottleMl": 750
  },
  {
    "nombre": "Santa Teresa",
    "bottleMl": 750
  },
  {
    "nombre": "Grey Goose – Francia",
    "bottleMl": 750
  },
  {
    "nombre": "Belvedere – Polonia",
    "bottleMl": 750
  },
  {
    "nombre": "Ciroc – Francia",
    "bottleMl": 750
  },
  {
    "nombre": "Zubrowka – Polonia",
    "bottleMl": 750
  },
  {
    "nombre": "Absolut 40% - Suecia",
    "bottleMl": 750
  },
  {
    "nombre": "Absolut Saborizados - Suecia",
    "bottleMl": 750
  },
  {
    "nombre": "Smirnoff – Rusia",
    "bottleMl": 750
  },
  {
    "nombre": "Sernova – Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Tequila patrón reposado",
    "bottleMl": 750
  },
  {
    "nombre": "Tequila patrón Silver",
    "bottleMl": 750
  },
  {
    "nombre": "José cuervo reposado",
    "bottleMl": 750
  },
  {
    "nombre": "José cuervo blanco",
    "bottleMl": 750
  },
  {
    "nombre": "Don Julio",
    "bottleMl": 750
  },
  {
    "nombre": "Mezcal",
    "bottleMl": 750
  },
  {
    "nombre": "Johnnie Walker Blue Label",
    "bottleMl": 750
  },
  {
    "nombre": "Royal Salute",
    "bottleMl": 750
  },
  {
    "nombre": "Johnnie Walker Gold Label",
    "bottleMl": 750
  },
  {
    "nombre": "Johnnie Walker 18 años",
    "bottleMl": 750
  },
  {
    "nombre": "Old Parr",
    "bottleMl": 750
  },
  {
    "nombre": "Chivas Regal",
    "bottleMl": 750
  },
  {
    "nombre": "Johnnie Walker Double Black",
    "bottleMl": 750
  },
  {
    "nombre": "Johnnie Walker Red Label",
    "bottleMl": 750
  },
  {
    "nombre": "The Famous Grouse",
    "bottleMl": 750
  },
  {
    "nombre": "J&B",
    "bottleMl": 750
  },
  {
    "nombre": "Johnnie Walker Black Label",
    "bottleMl": 750
  },
  {
    "nombre": "Woodford Reserve",
    "bottleMl": 750
  },
  {
    "nombre": "Buffalo Trace",
    "bottleMl": 750
  },
  {
    "nombre": "Evan Williams",
    "bottleMl": 750
  },
  {
    "nombre": "Maker´s Mark",
    "bottleMl": 750
  },
  {
    "nombre": "Bulleit",
    "bottleMl": 750
  },
  {
    "nombre": "Jameson",
    "bottleMl": 750
  },
  {
    "nombre": "Jack Daniel’s",
    "bottleMl": 750
  },
  {
    "nombre": "Jim Beam",
    "bottleMl": 750
  },
  {
    "nombre": "Wild Turkey",
    "bottleMl": 750
  },
  {
    "nombre": "Benchmark",
    "bottleMl": 750
  },
  {
    "nombre": "The Macallan 12 YO",
    "bottleMl": 700
  },
  {
    "nombre": "Johnnie W. Green L. 15 años",
    "bottleMl": 750
  },
  {
    "nombre": "Glenmorangie 10 años",
    "bottleMl": 750
  },
  {
    "nombre": "Glenlivet 12 años",
    "bottleMl": 700
  },
  {
    "nombre": "Glenfiddich 12 años",
    "bottleMl": 700
  },
  {
    "nombre": "Talisker 10 años",
    "bottleMl": 750
  },
  {
    "nombre": "Cardhu 12 años",
    "bottleMl": 750
  },
  {
    "nombre": "The Macallan 18 YO",
    "bottleMl": 750
  },
  {
    "nombre": "The Macallan 15 YO",
    "bottleMl": 750
  },
  {
    "nombre": "Monkey Shoulder",
    "bottleMl": 750
  },
  {
    "nombre": "St. Germain - Francia",
    "bottleMl": 750
  },
  {
    "nombre": "Strega - Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Grappa Candolini- Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Grand Marnier - Francia",
    "bottleMl": 750
  },
  {
    "nombre": "Drambuie - Escocia",
    "bottleMl": 750
  },
  {
    "nombre": "Chartreuse - Francia",
    "bottleMl": 750
  },
  {
    "nombre": "Legui - Argentina",
    "bottleMl": 750
  },
  {
    "nombre": "Sambuca Borguetti - Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Absenta La Tour Tourne",
    "bottleMl": 750
  },
  {
    "nombre": "Jägermeister - Alemania",
    "bottleMl": 750
  },
  {
    "nombre": "Amaretto Disaronno - Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Baileys - Irlanda",
    "bottleMl": 750
  },
  {
    "nombre": "Borguetti - Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Amarula - Sudáfrica",
    "bottleMl": 750
  },
  {
    "nombre": "Limoncello - Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Hesperidina - Argentina",
    "bottleMl": 750
  },
  {
    "nombre": "Cointreau - Francia",
    "bottleMl": 750
  },
  {
    "nombre": "Pisco",
    "bottleMl": 750
  },
  {
    "nombre": "Tia Maria",
    "bottleMl": 750
  },
  {
    "nombre": "Frangelico- Italia",
    "bottleMl": 750
  },
  {
    "nombre": "Licor 43",
    "bottleMl": 750
  },
  {
    "nombre": "Lepanto – España",
    "bottleMl": 750
  },
  {
    "nombre": "Hennessy VS – Francia",
    "bottleMl": 750
  },
  {
    "nombre": "Hennessy VSOP – Francia",
    "bottleMl": 750
  }
];

function normalizarSimple(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(p => p.length > 1);
}
function buscarTamanoConocido(nombre) {
  const pa = new Set(normalizarSimple(nombre));
  let mejor = null, mejorScore = 0;
  for (const t of TAMANOS_CONOCIDOS) {
    const pb = normalizarSimple(t.nombre);
    if (!pb.length) continue;
    const comunes = pb.filter(p => pa.has(p)).length;
    const score = comunes / pb.length;
    if (score >= 0.5 && score > mejorScore) { mejor = t; mejorScore = score; }
  }
  return mejor ? mejor.bottleMl : null;
}

const LISTA = [
  {
    "codigo": "200065",
    "nombre": "CHAMP.SALENTEIN BRUT ROSE",
    "costo": 5340.11
  },
  {
    "codigo": "200066",
    "nombre": "CHAMP. SALENTEIN EXTRA BRUT",
    "costo": 5736.42
  },
  {
    "codigo": "200089",
    "nombre": "CHAMP CALLIA EXTRA BRUT",
    "costo": 3948.35
  },
  {
    "codigo": "201006",
    "nombre": "VINO PARAMUN PINOT NOIR",
    "costo": 6577.07
  },
  {
    "codigo": "201204",
    "nombre": "VINO SALENTEIN CABERNET S. RES",
    "costo": 4835.53
  },
  {
    "codigo": "201205",
    "nombre": "VINO SALENTEIN MALBEC ROBLE",
    "costo": 4748.17
  },
  {
    "codigo": "201402",
    "nombre": "CHAMP SALENTEIN BRUT NATURE",
    "costo": 6046.13
  },
  {
    "codigo": "201404",
    "nombre": "VINO SALENTEIN RVA SAUV BLANC",
    "costo": 4973.13
  },
  {
    "codigo": "201413",
    "nombre": "VINO NUMINA MALBEC 750ML",
    "costo": 6876.1
  },
  {
    "codigo": "201422",
    "nombre": "VINO NUMINA CHARDONNAY 750ML",
    "costo": 5460.55
  },
  {
    "codigo": "201464",
    "nombre": "VINO SALENTEIN CABERNET FRANC",
    "costo": 5126.36
  },
  {
    "codigo": "201497",
    "nombre": "VINO PYROS SYRAH",
    "costo": 5727.57
  },
  {
    "codigo": "202119",
    "nombre": "VINO SALENTEIN CHARDONAY ROBLE",
    "costo": 4740.59
  },
  {
    "codigo": "202351",
    "nombre": "VINO ZUCCARDI SERIE A TORRONTE",
    "costo": 5946.33
  },
  {
    "codigo": "203003",
    "nombre": "VINO SALENTEIN RESERVA ROSE",
    "costo": 4968.96
  },
  {
    "codigo": "210004",
    "nombre": "RON BACARDI CARTA BLANCA x 980",
    "costo": 12964.07
  },
  {
    "codigo": "210005",
    "nombre": "RON BACARDI CARTA ORO x 980c",
    "costo": 12874.96
  },
  {
    "codigo": "210007",
    "nombre": "RON HAVANA 7 ANOS 12x750",
    "costo": 18217.69
  },
  {
    "codigo": "210012",
    "nombre": "RON SANTA TERESA 10 AÑOS",
    "costo": 11305.38
  },
  {
    "codigo": "210013",
    "nombre": "RON BACARDI AÑEJO",
    "costo": 5590.32
  },
  {
    "codigo": "210015",
    "nombre": "RON ZACAPA XO",
    "costo": 174050.72
  },
  {
    "codigo": "210016",
    "nombre": "MALIBU CARIBEANN RUM",
    "costo": 8662.6
  },
  {
    "codigo": "211006",
    "nombre": "WHISKY CANARDIAN CLUB",
    "costo": 190000.0
  },
  {
    "codigo": "211007",
    "nombre": "WHISKY CHIVAS REGAL X 1L",
    "costo": 35299.83
  },
  {
    "codigo": "211011",
    "nombre": "GIN THE BOTANIST",
    "costo": 50398.5
  },
  {
    "codigo": "211013",
    "nombre": "WHISKY GLEN LIVET",
    "costo": 37182.17
  },
  {
    "codigo": "211018",
    "nombre": "WHISKY J. WALKER BLUE",
    "costo": 242962.55
  },
  {
    "codigo": "211019",
    "nombre": "WHISKY J.WALKER BLACK x L",
    "costo": 38490.58
  },
  {
    "codigo": "211020",
    "nombre": "WHISKY J.WALKER RED x 1000cc",
    "costo": 21639.68
  },
  {
    "codigo": "211021",
    "nombre": "WHISKY JACK DANIELS X L",
    "costo": 38509.72
  },
  {
    "codigo": "211022",
    "nombre": "WHISKY JAMESON x 750",
    "costo": 18542.93
  },
  {
    "codigo": "211023",
    "nombre": "WHISKY JIM BEAM WHITE x750cc",
    "costo": 30569.29
  },
  {
    "codigo": "211025",
    "nombre": "WHISKY JOHNNIE WALKER GOLD",
    "costo": 60353.38
  },
  {
    "codigo": "211027",
    "nombre": "WHISKY MACALLAN 12 AÑOS x750cc",
    "costo": 156044.81
  },
  {
    "codigo": "211028",
    "nombre": "WHISKY OLD PARR DE LUXE x750cc",
    "costo": 28277.07
  },
  {
    "codigo": "211030",
    "nombre": "WHISKY GLENMORANGIE",
    "costo": 58793.67
  },
  {
    "codigo": "211031",
    "nombre": "WHISKY ROYAL SALUTE",
    "costo": 13979.29
  },
  {
    "codigo": "211032",
    "nombre": "WHISKY JACK DANIELS APPLE X 750CC",
    "costo": 25274.91
  },
  {
    "codigo": "211033",
    "nombre": "WHISKY JACK DANIELS HONEY X 750CC",
    "costo": 24599.26
  },
  {
    "codigo": "211034",
    "nombre": "WHISKY WILD TURKEY",
    "costo": 26302.15
  },
  {
    "codigo": "211036",
    "nombre": "WHISKY J. WALKER GREEN LABEL",
    "costo": 94833.81
  },
  {
    "codigo": "211037",
    "nombre": "WHISKY FAMOUS GROUSE",
    "costo": 631.75
  },
  {
    "codigo": "211038",
    "nombre": "WHISKY MAKERS MARK",
    "costo": 59514.91
  },
  {
    "codigo": "211040",
    "nombre": "WHISKY JW DOUBLE BLACK",
    "costo": 44176.01
  },
  {
    "codigo": "211041",
    "nombre": "WHISKY JW 18 PLATINUM",
    "costo": 98662.57
  },
  {
    "codigo": "211042",
    "nombre": "WHISKY CARDHU",
    "costo": 138971.04
  },
  {
    "codigo": "211045",
    "nombre": "WHISKY GLENFIDDICH 10",
    "costo": 93431.71
  },
  {
    "codigo": "211046",
    "nombre": "WHISKY TALISKER",
    "costo": 103478.32
  },
  {
    "codigo": "211047",
    "nombre": "WHISKY MONKEY SHOULDER",
    "costo": 25063.19
  },
  {
    "codigo": "211049",
    "nombre": "WHISKY MACALLAN 18 AÑOS",
    "costo": 566352.78
  },
  {
    "codigo": "211050",
    "nombre": "WHISKY LA ORDEN DEL LIBERTADOR 750 ML",
    "costo": 36283.2
  },
  {
    "codigo": "211051",
    "nombre": "WHISKY LA ALAZANA PENDERYN 700 ML",
    "costo": 274793.39
  },
  {
    "codigo": "212001",
    "nombre": "GIN BEEFEATER",
    "costo": 13730.95
  },
  {
    "codigo": "212002",
    "nombre": "GIN BOMBAY SHAPIRE",
    "costo": 23429.41
  },
  {
    "codigo": "212003",
    "nombre": "GIN GORDONS",
    "costo": 9698.04
  },
  {
    "codigo": "212006",
    "nombre": "GIN TANQUERAY x750cc",
    "costo": 22788.22
  },
  {
    "codigo": "212007",
    "nombre": "GIN APOSTOLES",
    "costo": 10111.44
  },
  {
    "codigo": "212009",
    "nombre": "GRAPA CANDOLI",
    "costo": 4268.13
  },
  {
    "codigo": "212010",
    "nombre": "GIN MARTIN MILLER",
    "costo": 18955.02
  },
  {
    "codigo": "212011",
    "nombre": "GIN HENDRICKS",
    "costo": 44861.64
  },
  {
    "codigo": "212012",
    "nombre": "GIN MONKEY 47",
    "costo": 38309.48
  },
  {
    "codigo": "212013",
    "nombre": "GIN MARE",
    "costo": 58535.6
  },
  {
    "codigo": "212016",
    "nombre": "GIN BULLDOG",
    "costo": 13678.36
  },
  {
    "codigo": "212021",
    "nombre": "GIN HEREDERO ORIGINAL",
    "costo": 8905.7
  },
  {
    "codigo": "213001",
    "nombre": "VODKA ABSOLUT 40° AZUL x750cc",
    "costo": 13695.64
  },
  {
    "codigo": "213005",
    "nombre": "VODKA ABSOLUT VANILLA x750cc",
    "costo": 606.85
  },
  {
    "codigo": "213006",
    "nombre": "VODKA BELVEDERE",
    "costo": 43337.62
  },
  {
    "codigo": "213008",
    "nombre": "VODKA SMIRNOFF x750cc",
    "costo": 5910.82
  },
  {
    "codigo": "213011",
    "nombre": "VODKA ZUBROWKA",
    "costo": 56985.04
  },
  {
    "codigo": "213012",
    "nombre": "VODKA GREY GOOSE",
    "costo": 68734.61
  },
  {
    "codigo": "213013",
    "nombre": "VODKA CIROC",
    "costo": 43610.2
  },
  {
    "codigo": "213015",
    "nombre": "VODKA SERNOVA",
    "costo": 5468.39
  },
  {
    "codigo": "214005",
    "nombre": "CACHACA VELHO BARREIRO x1000cc",
    "costo": 4908.32
  },
  {
    "codigo": "214007",
    "nombre": "CAMPARI x750cc",
    "costo": 6882.44
  },
  {
    "codigo": "214009",
    "nombre": "CINZANO ROSSO x 950cc",
    "costo": 4170.08
  },
  {
    "codigo": "214010",
    "nombre": "CYNAR",
    "costo": 4978.28
  },
  {
    "codigo": "214013",
    "nombre": "FERNET BRANCA x1000cc",
    "costo": 14867.04
  },
  {
    "codigo": "214014",
    "nombre": "GANCIA AMERICANO x980cc",
    "costo": 4707.04
  },
  {
    "codigo": "214017",
    "nombre": "JEREZ TIO PEPE x750cc",
    "costo": 14239.42
  },
  {
    "codigo": "214019",
    "nombre": "LICOR AMARETTO DISARONNO x700c",
    "costo": 27176.73
  },
  {
    "codigo": "214020",
    "nombre": "LICOR AMARULA x 750cc",
    "costo": 22276.51
  },
  {
    "codigo": "214022",
    "nombre": "LICOR BAILEYS",
    "costo": 22822.45
  },
  {
    "codigo": "214026",
    "nombre": "LICOR COINTREAU x700cc",
    "costo": 36906.56
  },
  {
    "codigo": "214033",
    "nombre": "LICOR DRAMBUIE x750cc",
    "costo": 35973.73
  },
  {
    "codigo": "214034",
    "nombre": "LICOR FRANGELICO",
    "costo": 23479.62
  },
  {
    "codigo": "214036",
    "nombre": "LICOR GRAND MARNIER",
    "costo": 20921.23
  },
  {
    "codigo": "214039",
    "nombre": "LICOR LEGUI",
    "costo": 199.89
  },
  {
    "codigo": "214043",
    "nombre": "LICOR JAGUERMEISTER",
    "costo": 17814.55
  },
  {
    "codigo": "214046",
    "nombre": "MEZCAL OAXACA",
    "costo": 78513.4
  },
  {
    "codigo": "214050",
    "nombre": "PISCO",
    "costo": 16173.45
  },
  {
    "codigo": "214051",
    "nombre": "LICOR DE CAFÉ BORGUETTI",
    "costo": 12331.85
  },
  {
    "codigo": "214053",
    "nombre": "SAMBUCCA BORGUETTI",
    "costo": 25130.89
  },
  {
    "codigo": "214057",
    "nombre": "TEQUILA CUERVO BLANCO x750cc",
    "costo": 29522.25
  },
  {
    "codigo": "214058",
    "nombre": "TEQUILA CUERVO ESPECIAL GOLD",
    "costo": 25996.18
  },
  {
    "codigo": "214060",
    "nombre": "FERNET MENTA BRANCA x1000cc",
    "costo": 5439.28
  },
  {
    "codigo": "214061",
    "nombre": "TEQUILA PATRON SILVER 750",
    "costo": 98317.49
  },
  {
    "codigo": "214062",
    "nombre": "TEQUILA PATRON AÑEJO 750",
    "costo": 90498.04
  },
  {
    "codigo": "214063",
    "nombre": "BITTER ANGOSTURA x 500ML",
    "costo": 31862.03
  },
  {
    "codigo": "214065",
    "nombre": "APEROL",
    "costo": 6932.31
  },
  {
    "codigo": "214066",
    "nombre": "HESPERIDINA X 1LT",
    "costo": 8973.74
  },
  {
    "codigo": "214067",
    "nombre": "AMARGO OBRERO X 950 CC",
    "costo": 1445.81
  },
  {
    "codigo": "214070",
    "nombre": "LICOR CHATROUSE",
    "costo": 358.0
  },
  {
    "codigo": "214071",
    "nombre": "LICOR STREGA",
    "costo": 2660.36
  },
  {
    "codigo": "214080",
    "nombre": "GIN BROKER'S X 750CC",
    "costo": 7686.75
  },
  {
    "codigo": "214081",
    "nombre": "PIMM'S APERITIVO",
    "costo": 360.82
  },
  {
    "codigo": "214087",
    "nombre": "TEQUILA DON JULIO SILVER",
    "costo": 119299.25
  },
  {
    "codigo": "214088",
    "nombre": "LEMONCELLO ILTICO V 9",
    "costo": 9610.57
  },
  {
    "codigo": "215014",
    "nombre": "ABSENTA",
    "costo": 339.9
  },
  {
    "codigo": "215016",
    "nombre": "COGNAC HENNESSY VSOP",
    "costo": 60996.84
  },
  {
    "codigo": "215017",
    "nombre": "COGNAC HENNESSY VS",
    "costo": 43614.6
  },
  {
    "codigo": "215018",
    "nombre": "COGNAC LEPANTO",
    "costo": 3175.18
  },
  {
    "codigo": "215025",
    "nombre": "WHISKY BULLEIT",
    "costo": 33337.65
  },
  {
    "codigo": "215028",
    "nombre": "WHISKY EVAN W.",
    "costo": 34461.2
  },
  {
    "codigo": "216006",
    "nombre": "MARTINI BIANCO",
    "costo": 4403.78
  },
  {
    "codigo": "216007",
    "nombre": "MARTINI DRY",
    "costo": 5459.13
  },
  {
    "codigo": "216017",
    "nombre": "ANTICA FORMULA",
    "costo": 43003.0
  },
  {
    "codigo": "220003",
    "nombre": "CERVEZA CORONA 330 PORRON",
    "costo": 2324.79
  },
  {
    "codigo": "220006",
    "nombre": "CERVEZA HEINEKEN LATA X 24UN",
    "costo": 1944.44
  },
  {
    "codigo": "220011",
    "nombre": "CERVEZA QUILMES BARRIL 50LT",
    "costo": 131968.07
  },
  {
    "codigo": "220013",
    "nombre": "CERVEZA QUILMES LATA X 24UN.",
    "costo": 1431.56
  },
  {
    "codigo": "220014",
    "nombre": "CERVEZA MICHELOB LATA 473 CC",
    "costo": 0.01
  },
  {
    "codigo": "220017",
    "nombre": "TUBO DE GAS QUILMES X 10KG",
    "costo": 4485.71
  },
  {
    "codigo": "220019",
    "nombre": "CERVEZA STELLA ART. BARR X 20L",
    "costo": 88338.62
  },
  {
    "codigo": "220039",
    "nombre": "CERVEZA STELLA ARTOIS LATA 473CC",
    "costo": 2088.93
  },
  {
    "codigo": "220041",
    "nombre": "CERVEZA STELLA LATA SIN ALCOHOL 473 CC",
    "costo": 1714.31
  },
  {
    "codigo": "220042",
    "nombre": "CERVEZA ANDES ORIGEN IPA LATA 437 ML",
    "costo": 1904.54
  },
  {
    "codigo": "220043",
    "nombre": "CERVEZA ANDES ORIGEN NEGRA LATA 437 ML",
    "costo": 1910.85
  },
  {
    "codigo": "220044",
    "nombre": "CERVEZA ANDES ORIGEN ROJA LATA 437 ML",
    "costo": 1897.88
  },
  {
    "codigo": "240091",
    "nombre": "AGUA AQUARIUS  POMELO 500cc.",
    "costo": 1065.89
  },
  {
    "codigo": "240092",
    "nombre": "AGUA AQUARIUS MANZANA 500cc.",
    "costo": 1063.41
  },
  {
    "codigo": "240093",
    "nombre": "SPEED LATA 250",
    "costo": 823.1
  },
  {
    "codigo": "240183",
    "nombre": "AGUA SMARTWATER 591CC S/GAS",
    "costo": 641.54
  },
  {
    "codigo": "240184",
    "nombre": "AGUA SMARTWATER 591CC C/GAS",
    "costo": 633.21
  },
  {
    "codigo": "270002",
    "nombre": "COCA COLA (LATA) X 6",
    "costo": 1077.28
  },
  {
    "codigo": "270010",
    "nombre": "FANTA NARANJA ZERO LATA X 6",
    "costo": 1012.93
  },
  {
    "codigo": "270020",
    "nombre": "SCHWEPPS TONICA LATA X 24UN",
    "costo": 1099.45
  },
  {
    "codigo": "270023",
    "nombre": "SPRITE (LATA) x 6",
    "costo": 1032.75
  },
  {
    "codigo": "270024",
    "nombre": "SPRITE ZERO (LATA) x 6",
    "costo": 1054.14
  },
  {
    "codigo": "270061",
    "nombre": "COCA COLA ZERO LATA x 6",
    "costo": 1084.11
  }
];

(async () => {
  const productos = await db.all2("SELECT id, nombre, precio_unitario, codigo_barras FROM productos_ayb");
  const porCodigo = new Map(productos.filter(p => p.codigo_barras).map(p => [String(p.codigo_barras).trim(), p]));

  console.log('====================================================');
  console.log('ACTUALIZAR PRECIOS por código (Location 220)');
  console.log('====================================================');
  console.log(`Productos en la lista: ${LISTA.length}`);
  console.log('');

  const aActualizar = [];
  const yaTienenOtroPrecio = [];
  const sinMatch = [];
  const bebidasSinConvertir = [];
  const sinTamano = [];

  for (const item of LISTA) {
    const esBebida = /^(22|24|27)/.test(item.codigo);
    const match = porCodigo.get(item.codigo);

    if (!match) { sinMatch.push(item); continue; }

    if (esBebida) { bebidasSinConvertir.push({ item, match }); continue; }

    let tamanoMl = parsearTamanoMl(item.nombre);
    let origenTamano = 'nombre';
    if (!tamanoMl) {
      tamanoMl = buscarTamanoConocido(item.nombre);
      origenTamano = 'otra planilla';
    }
    if (!tamanoMl) {
      tamanoMl = 750; // default: botella estándar
      origenTamano = 'default 750ml';
    }
    if (origenTamano !== 'nombre') sinTamano.push(`${item.nombre} (tamaño usado: ${tamanoMl}ml, origen: ${origenTamano})`);

    const precioPorMl = item.costo / tamanoMl;
    const precioActual = parseFloat(match.precio_unitario) || 0;

    if (precioActual > 0 && !forzarTodos) {
      yaTienenOtroPrecio.push({ item, match, precioPorMl, precioActual, tamanoMl });
    } else {
      aActualizar.push({ item, match, precioPorMl, precioActual, tamanoMl });
    }
  }

  console.log(`--- Se van a actualizar (${aActualizar.length}) ---`);
  aActualizar.forEach(a => console.log(`  [${a.item.codigo}] "${a.item.nombre}" → "${a.match.nombre}" | tamaño usado: ${a.tamanoMl}ml | precio actual: ${a.precioActual} → nuevo: ${a.precioPorMl.toFixed(3)} (por ml)`));
  console.log('');

  console.log(`--- Ya tienen OTRO precio, no se tocan salvo --forzar-todos (${yaTienenOtroPrecio.length}) ---`);
  yaTienenOtroPrecio.forEach(a => console.log(`  [${a.item.codigo}] "${a.item.nombre}" → "${a.match.nombre}" | precio actual: ${a.precioActual} (lista sugiere: ${a.precioPorMl.toFixed(3)})`));
  console.log('');

  console.log(`--- Bebidas sin alcohol/cerveza/gaseosas — NO se tocan, revisar a mano (${bebidasSinConvertir.length}) ---`);
  bebidasSinConvertir.forEach(a => console.log(`  [${a.item.codigo}] "${a.item.nombre}" → "${a.match.nombre}" | precio actual: ${a.match.precio_unitario} | costo real en la lista: $${a.item.costo} (por la unidad que sea que se cuenta, no convertido)`));
  console.log('');

  console.log(`--- SIN match por código en tu catálogo (${sinMatch.length}) ---`);
  sinMatch.forEach(a => console.log(`  [${a.codigo}] "${a.nombre}"`));
  console.log('');

  if (sinTamano.length) {
    console.log(`⚠ A estos no se les pudo leer el tamaño de botella del nombre, se asumió 750ml (revisar si corresponde):`);
    sinTamano.forEach(n => console.log(`  - ${n}`));
    console.log('');
  }

  if (!ejecutar) {
    console.log('MODO PRUEBA — no se cambió nada todavía.');
    console.log('Si el reporte se ve bien, correr de nuevo así:');
    console.log('  node actualizar_precios_por_codigo.js --ejecutar');
    process.exit(0);
  }

  if (aActualizar.length === 0) {
    console.log('No hay nada para actualizar.');
    process.exit(0);
  }

  for (const a of aActualizar) {
    await db.run2('UPDATE productos_ayb SET precio_unitario=$1 WHERE id=$2', [a.precioPorMl, a.match.id]);
  }
  console.log(`✔ Actualizados ${aActualizar.length} productos.`);

  const idsActualizados = aActualizar.map(a => a.match.id);
  const platosAfectados = await db.all2(
    `SELECT DISTINCT plato_id FROM plato_insumos_ayb WHERE insumo_id = ANY($1)`,
    [idsActualizados]
  );
  for (const { plato_id } of platosAfectados) {
    await db.run2(
      `UPDATE plato_insumos_ayb SET costo_parcial = cantidad * (SELECT precio_unitario FROM productos_ayb WHERE id = plato_insumos_ayb.insumo_id) WHERE plato_id=$1`,
      [plato_id]
    );
    const suma = await db.get2('SELECT COALESCE(SUM(costo_parcial),0) AS total FROM plato_insumos_ayb WHERE plato_id=$1', [plato_id]);
    await db.run2('UPDATE platos_costo SET costo_total=$1 WHERE id=$2', [suma.total, plato_id]);
  }
  console.log(`✔ Recalculado el costo_total de ${platosAfectados.length} trago(s)/plato(s).`);
  console.log('Listo.');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
