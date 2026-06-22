// src/routes/middleware.js
function loginRequerido(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}

const RUTAS_POR_DEPARTAMENTO = {
  cocina:   ['/eventos', '/personal', '/recetas', '/horarios', '/costos'],
  compras:  ['/compras'],
  ayb:      ['/eventos', '/personal', '/recetas', '/horarios', '/costos'],
  finanzas: ['/finanzas'],
};

function requiereDepartamento(prefijo) {
  return function (req, res, next) {
    const usuario = req.session.usuario;
    if (!usuario) return res.redirect('/login');
    const permitidas = RUTAS_POR_DEPARTAMENTO[usuario.departamento] || [];
    if (permitidas.includes(prefijo)) return next();
    return res.redirect('/inicio?msg=sin_acceso');
  };
}

module.exports = { loginRequerido, requiereDepartamento, RUTAS_POR_DEPARTAMENTO };
