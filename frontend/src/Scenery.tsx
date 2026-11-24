import { useEffect, useId, useRef, useState } from 'react'

/* Nix's page has its own scenery, drawn from the name: a waymark is a sign on a trail.
   - Topo: a living contour map. The land drifts slowly, rises a little under the pointer, and a dashed trail with
     its waymarks crosses it while a small light walks the route.
   - NixFly: the mascot, a firefly: the small light that guides you along a trail at night. Its art is drawn layers
     (public/nix: body, wings, antenna; source and the script that cut them in docs/mascot); the face is drawn here, so
     it can blink, follow the pointer, look at the box while you type, think, and cheer when clicked. */

// ------------------------------------------------------------------ 3D simplex noise (after Stefan Gustavson)
const G3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]]
function makeNoise(seed = 7) {
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  let s = seed
  for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]] }
  const perm = new Uint8Array(512)
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]
  const F3 = 1 / 3, Gs = 1 / 6
  return (x: number, y: number, z: number) => {
    const t = (x + y + z) * F3
    const i = Math.floor(x + t), j = Math.floor(y + t), k = Math.floor(z + t)
    const u = (i + j + k) * Gs
    const x0 = x - (i - u), y0 = y - (j - u), z0 = z - (k - u)
    let i1, j1, k1, i2, j2, k2
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0 } else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1 } else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1 }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1 } else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1 } else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0 }
    const pts = [[x0, y0, z0, 0, 0, 0], [x0 - i1 + Gs, y0 - j1 + Gs, z0 - k1 + Gs, i1, j1, k1], [x0 - i2 + 2 * Gs, y0 - j2 + 2 * Gs, z0 - k2 + 2 * Gs, i2, j2, k2], [x0 - 0.5, y0 - 0.5, z0 - 0.5, 1, 1, 1]]
    let n = 0
    for (const [a, b, c, di, dj, dk] of pts) {
      let q = 0.6 - a * a - b * b - c * c
      if (q > 0) { const g = G3[perm[(i + di & 255) + perm[(j + dj & 255) + perm[k + dk & 255]]] % 12]; q *= q; n += q * q * (g[0] * a + g[1] * b + g[2] * c) }
    }
    return 32 * n
  }
}

// the trail, in fractions of the page: low across the land, under the box
const TRAIL: [number, number][] = [[-0.02, 0.9], [0.14, 0.8], [0.3, 0.86], [0.46, 0.76], [0.62, 0.83], [0.78, 0.7], [0.9, 0.74], [1.03, 0.6]]
const MARKS = [1, 3, 5, 6]

function useReduced() {
  const [r, setR] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  useEffect(() => {
    const m = window.matchMedia?.('(prefers-reduced-motion: reduce)'); if (!m) return
    const f = () => setR(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f)
  }, [])
  return r
}

export function Topo({ calm = false }: { calm?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const reduce = useReduced()
  const calmRef = useRef(calm); calmRef.current = calm
  useEffect(() => {
    const cv = ref.current; if (!cv) return
    const ctx = cv.getContext('2d'); if (!ctx) return
    const noise = makeNoise()
    let w = 0, h = 0, dpr = 1, raf = 0, last = 0, t0 = performance.now()
    const mouse = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4, k: 0, tk: 0 }
    let col = { line: '', strong: '', trail: '', glow: '' }
    const readColors = () => {
      const cs = getComputedStyle(cv)
      col = { line: cs.getPropertyValue('--topo-line').trim(), strong: cs.getPropertyValue('--topo-strong').trim(), trail: cs.getPropertyValue('--topo-trail').trim(), glow: cs.getPropertyValue('--topo-glow').trim() }
    }
    const size = () => {
      const r = cv.getBoundingClientRect(); dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      w = r.width; h = r.height; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr)
    }
    // the trail as a smooth curve (Catmull-Rom), sampled once per size
    const trailPts = () => {
      const P = TRAIL.map(([x, y]) => [x * w, y * h])
      const out: number[][] = []
      for (let i = 0; i < P.length - 1; i++) {
        const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)]
        for (let s = 0; s < 24; s++) {
          const t = s / 24, t2 = t * t, t3 = t2 * t
          out.push([0, 1].map((d) => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)))
        }
      }
      out.push(P[P.length - 1])
      return out
    }

    const frame = (now: number) => {
      raf = reduce ? 0 : requestAnimationFrame(frame)
      if (!reduce && now - last < 1000 / 30) return
      last = now
      const t = Math.max(0, now - t0) / 1000
      if (!w || !h) return
      mouse.x += (mouse.tx - mouse.x) * 0.08; mouse.y += (mouse.ty - mouse.y) * 0.08; mouse.k += (mouse.tk - mouse.k) * 0.05
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // the land: height = drifting noise + a soft rise under the pointer; contours by marching squares
      const cell = 16, cols = Math.ceil(w / cell) + 1, rows = Math.ceil(h / cell) + 1
      const z = t * 0.035, sc = 0.0021, r2 = 220 * 220
      const v = new Float32Array(cols * rows)
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const x = i * cell, y = j * cell
        let e = noise(x * sc, y * sc, z) * 0.75 + noise(x * sc * 2.1 + 9, y * sc * 2.1, z * 1.4) * 0.25
        const dx = x - mouse.x, dy = y - mouse.y
        e += 0.42 * mouse.k * Math.exp(-(dx * dx + dy * dy) / r2)
        v[j * cols + i] = e
      }
      const levels = 14
      for (let l = 0; l < levels; l++) {
        const L = -0.9 + (l / (levels - 1)) * 1.8
        ctx.beginPath()
        for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
          const a = v[j * cols + i], b = v[j * cols + i + 1], c = v[(j + 1) * cols + i + 1], d = v[(j + 1) * cols + i]
          const idx = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (c > L ? 2 : 0) | (d > L ? 1 : 0)
          if (idx === 0 || idx === 15) continue
          const x = i * cell, y = j * cell
          const top = [x + cell * (L - a) / (b - a), y], right = [x + cell, y + cell * (L - b) / (c - b)]
          const bottom = [x + cell * (L - d) / (c - d), y + cell], left = [x, y + cell * (L - a) / (d - a)]
          const seg = (p: number[], q: number[]) => { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]) }
          switch (idx) {
            case 1: case 14: seg(left, bottom); break
            case 2: case 13: seg(bottom, right); break
            case 3: case 12: seg(left, right); break
            case 4: case 11: seg(top, right); break
            case 5: seg(left, top); seg(bottom, right); break
            case 6: case 9: seg(top, bottom); break
            case 7: case 8: seg(left, top); break
            case 10: seg(left, bottom); seg(top, right); break
          }
        }
        ctx.strokeStyle = l % 4 === 2 ? col.strong : col.line
        ctx.lineWidth = l % 4 === 2 ? 1.2 : 0.8
        ctx.stroke()
      }

      // the trail: dashes marching along, waymarks on it, a small light walking the route
      const pts = trailPts()
      ctx.save()
      ctx.globalAlpha = calmRef.current ? 0.5 : 1
      ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.setLineDash([7, 9]); ctx.lineDashOffset = -t * 9; ctx.strokeStyle = col.trail; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.stroke()
      ctx.setLineDash([])
      for (const m of MARKS) {
        const [x, y] = TRAIL[m]; const px = x * w, py = y * h
        ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.fillStyle = col.trail; ctx.fill()
        ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2); ctx.strokeStyle = col.trail; ctx.lineWidth = 1; ctx.globalAlpha *= 0.5; ctx.stroke(); ctx.globalAlpha = calmRef.current ? 0.5 : 1
      }
      const f = (t * 0.018) % 1, at = pts[Math.min(pts.length - 1, Math.max(0, Math.floor(f * (pts.length - 1))))]
      const g = ctx.createRadialGradient(at[0], at[1], 0, at[0], at[1], 26)
      g.addColorStop(0, col.glow); g.addColorStop(1, 'transparent')
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(at[0], at[1], 26, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.arc(at[0], at[1], 3, 0, Math.PI * 2); ctx.fillStyle = col.trail; ctx.fill()
      ctx.restore()
    }

    readColors(); size()
    const ro = new ResizeObserver(() => { size(); if (reduce) frame(performance.now()) })
    ro.observe(cv)
    const mo = new MutationObserver(() => { readColors(); if (reduce) frame(performance.now()) })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const move = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); mouse.tx = e.clientX - r.left; mouse.ty = e.clientY - r.top; mouse.tk = 1; if (mouse.x < -1e3) { mouse.x = mouse.tx; mouse.y = mouse.ty } }
    const leave = () => { mouse.tk = 0 }
    window.addEventListener('pointermove', move); document.addEventListener('pointerleave', leave)
    const vis = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0 } else if (!raf && !reduce) raf = requestAnimationFrame(frame) }
    document.addEventListener('visibilitychange', vis)
    if (reduce) frame(performance.now()); else raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect()
      window.removeEventListener('pointermove', move); document.removeEventListener('pointerleave', leave); document.removeEventListener('visibilitychange', vis)
    }
  }, [reduce])
  return <canvas ref={ref} className="topo" aria-hidden="true" />
}


// the art's frame, in the coordinates of the source picture (docs/mascot/nix.png, 1254 px square); the layers are cut
// to this box, and the face and every pivot below are in the same coordinates
const VB = { x: 99, y: 195, w: 1054, h: 849 }
const EYES = { l: 506, r: 750, y: 718 }
export type NixMood = 'idle' | 'look' | 'think'

/** The mascot. `mood`: 'look' points the eyes at the box below (while you type), 'think' while a reply is coming. */
export function NixFly({ mood = 'idle', size }: { mood?: NixMood; size?: number }) {
  const ref = useRef<SVGSVGElement>(null)
  const id = useId().replace(/:/g, '')
  const [eye, setEye] = useState({ x: 0, y: 0 })
  const [blink, setBlink] = useState(false)
  const [joy, setJoy] = useState(0)
  const reduce = useReduced()
  // the eyes follow the pointer, unless there is something else to look at
  useEffect(() => {
    if (mood !== 'idle') return
    const move = (e: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect(); if (!r) return
      const cx = r.left + r.width * ((EYES.l + EYES.r) / 2 - VB.x) / VB.w, cy = r.top + r.height * (EYES.y - VB.y) / VB.h
      const dx = e.clientX - cx, dy = e.clientY - cy, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 320)
      setEye({ x: (dx / d) * k, y: (dy / d) * k })
    }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, [mood])
  useEffect(() => {
    if (reduce) return
    let t = 0
    const next = () => {
      t = window.setTimeout(() => {
        setBlink(true); window.setTimeout(() => setBlink(false), 130)
        if (Math.random() < 0.25) window.setTimeout(() => { setBlink(true); window.setTimeout(() => setBlink(false), 120) }, 260)   // now and then a double blink
        next()
      }, 2400 + Math.random() * 3600)
    }
    next()
    return () => window.clearTimeout(t)
  }, [reduce])
  useEffect(() => {
    if (!joy) return
    const t = window.setTimeout(() => setJoy(0), 1500)
    return () => window.clearTimeout(t)
  }, [joy])

  const happy = joy > 0
  const at = mood === 'look' ? { x: 0.15, y: 1 } : mood === 'think' ? { x: -0.55, y: -0.8 } : eye
  const ex = at.x * 16, ey = at.y * 13
  const img = (name: string, cls: string) => <image className={cls} href={`/nix/${name}.webp`} x={VB.x} y={VB.y} width={VB.w} height={VB.h} />
  const eyeEl = (cx: number) => (
    <g className="nm-eye">
      <ellipse cx={cx} cy={EYES.y} rx="51.5" ry="82.5" />
      <ellipse className="nm-glint" cx={cx + (cx < 626 ? 10 : -10) - ex * 0.35} cy={676 - ey * 0.35} rx="16" ry="19.5" />
    </g>
  )
  return (
    <svg ref={ref} className={`nixfly mood-${mood}` + (happy ? ' happy' : '')} viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`}
      style={size ? { width: size } : undefined} aria-hidden="true" onClick={() => setJoy((j) => j + 1)}>
      <defs>
        <radialGradient id={`g${id}`}><stop className="nm-g0" offset="0" /><stop className="nm-g1" offset="0.55" /><stop className="nm-g2" offset="1" /></radialGradient>
        <radialGradient id={`b${id}`}><stop className="nm-b0" offset="0" /><stop className="nm-b1" offset="1" /></radialGradient>
        <filter id={`s${id}`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7" /></filter>
      </defs>
      <ellipse className="nm-glow" cx="626" cy="760" rx="520" ry="470" fill={`url(#g${id})`} />
      <g className="nm-hop" >
        <g className="nm-bob">
          <g className="nm-lean" style={{ transform: `rotate(${at.x * 3}deg)` }}>
            {img('wing-l', 'nm-wing nm-wl')}
            {img('wing-r', 'nm-wing nm-wr')}
            <g className="nm-ant">
              {img('antenna', '')}
              <circle className="nm-bulb" cx="712" cy="312" r="58" fill={`url(#b${id})`} />
            </g>
            {img('body', 'nm-body')}
            <g className="nm-face" style={{ transform: `translate(${ex}px, ${ey}px)` }}>
              <g className="nm-blush" filter={`url(#s${id})`} style={{ transform: `translate(${-ex * 0.4}px, ${-ey * 0.4}px)` }}>
                <ellipse cx="452" cy="814" rx="42" ry="25" /><ellipse cx="803" cy="814" rx="42" ry="25" />
              </g>
              {happy ? (
                <g className="nm-eye-joy">
                  <path d="M462 738 Q506 664 550 738" /><path d="M706 738 Q750 664 794 738" />
                </g>
              ) : (
                <g className={'nm-eyes' + (blink ? ' shut' : '')}>{eyeEl(EYES.l)}{eyeEl(EYES.r)}</g>
              )}
              {happy ? <path className="nm-mouth" d="M574 758 Q628 744 682 758 Q676 846 628 846 Q580 846 574 758 Z" />
                : mood === 'think' ? <ellipse className="nm-mouth" cx="628" cy="792" rx="15" ry="18" />
                : <><path className="nm-mouth" d="M588 758 Q628 748 668 758 Q664 826 628 826 Q592 826 588 758 Z" /><ellipse className="nm-tongue" cx="628" cy="807" rx="23" ry="12" /></>}
            </g>
          </g>
        </g>
      </g>
    </svg>
  )
}
