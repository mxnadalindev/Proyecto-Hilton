/**
 * Efecto de bienvenida: partículas que convergen para formar un texto.
 * Uso: mostrarParticulasBienvenida('BIENVENIDOS AL PORTAL HILTON')
 */
function mostrarParticulasBienvenida(texto, opts = {}) {
  const duracionMs = opts.duracion || 2600;
  // Degradé verde de la paleta: teal -> verde -> lima
  const colorInicio = opts.colorInicio || [0, 114, 147];   // #007293
  const colorMedio   = opts.colorMedio  || [6, 147, 126];  // #06937e
  const colorFin     = opts.colorFin    || [107, 176, 48]; // #6bb030

  const overlay = document.createElement('div');
  overlay.id = 'particulas-overlay';
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:99999; background:#ffffff;
    display:flex; align-items:center; justify-content:center;
    opacity:1; transition:opacity 0.6s ease;
  `;
  const canvas = document.createElement('canvas');
  overlay.appendChild(canvas);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  // Canvas auxiliar, solo para "leer" dónde cae cada letra del texto
  const off = document.createElement('canvas');
  off.width = canvas.width;
  off.height = canvas.height;
  const octx = off.getContext('2d');

  let fontSize = Math.min(canvas.width / 9, 64);
  octx.font = `700 ${fontSize}px Inter, Arial, sans-serif`;
  while (octx.measureText(texto).width > canvas.width * 0.86 && fontSize > 10) {
    fontSize -= 2;
    octx.font = `700 ${fontSize}px Inter, Arial, sans-serif`;
  }
  octx.fillStyle = '#fff';
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  octx.fillText(texto, off.width / 2, off.height / 2);

  const imgData = octx.getImageData(0, 0, off.width, off.height).data;
  const paso = window.innerWidth < 640 ? 3 : 4;
  const puntos = [];
  for (let y = 0; y < off.height; y += paso) {
    for (let x = 0; x < off.width; x += paso) {
      if (imgData[(y * off.width + x) * 4 + 3] > 128) puntos.push({ x, y });
    }
  }

  const minX = Math.min(...puntos.map(p => p.x));
  const maxX = Math.max(...puntos.map(p => p.x));
  const rangoX = Math.max(maxX - minX, 1);

  function mezclarColor(c1, c2, t) {
    return [
      Math.round(c1[0] + (c2[0] - c1[0]) * t),
      Math.round(c1[1] + (c2[1] - c1[1]) * t),
      Math.round(c1[2] + (c2[2] - c1[2]) * t),
    ];
  }
  function colorEnX(x) {
    const t = (x - minX) / rangoX; // 0 a 1, de izquierda a derecha
    if (t < 0.5) return mezclarColor(colorInicio, colorMedio, t * 2);
    return mezclarColor(colorMedio, colorFin, (t - 0.5) * 2);
  }

  const particulas = puntos.map(p => {
    const [r, g, b] = colorEnX(p.x);
    return {
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      tx: p.x,
      ty: p.y,
      tam: Math.random() * 1.4 + 0.9,
      color: `rgba(${r},${g},${b},0.95)`,
    };
  });

  let frame = 0;
  const framesConvergencia = Math.floor((duracionMs / 1000) * 60 * 0.5);

  function animar() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particulas.forEach(p => {
      p.x += (p.tx - p.x) * 0.09;
      p.y += (p.ty - p.y) * 0.09;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.tam, 0, Math.PI * 2);
      ctx.fill();
    });
    frame++;
    if (frame < framesConvergencia + 50) {
      requestAnimationFrame(animar);
    } else {
      setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => {
          overlay.remove();
          document.body.style.overflow = '';
        }, 650);
      }, 450);
    }
  }
  requestAnimationFrame(animar);
}
