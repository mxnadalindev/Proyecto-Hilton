// ── Agregar esta ruta en src/routes/personal.js ──
// Va después de router.post('/registro'...) y antes de module.exports

router.post('/asignar-turno', loginRequerido, async (req, res) => {
  try {
    const { usuario_id, fecha, hora_entrada, seccion } = req.body;

    // Deducir turno según hora de entrada
    const hora = parseInt((hora_entrada || '08:00').split(':')[0]);
    let turno, hora_inicio, hora_fin;
    if (hora >= 6 && hora < 14) {
      turno = 'manana'; hora_inicio = '06:00'; hora_fin = '14:00';
    } else if (hora >= 14 && hora < 22) {
      turno = 'tarde';  hora_inicio = '14:00'; hora_fin = '22:00';
    } else {
      turno = 'noche';  hora_inicio = '22:00'; hora_fin = '06:00';
    }

    // Evitar duplicado: si ya existe ese empleado en esa fecha/turno, actualizar
    const existe = await db.get2(
      'SELECT id FROM horarios WHERE fecha=$1 AND usuario_id=$2 AND turno=$3',
      [fecha, parseInt(usuario_id), turno]
    );

    if (existe) {
      await db.run2(
        'UPDATE horarios SET hora_inicio=$1, hora_fin=$2, seccion=$3 WHERE id=$4',
        [hora_entrada, hora_fin, seccion || null, existe.id]
      );
    } else {
      await db.run2(
        'INSERT INTO horarios (fecha, turno, hora_inicio, hora_fin, usuario_id, seccion, estado) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [fecha, turno, hora_entrada, hora_fin, parseInt(usuario_id), seccion || null, 'asignado']
      );
    }

    res.redirect('/personal?msg=turno_asignado');
  } catch(e) {
    console.error('Error asignando turno:', e.message);
    res.redirect('/personal?msg=' + encodeURIComponent('Error al asignar turno.'));
  }
});
