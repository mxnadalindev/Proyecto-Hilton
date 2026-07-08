/**
 * Efecto de bienvenida: partículas que convergen para formar un texto.
 * Uso: mostrarParticulasBienvenida('BIENVENIDOS AL PORTAL HILTON')
 */
function mostrarParticulasBienvenida(texto, opts = {}) {
  const duracionMs = opts.duracion || 2600;
  const color = opts.color || '96,165,250'; // azul Hilton en rgb

  const overlay = document.createElement('div');
  overlay.id = 'particulas-overlay';
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:99999; background:#0f172a;
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

  const particulas = puntos.map(p => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    tx: p.x,
    ty: p.y,
    tam: Math.random() * 1.4 + 0.9,
  }));

  let frame = 0;
  const framesConvergencia = Math.floor((duracionMs / 1000) * 60 * 0.5);

  function animar() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = `rgba(${color},0.95)`;
    particulas.forEach(p => {
      p.x += (p.tx - p.x) * 0.09;
      p.y += (p.ty - p.y) * 0.09;
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
