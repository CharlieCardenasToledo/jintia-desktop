/**
 * JintiaLoader.js — Loader animado oficial de Jintia (morph del isotipo →
 * círculo giratorio → vuelta al isotipo), diseñado para reemplazar cualquier
 * spinner genérico del sistema (dependencias, onboarding, "pensando" del
 * chat, etc.).
 *
 * A diferencia del snippet original (una sola página HTML con
 * `document.getElementById` global y un único `window.JintiaLoader`), este
 * módulo soporta múltiples instancias simultáneas en la misma página: cada
 * `mount()` genera ids únicos para sus gradientes/paths (si dos instancias
 * compartieran el mismo id, `fill="url(#j-teal)"` de la segunda apuntaría al
 * gradiente de la primera, porque las referencias SVG por id se resuelven en
 * todo el documento, no dentro de cada `<svg>`) y su propio bucle de
 * animación cancelable.
 */

let _instanceSeq = 0;

// ── Helper para plantillas de string (btn.innerHTML = `...`) ──────────────
// Muchos spinners del sistema hoy son iconos estáticos insertados como texto
// (`btn.innerHTML = icono + "Verificando…"`). Para no obligar a
// cada call-site a guardar y destruir manualmente un controlador (fácil de
// olvidar, y cada `btn.innerHTML = ...` posterior desconecta el nodo sin que
// nadie llame a destroy(), dejando el bucle de animación corriendo para
// siempre), un único MutationObserver global detecta cuándo un placeholder
// montado desaparece del documento y lo destruye automáticamente.
const _controllersByNode = new WeakMap();
let _cleanupObserver = null;

function destroyIfMounted(node) {
  _controllersByNode.get(node)?.destroy();
  _controllersByNode.delete(node);
}

function ensureCleanupObserver() {
  if (_cleanupObserver) return;
  _cleanupObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.removedNodes.forEach((removed) => {
        if (!(removed instanceof Element)) return;
        if (removed.hasAttribute?.('data-jintia-mounted')) destroyIfMounted(removed);
        removed.querySelectorAll?.('[data-jintia-mounted]').forEach(destroyIfMounted);
      });
    }
  });
  _cleanupObserver.observe(document.body, { childList: true, subtree: true });
}

/**
 * HTML de un contenedor vacío del tamaño pedido (px), listo para
 * `mountAllJintiaLoaders()`. Pensado para reemplazar iconos de spinner
 * estáticos dentro de plantillas de string.
 */
export function jintiaLoaderPlaceholder(sizePx = 16, contrast = 'auto') {
  const size = Math.max(10, Math.min(240, Number(sizePx) || 16));
  const safeContrast = ['light', 'dark'].includes(contrast) ? contrast : 'auto';
  return `<span class="jintia-loader-inline" data-jintia-loader-contrast="${safeContrast}" style="display:inline-block;width:${size}px;height:${size}px;vertical-align:middle;line-height:0;"></span>`;
}

/**
 * Monta el loader en todos los placeholders (`jintiaLoaderPlaceholder()`)
 * dentro de `root` que aún no tengan uno montado. Llamar justo después de
 * insertar HTML que contenga el placeholder. La limpieza al desmontar es
 * automática (ver `ensureCleanupObserver`); no hace falta llamar destroy().
 */
export function mountAllJintiaLoaders(root = document) {
  ensureCleanupObserver();
  const nodes = root.querySelectorAll?.('.jintia-loader-inline:not([data-jintia-mounted])') || [];
  const controllers = [];
  nodes.forEach((node) => {
    node.setAttribute('data-jintia-mounted', '1');
    const controller = mountJintiaLoader(node, {
      contrast: node.dataset.jintiaLoaderContrast || 'auto',
    });
    _controllersByNode.set(node, controller);
    controllers.push(controller);
  });
  return controllers;
}

function buildMarkup(uid) {
  const id = (base) => `${base}-${uid}`;
  return `
    <svg class="jintia-loader-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" style="width:100%;height:100%;display:block;overflow:visible" aria-hidden="true">
      <defs>
        <linearGradient id="${id('j-white')}" x1="107" y1="304" x2="271" y2="88" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="var(--jintia-loader-body-start, #16323D)"/>
          <stop offset="0.52" stop-color="var(--jintia-loader-body-middle, #102A35)"/>
          <stop offset="1" stop-color="var(--jintia-loader-body-end, #0B2230)"/>
        </linearGradient>
        <linearGradient id="${id('j-teal')}" x1="87" y1="276" x2="126" y2="238" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#0A8F95"/>
          <stop offset="1" stop-color="#12B3AA"/>
        </linearGradient>
        <linearGradient id="${id('j-green')}" x1="218" y1="135" x2="271" y2="88" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#13B889"/>
          <stop offset="1" stop-color="#34C37A"/>
        </linearGradient>
        <path id="${id('targetLower')}" d="M 145.789 104.943 A 101 101 0 1 1 77.534 183.462 L 112.987 189.713 A 65 65 0 1 0 156.914 139.181 Z"/>
        <path id="${id('targetUpper')}" d="M 100.774 134.738 A 101 101 0 0 1 135.920 108.732 L 150.562 141.620 A 65 65 0 0 0 127.944 158.356 Z"/>
      </defs>
      <g transform="translate(26.4 -33.6) scale(2.7)">
        <g id="${id('rotator')}">
          <path id="${id('lowerBody')}" fill="url(#${id('j-white')})" d="M 218 159
L 182 187
L 182 232
C 181.60 233.87, 180.07 242.93, 179.00 246.00
C 177.93 249.07, 175.47 253.00, 174.00 255.00
C 172.53 257.00, 170.40 259.40, 168.00 261.00
C 165.60 262.60, 159.33 266.20, 156.00 267.00
C 152.67 267.80, 145.80 267.53, 143.00 267.00
C 140.20 266.47, 136.60 262.33, 135.00 263.00
C 133.40 263.67, 132.47 269.73, 131.00 272.00
C 129.53 274.27, 126.13 278.27, 124.00 280.00
C 121.87 281.73, 117.27 284.20, 115.00 285.00
C 112.73 285.80, 107.53 285.33, 107.00 286.00
C 106.47 286.67, 107.27 287.87, 111.00 290.00
C 114.73 292.13, 128.87 300.13, 135.00 302.00
C 141.13 303.87, 153.00 304.93, 157.00 304.00
C 161.00 303.07, 180.00 298.80, 184.00 296.00
C 188.00 293.20, 199.07 283.27, 202.00 281.00
C 204.93 278.73, 211.00 265.47, 213.00 262.00
C 215.00 258.53, 216.47 249.00, 217.00 247.00
L 218 159 Z"/>
          <path id="${id('upperBody')}" fill="url(#${id('j-white')})" d="M 217 109
L 184 141
C 182 144, 181 148, 181 151
L 181 170
L 223 137
L 223 115 Z"/>
          <circle id="${id('dot')}" cx="106" cy="257" r="18.5" fill="url(#${id('j-teal')})"/>
          <g id="${id('arrowMover')}">
            <path fill="url(#${id('j-green')})" d="M 218 88
L 271 89
L 245 135
C 242 126, 239 117, 235 109 Z"/>
          </g>
        </g>
      </g>
    </svg>`;
}

function clamp(v, a = 0, b = 1) {
  return Math.min(b, Math.max(a, v));
}

function smoother(t) {
  t = clamp(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function sample(path, n) {
  const len = path.getTotalLength();
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p = path.getPointAtLength((i / n) * len);
    pts.push({ x: p.x, y: p.y });
  }
  return pts;
}

function reversePts(pts) {
  return pts.slice().reverse();
}

function shifted(pts, shift) {
  const n = pts.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = pts[(i + shift) % n];
  return out;
}

// Alinea los polígonos para que el morph tenga la menor torsión posible.
function align(source, target) {
  let best = target;
  let bestScore = Infinity;
  const variants = [target, reversePts(target)];
  for (const variant of variants) {
    for (let shift = 0; shift < variant.length; shift += 2) {
      let score = 0;
      for (let i = 0; i < source.length; i += 6) {
        const b = variant[(i + shift) % variant.length];
        const dx = source[i].x - b.x;
        const dy = source[i].y - b.y;
        score += dx * dx + dy * dy;
      }
      if (score < bestScore) {
        bestScore = score;
        best = shifted(variant, shift);
      }
    }
  }
  return best;
}

function closedPath(pts) {
  let d = `M ${pts[0].x.toFixed(3)} ${pts[0].y.toFixed(3)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i].x.toFixed(3)} ${pts[i].y.toFixed(3)}`;
  }
  return d + " Z";
}

function morphPoints(src, dst, p) {
  const pts = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    pts[i] = {
      x: src[i].x + (dst[i].x - src[i].x) * p,
      y: src[i].y + (dst[i].y - src[i].y) * p,
    };
  }
  return pts;
}

function applySnake(pts, phaseDeg, amp, cycles, headBias = 0) {
  if (amp <= 0.0001) return pts;
  const out = pts.map(p => ({ x: p.x, y: p.y }));
  const n = pts.length;

  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];

    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;

    const u = i / (n - 1);
    const edgeFade = Math.pow(Math.sin(Math.PI * u), 1.8);
    const headWeight = 0.88 + headBias * u;
    const wave = Math.sin((u * cycles * Math.PI * 2) - phaseDeg * Math.PI / 180);

    out[i].x += nx * amp * edgeFade * headWeight * wave;
    out[i].y += ny * amp * edgeFade * headWeight * wave;
  }

  return out;
}

const DURATION = 10800;
const N_LOWER = 240;
const N_UPPER = 120;
const CIRCLE = { cx: 177, cy: 201, r: 83 };

function bodyProgress(t) {
  if (t < 0.12) return 0;
  if (t < 0.36) return smoother((t - 0.12) / 0.24);
  if (t < 0.72) return 1;
  if (t < 0.94) return 1 - smoother((t - 0.72) / 0.22);
  return 0;
}

function arrowProgress(t) {
  if (t < 0.07) return 0;
  if (t < 0.26) return smoother((t - 0.07) / 0.19);
  if (t < 0.72) return 1;
  if (t < 0.94) return 1 - smoother((t - 0.72) / 0.22);
  return 0;
}

function spinProgress(t) {
  if (t < 0.36) return 0;
  // El giro no termina al comenzar la reconstrucción: sigue acompañando al
  // isotipo y completa 1080° (3 vueltas) cuando la flecha ya casi volvió.
  if (t < 0.905) return smoother((t - 0.36) / (0.905 - 0.36));
  return 1;
}

function snakeAmount(t, p) {
  const circleReady = smoother(clamp((p - 0.78) / 0.22));
  const motionWindowIn = smoother(clamp((t - 0.34) / 0.12));
  const motionWindowOut = 1 - smoother(clamp((t - 0.82) / 0.12));
  return circleReady * motionWindowIn * motionWindowOut;
}

const CONTRAST_PALETTES = {
  dark: ['#16323D', '#102A35', '#0B2230'],
  light: ['#EAF4F6', '#FFFFFF', '#FFFFFF'],
};

function rgbFromCssColor(value) {
  const match = String(value || '').match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

function relativeLuminance([red, green, blue]) {
  const linear = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

// El color de texto ya expresa el contraste que la superficie necesita
// (texto claro en botones/oscuros y oscuro en tarjetas claras). Usarlo como
// señal resulta más fiable que intentar recomponer fondos translúcidos y con
// backdrop-filter recorriendo todos sus ancestros.
function resolveContrast(container, requested) {
  if (requested === 'light' || requested === 'dark') return requested;
  const color = rgbFromCssColor(globalThis.getComputedStyle?.(container)?.color);
  return color && relativeLuminance(color) > 0.48 ? 'light' : 'dark';
}

function applyContrast(container, contrast) {
  const palette = CONTRAST_PALETTES[contrast];
  container.dataset.jintiaLoaderResolvedContrast = contrast;
  container.style.setProperty('--jintia-loader-body-start', palette[0]);
  container.style.setProperty('--jintia-loader-body-middle', palette[1]);
  container.style.setProperty('--jintia-loader-body-end', palette[2]);
}

/**
 * Monta el loader dentro de `container` (debe estar vacío; este módulo pone
 * su propio `innerHTML`) y arranca la animación. Respeta
 * `prefers-reduced-motion`: en ese caso queda como icono estático (el
 * isotipo en reposo), sin bucle de animación.
 *
 * @returns {{ pause(): void, play(): void, restart(): void, destroy(): void }}
 */
export function mountJintiaLoader(container, { contrast = container?.dataset?.jintiaLoaderContrast || 'auto' } = {}) {
  const uid = `jl${_instanceSeq++}`;
  applyContrast(container, resolveContrast(container, contrast));
  container.innerHTML = buildMarkup(uid);
  const q = (base) => container.querySelector(`#${base}-${uid}`);

  const lower = q('lowerBody');
  const upper = q('upperBody');
  const targetLower = q('targetLower');
  const targetUpper = q('targetUpper');
  const arrowMover = q('arrowMover');
  const dot = q('dot');
  const rotator = q('rotator');

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) {
    // Deja el isotipo tal cual (markup de reposo) y no arranca el bucle.
    return { pause() {}, play() {}, restart() {}, destroy() {} };
  }

  const ORIGINAL_LOWER = lower.getAttribute('d');
  const ORIGINAL_UPPER = upper.getAttribute('d');

  const srcLower = sample(lower, N_LOWER);
  const srcUpper = sample(upper, N_UPPER);
  const dstLower = align(srcLower, sample(targetLower, N_LOWER));
  const dstUpper = align(srcUpper, sample(targetUpper, N_UPPER));

  function setBody(p, t, spin) {
    if (p <= 0.0005) {
      lower.setAttribute('d', ORIGINAL_LOWER);
      upper.setAttribute('d', ORIGINAL_UPPER);
      return;
    }
    if (p >= 0.9995 && t >= 0.42 && t <= 0.82) {
      const snake = snakeAmount(t, p);
      const lowerPts = applySnake(dstLower, spin * 1.35, 2.6 * snake, 1.15, 0.18);
      const upperPts = applySnake(dstUpper, spin * 1.15 + 22, 0.95 * snake, 0.9, 0.06);
      lower.setAttribute('d', closedPath(lowerPts));
      upper.setAttribute('d', closedPath(upperPts));
      return;
    }
    const snake = snakeAmount(t, p);
    let lowerPts = morphPoints(srcLower, dstLower, p);
    let upperPts = morphPoints(srcUpper, dstUpper, p);
    if (snake > 0.0001) {
      lowerPts = applySnake(lowerPts, spin * 1.35, 2.2 * snake, 1.15, 0.18);
      upperPts = applySnake(upperPts, spin * 1.15 + 22, 0.75 * snake, 0.9, 0.06);
    }
    lower.setAttribute('d', closedPath(lowerPts));
    upper.setAttribute('d', closedPath(upperPts));
  }

  // Flecha: vértice real (271,89), punto de unión con el isotipo (235,109).
  const tip0 = { x: 271, y: 89 };
  const anchor0 = { x: 235, y: 109 };
  const a = 25 * Math.PI / 180;
  const anchor1 = {
    x: CIRCLE.cx + CIRCLE.r * Math.cos(a),
    y: CIRCLE.cy + CIRCLE.r * Math.sin(a),
  };
  const originalArrowAngle = Math.atan2(tip0.y - anchor0.y, tip0.x - anchor0.x) * 180 / Math.PI;
  const tangentAngle = (a * 180 / Math.PI) + 90;
  const finalArrowRotation = tangentAngle - originalArrowAngle;
  const arrowDX = anchor1.x - anchor0.x;
  const arrowDY = anchor1.y - anchor0.y;

  function setArrow(p) {
    p = smoother(p);
    const dx = arrowDX * p;
    const dy = arrowDY * p;
    const angle = finalArrowRotation * p;
    arrowMover.setAttribute('transform', `translate(${dx.toFixed(3)} ${dy.toFixed(3)}) rotate(${angle.toFixed(3)} ${anchor0.x} ${anchor0.y})`);
  }

  const dot0 = { x: 106, y: 257 };
  const da = 140 * Math.PI / 180;
  const dot1 = {
    x: CIRCLE.cx + CIRCLE.r * Math.cos(da),
    y: CIRCLE.cy + CIRCLE.r * Math.sin(da),
  };

  function setDot(p) {
    p = smoother(p);
    dot.setAttribute('cx', (dot0.x + (dot1.x - dot0.x) * p).toFixed(3));
    dot.setAttribute('cy', (dot0.y + (dot1.y - dot0.y) * p).toFixed(3));
  }

  let origin = performance.now();
  let pausedAt = 0;
  let pauseOffset = 0;
  let paused = false;
  let destroyed = false;
  let rafId = null;

  function render(now) {
    if (destroyed) return;
    if (paused) {
      rafId = requestAnimationFrame(render);
      return;
    }
    const elapsed = (now - origin - pauseOffset) % DURATION;
    const t = elapsed / DURATION;
    const bp = bodyProgress(t);
    const ap = arrowProgress(t);
    const spin = 1080 * spinProgress(t);

    setBody(bp, t, spin);
    setArrow(ap);
    setDot(bp);
    rotator.setAttribute('transform', spin >= 1079.999 ? '' : `rotate(${spin.toFixed(4)} 177 201)`);

    if (t >= 0.94) {
      lower.setAttribute('d', ORIGINAL_LOWER);
      upper.setAttribute('d', ORIGINAL_UPPER);
      arrowMover.setAttribute('transform', '');
      dot.setAttribute('cx', '106');
      dot.setAttribute('cy', '257');
      rotator.setAttribute('transform', '');
    }

    rafId = requestAnimationFrame(render);
  }

  rafId = requestAnimationFrame(render);

  return {
    restart() {
      origin = performance.now();
      pauseOffset = 0;
      paused = false;
    },
    pause() {
      if (!paused) {
        paused = true;
        pausedAt = performance.now();
      }
    },
    play() {
      if (paused) {
        pauseOffset += performance.now() - pausedAt;
        paused = false;
      }
    },
    // Detiene el bucle requestAnimationFrame para siempre. Imprescindible
    // llamarlo al quitar el contenedor del DOM (p. ej. hideThinkingBubble()):
    // sin esto, cada burbuja de "pensando" deja un bucle de animación
    // corriendo en segundo plano para siempre, aunque su <svg> ya no exista.
    destroy() {
      destroyed = true;
      if (rafId != null) cancelAnimationFrame(rafId);
    },
  };
}
