// src/routes/middleware.js
function loginRequerido(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}
module.exports = { loginRequerido };
