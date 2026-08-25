// src/routes/middleware.js
function loginRequerido(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}

const RUTAS_POR_DEPARTAMENTO = {
  cocina:   ['/eventos', '/personal', '/recetas', '/horarios', '/costos'],
  compras:  ['/compras'],
  ayb:      ['/personal', '/horarios', '/croutons'],
  finanzas: ['/finanzas'],
};

function requiereDepartamento(prefijo) {
  return function (req, res, next) {
    const usuario = req.session.usuario;
    if (!usuario) return res.redirect('/login');
    // .toLowerCase(): rol/departamento pueden estar guardados con distinta
    // capitalización según cómo se creó la cuenta (el login no fuerza
    // minúsculas) — sin esto, una cuenta con rol "Admin" o departamento
    // "Ayb"/"Cocina" (en vez de "admin"/"ayb"/"cocina") no matcheaba nunca
    // y quedaba bloqueada de todas las secciones, admin general incluido.
    const rol = (usuario.rol || '').toLowerCase();
    const departamento = (usuario.departamento || '').toLowerCase();
    // Un admin general sin departamento asignado (o "sistema") tiene acceso a todo.
    // Un admin de un departamento específico (ej. ayb) sigue restringido a lo suyo.
    if (rol === 'admin' && (!departamento || departamento === 'sistema')) {
      return next();
    }
    const permitidas = RUTAS_POR_DEPARTAMENTO[departamento] || [];
    if (permitidas.includes(prefijo)) return next();
    return res.redirect('/inicio?msg=sin_acceso');
  };
}

module.exports = { loginRequerido, requiereDepartamento, RUTAS_POR_DEPARTAMENTO };
