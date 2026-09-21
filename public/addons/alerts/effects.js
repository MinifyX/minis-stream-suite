// Feier-Effekte (Konfetti, Feuerwerk, Herzen, Sterne) auf einem Canvas.
window.AlertEffects = (() => {
  const COLORS = ['#9146FF', '#FFE14D', '#FF3B6B', '#35D0FF', '#4DFF88', '#FFFFFF', '#FF8A3D'];
  const AMOUNT = { light: 1, medium: 2, heavy: 4 };
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  function heartPath(ctx, size) {
    const s = size / 2;
    ctx.beginPath();
    ctx.moveTo(0, s * 0.6);
    ctx.bezierCurveTo(-s * 1.4, -s * 0.3, -s * 0.6, -s * 1.3, 0, -s * 0.5);
    ctx.bezierCurveTo(s * 0.6, -s * 1.3, s * 1.4, -s * 0.3, 0, s * 0.6);
  }

  function starPath(ctx, size) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? size * 0.22 : size * 0.55;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
  }

  /**
   * Startet einen Effekt in `host`. Gibt eine Stop-Funktion zurück:
   * stop() lässt ihn ausklingen, stop(true) entfernt ihn sofort.
   */
  function start(host, config, targetBox) {
    const canvas = document.createElement('canvas');
    canvas.className = 'ma-fx';
    let x0 = 0, y0 = 0, W = host.clientWidth || window.innerWidth, H = host.clientHeight || window.innerHeight;
    if (config.area === 'alert' && targetBox) {
      // Bereich um den Alert herum (offset* ignoriert CSS-Skalierung der Vorschau)
      const padX = targetBox.offsetWidth * 0.35 + 60;
      const padY = targetBox.offsetHeight * 0.35 + 60;
      x0 = Math.max(0, targetBox.offsetLeft - padX);
      y0 = Math.max(0, targetBox.offsetTop - padY);
      W = Math.min(W - x0, targetBox.offsetWidth + padX * 2);
      H = Math.min(H - y0, targetBox.offsetHeight + padY * 2);
    }
    Object.assign(canvas.style, { left: `${x0}px`, top: `${y0}px`, width: `${W}px`, height: `${H}px` });
    canvas.width = W;
    canvas.height = H;
    host.append(canvas);

    const ctx = canvas.getContext('2d');
    const amount = AMOUNT[config.intensity] || 2;
    const particles = [];
    let spawning = true;
    let lastSpawn = 0;
    let frame = 0;
    let raf = 0;
    let removed = false;

    const spawners = {
      confetti(initial) {
        const n = initial ? 70 * amount : amount;
        for (let i = 0; i < n; i++) {
          particles.push({
            kind: 'confetti', x: rand(0, W), y: initial ? rand(-H * 0.6, -10) : -10,
            vx: rand(-1.5, 1.5), vy: rand(2, 5), rot: rand(0, Math.PI), vr: rand(-0.2, 0.2),
            w: rand(6, 12), h: rand(8, 16), color: pick(COLORS), life: 1, gravity: 0.03, drag: 0.995,
          });
        }
      },
      fireworks(initial, now) {
        if (!initial && now - lastSpawn < 700 / amount) return;
        lastSpawn = now;
        particles.push({ kind: 'rocket', x: rand(W * 0.15, W * 0.85), y: H, vx: rand(-1, 1), vy: -rand(H / 70, H / 55), targetY: rand(H * 0.15, H * 0.45), color: pick(COLORS), life: 1 });
      },
      hearts(initial) {
        const n = initial ? 8 * amount : Math.random() < 0.25 * amount ? 1 : 0;
        for (let i = 0; i < n; i++) {
          particles.push({ kind: 'heart', x: rand(0, W), y: H + rand(0, initial ? H * 0.3 : 20), vx: 0, vy: -rand(1.5, 3.5), phase: rand(0, 6), size: rand(18, 40), color: pick(['#FF3B6B', '#FF6B9A', '#9146FF', '#FFFFFF']), life: 1 });
        }
      },
      stars(initial) {
        const n = initial ? 10 * amount : Math.random() < 0.3 * amount ? 1 : 0;
        for (let i = 0; i < n; i++) {
          particles.push({ kind: 'star', x: rand(0, W), y: rand(0, H), size: rand(14, 36), age: 0, maxAge: rand(50, 110), color: pick(['#FFE14D', '#FFFFFF', '#9146FF', '#35D0FF']), rot: rand(0, Math.PI), life: 1 });
        }
      },
    };
    const spawn = spawners[config.effect] || spawners.confetti;

    function explode(p) {
      const n = 50 + 20 * amount;
      const color2 = pick(COLORS);
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n;
        const speed = rand(1.5, 5);
        particles.push({ kind: 'spark', x: p.x, y: p.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, color: i % 3 ? p.color : color2, life: 1, decay: rand(0.012, 0.02) });
      }
    }

    function step(now) {
      frame++;
      ctx.clearRect(0, 0, W, H);
      if (spawning) spawn(false, now);

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        switch (p.kind) {
          case 'confetti':
            p.vy += p.gravity; p.vx *= p.drag; p.x += p.vx + Math.sin((frame + p.w) / 20) * 0.6; p.y += p.vy; p.rot += p.vr;
            if (p.y > H + 20) p.life = 0;
            ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, Math.cos(frame / 8 + p.w));
            ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
            break;
          case 'rocket':
            p.x += p.vx; p.y += p.vy; p.vy *= 0.985;
            ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
            if (p.y <= p.targetY || p.vy > -1) { p.life = 0; explode(p); }
            break;
          case 'spark':
            p.vy += 0.05; p.vx *= 0.98; p.vy *= 0.98; p.x += p.vx; p.y += p.vy; p.life -= p.decay;
            ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
            break;
          case 'heart':
            p.y += p.vy; p.x += Math.sin(frame / 25 + p.phase) * 1.2;
            if (p.y < -p.size) p.life = 0;
            ctx.save(); ctx.translate(p.x, p.y); ctx.globalAlpha = Math.min(1, p.y / (H * 0.3));
            heartPath(ctx, p.size); ctx.fillStyle = p.color; ctx.fill();
            ctx.lineWidth = 3; ctx.strokeStyle = '#151515'; ctx.stroke(); ctx.restore();
            break;
          case 'star': {
            p.age++;
            const t = p.age / p.maxAge;
            if (t >= 1) { p.life = 0; break; }
            const scale = Math.sin(t * Math.PI);
            ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot + t); ctx.scale(scale, scale);
            starPath(ctx, p.size); ctx.fillStyle = p.color; ctx.fill(); ctx.restore();
            break;
          }
        }
        if (p.life <= 0) particles.splice(i, 1);
      }

      if (!spawning && !particles.length) return remove();
      raf = requestAnimationFrame(step);
    }

    function remove() {
      if (removed) return;
      removed = true;
      cancelAnimationFrame(raf);
      canvas.remove();
    }

    spawn(true, performance.now());
    raf = requestAnimationFrame(step);

    return (immediate) => {
      spawning = false;
      if (immediate) remove();
      else setTimeout(remove, 4000);
    };
  }

  return { start };
})();
