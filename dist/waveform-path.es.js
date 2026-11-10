const it = 4096;
const K = /* @__PURE__ */ new WeakMap(), lt = (e) => {
  window.AudioContext = window.AudioContext || window.webkitAudioContext;
  const r = new AudioContext();
  return fetch(e).then((n) => n.arrayBuffer()).then((n) => r.decodeAudioData(n)).catch((n) => {
    console.error(n);
  });
}, et = (e) => {
  const r = e.length, n = e.numberOfChannels || 1;
  if (n <= 1)
    return e.getChannelData(0);
  const l = new Float32Array(r), h = [];
  for (let t = 0; t < n; t++)
    h.push(e.getChannelData(t));
  for (let t = 0; t < r; t++) {
    let a = 0;
    for (let x = 0; x < n; x++)
      a += h[x][t];
    l[t] = a / n;
  }
  return l;
}, nt = (e) => {
  const r = et(e), n = r.length, l = Math.ceil(n / 4096), h = new Float32Array(l), t = new Float32Array(l);
  for (let a = 0; a < l; a++) {
    const x = a * 4096, g = Math.min(n, x + 4096);
    let m = 1 / 0, o = -1 / 0;
    for (let I = x; I < g; I++) {
      const C = Math.abs(r[I]);
      C < m && (m = C), C > o && (o = C);
    }
    m === 1 / 0 && (m = 0, o = 0), h[a] = m, t[a] = o;
  }
  return {
    length: n,
    mono: r,
    granMin: h,
    granMax: t,
    bucketCache: /* @__PURE__ */ new Map(),
    pathCache: /* @__PURE__ */ new Map()
  };
}, Z = (e) => {
  let r = K.get(e);
  return r || (r = nt(e), K.set(e, r)), r;
}, st = (e, r, n, l) => {
  const h = e.length;
  if (!r)
    return [{ start: 0, end: h }];
  const t = l / n, a = [];
  for (let x = 0; x < h; x += t) {
    const g = Math.trunc(x);
    if (g >= h) break;
    const m = Math.min(h, Math.trunc(x + t));
    a.push({ start: g, end: Math.max(g, m) });
  }
  return a;
}, ot = (e, r, n) => {
  if (n = Math.min(n, e.length), r >= n)
    return { min: 0, max: 0 };
  let l = 1 / 0, h = -1 / 0, t = r;
  for (; t < n; ) {
    const a = Math.floor(t / 4096), x = a * 4096, g = Math.min(e.length, x + 4096), m = Math.min(n, g);
    if (t === x && m === g) {
      const o = e.granMin[a], I = e.granMax[a];
      o < l && (l = o), I > h && (h = I);
    } else {
      const o = e.mono;
      for (let I = t; I < m; I++) {
        const C = Math.abs(o[I]);
        C < l && (l = C), C > h && (h = C);
      }
    }
    t = m;
  }
  return l === 1 / 0 && (l = 0, h = 0), { min: l, max: h };
}, at = (e, r, n) => {
  const l = [], h = r.length;
  for (let t = 0; t < h; t++) {
    const { start: a, end: x } = r[t], g = x - a, m = Math.floor(g / n), o = new Float32Array(n), I = new Float32Array(n);
    if (m > 0)
      for (let C = 0; C < n; C++) {
        const A = a + m * C, { min: s, max: d } = ot(e, A, A + m);
        o[C] = s, I[C] = d;
      }
    l.push({ min: o, max: I });
  }
  return l;
}, J = (e, r, n) => {
  const { samples: l, animation: h, animationframes: t } = n, a = h ? `a:${r.sampleRate}:${t}:${l}` : `s:${l}`;
  let x = e.bucketCache.get(a);
  if (!x) {
    const g = st(e, h, t, r.sampleRate);
    x = at(e, g, l), e.bucketCache.set(a, x), X(e.bucketCache, 8);
  }
  return x;
}, W = (e, r) => {
  if (!r)
    return e;
  let n = 0;
  for (const h of e) {
    const t = h.max;
    for (let a = 0; a < t.length; a++)
      t[a] > n && (n = t[a]);
  }
  const l = n > 0 ? Math.pow(n, -1) : 1;
  return e.map((h) => ({
    min: h.min.map((t) => t * l),
    max: h.max.map((t) => t * l)
  }));
}, q = (e, r, n) => n !== "bars" && r % 2 === 0 ? e.min[r] : e.max[r], ct = (e, r) => {
  const n = e.get(r);
  e.delete(r), e.set(r, n);
}, X = (e, r) => {
  for (; e.size > r; ) {
    const n = e.keys().next().value;
    e.delete(n);
  }
}, Q = (e) => Array.isArray(e) ? `[${e.map(Q).join(",")}]` : e && typeof e == "object" ? `{${Object.keys(e).sort().map((n) => `${JSON.stringify(n)}:${Q(e[n])}`).join(",")}}` : JSON.stringify(e), rt = (e, r) => {
  const { samples: n, width: l, ...h } = r;
  return `${e}|${n}|${l}|${Q(h)}`;
}, B = (e, r) => {
  const n = { ...r, ...e };
  return n.paths = n.paths.map((l) => ({
    ...l,
    minshow: l.minshow ?? 0,
    maxshow: l.maxshow ?? 1,
    normalize: l.normalize ?? !1
  })), n;
}, tt = (e, r, n, l) => {
  const h = rt(r, n);
  if (e.pathCache.has(h))
    return ct(e.pathCache, h), e.pathCache.get(h);
  const t = l();
  return e.pathCache.set(h, t), X(e.pathCache, 32), t;
}, ht = (e, r) => {
  const n = B(r, {
    channel: 0,
    samples: e.length,
    height: 100,
    width: 800,
    top: 0,
    left: 0,
    type: "steps",
    paths: [{ d: "Q", sx: 0, sy: 0, x: 50, y: 100, ex: 100, ey: 0 }],
    animation: !1,
    animationframes: 10,
    normalize: !0
  }), l = Z(e);
  return tt(l, "linear", n, () => {
    const {
      samples: h,
      height: t,
      width: a,
      top: x,
      left: g,
      type: m,
      paths: o,
      normalize: I
    } = n, C = W(J(l, e, n), I);
    let A = "";
    const s = m != "bars" ? (t + x * 2) / 2 : t + x, d = a / h, V = o.length, R = m == "mirror" ? V * 2 : V, F = C.length;
    for (let L = 0; L < F; L++) {
      if (L > 0) {
        const M = A.length;
        A.charAt(M - 1) == ";" || M === 0 ? A += " M 0 0 ;" : A += ";";
      }
      let w = -9999, $ = -9999;
      for (let M = 0; M < h; M++) {
        const j = q(C[L], M, m), u = m != "bars" ? M % 2 ? 1 : -1 : 1;
        let T = 1;
        for (let U = 0; U < R; U++) {
          let i = U;
          U >= V && (i = U - V, T = -1);
          const k = o[i].normalize ? 1 : j;
          if (o[i].minshow <= j && o[i].maxshow >= j)
            switch (o[i].d) {
              case "L": {
                const p = M * d + d * o[i].sx / 100 + g, b = s + k * o[i].sy / 100 * (m != "bars" ? t / 2 : t) * -u * T, f = M * d + d * o[i].ex / 100 + g, _ = s + k * o[i].ey / 100 * (m != "bars" ? t / 2 : t) * -u * T;
                (p !== w || b !== $) && (A += `M ${p} ${b} `), A += `L ${f} ${_} `, w = f, $ = _;
                break;
              }
              case "H": {
                const p = M * d + d * o[i].sx / 100 + g, b = s + k * o[i].y / 100 * (m != "bars" ? t / 2 : t) * -u * T, f = M * d + d * o[i].ex / 100 + g, _ = b;
                (p !== w || b !== $) && (A += `M ${p} ${b} `), A += `H ${f} `, w = f, $ = _;
                break;
              }
              case "V": {
                const p = M * d + d * o[i].x / 100 + g, b = s + k * o[i].sy / 100 * (m != "bars" ? t / 2 : t) * -u * T, f = p, _ = s + k * o[i].ey / 100 * (m != "bars" ? t / 2 : t) * -u * T;
                (p !== w || b !== $) && (A += `M ${p} ${b} `), A += `V ${_} `, w = f, $ = _;
                break;
              }
              case "C": {
                const p = M * d + d * o[i].sx / 100 + g, b = s - s * o[i].sy / 100 * u, f = M * d + d * o[i].x / 100 + g, _ = s + k * o[i].y / 100 * (m != "bars" ? t : t * 2) * -u * T, E = M * d + d * o[i].ex / 100 + g, c = s - s * o[i].ey / 100 * u;
                (p !== w || b !== $) && (A += `M ${p} ${b} `), A += `C ${p} ${b} ${f} ${_} ${E} ${c} `, w = E, $ = c;
                break;
              }
              case "Q": {
                const p = M * d + d * o[i].sx / 100 + g, b = s + k * o[i].sy / 100 * (m != "bars" ? t / 2 : t) * -u * T, f = M * d + d * o[i].x / 100 + g, _ = s + k * o[i].y / 100 * (m != "bars" ? t : t * 2) * -u * T, E = M * d + d * o[i].ex / 100 + g, c = s + k * o[i].ey / 100 * (m != "bars" ? t / 2 : t) * -u * T;
                (p !== w || b !== $) && (A += `M ${p} ${b} `), A += `Q ${f} ${_} ${E} ${c} `, w = E, $ = c;
                break;
              }
              case "A": {
                const p = M * d + d * o[i].sx / 100 + g, b = s + k * o[i].sy / 100 * (m != "bars" ? t / 2 : t) * -u * T, f = M * d + d * o[i].ex / 100 + g, _ = s + k * o[i].ey / 100 * (m != "bars" ? t / 2 : t) * -u * T;
                (p !== w || b !== $) && (A += `M ${p} ${b} `);
                const E = o[i].rx * d / 100, c = o[i].ry * d / 100;
                let y = o[i].sweep;
                u == -1 && (y == 1 ? y = 0 : y = 1), T == -1 && (y == 1 ? y = 0 : y = 1), A += `A ${E} ${c} ${o[i].angle} ${o[i].arc} ${y} ${f} ${_} `, w = f, $ = _;
                break;
              }
              case "Z":
                A += "Z ";
                break;
            }
        }
      }
    }
    return A;
  });
}, pt = (e, r) => {
  const n = B(r, {
    channel: 0,
    samples: e.length,
    distance: 50,
    length: 100,
    top: 0,
    left: 0,
    type: "steps",
    startdeg: 0,
    enddeg: 360,
    invertdeg: !1,
    invertpath: !1,
    paths: [{ d: "Q", sdeg: 0, sr: 0, deg: 50, r: 100, edeg: 100, er: 0 }],
    animation: !1,
    animationframes: 10,
    normalize: !0
  }), l = Z(e);
  return tt(l, "polar", n, () => {
    const {
      samples: h,
      distance: t,
      length: a,
      top: x,
      left: g,
      type: m,
      startdeg: o,
      enddeg: I,
      invertdeg: C,
      invertpath: A,
      paths: s,
      normalize: d
    } = n, V = W(J(l, e, n), d);
    let R = "";
    const F = I < o ? I + 360 : I, L = C ? (o - F) / h : (F - o) / h, w = C ? 90 + o + 180 : 90 + o, $ = A ? -1 : 1, M = s.length, j = m == "mirror" ? M * 2 : M, u = Math.PI / 180, T = V.length;
    for (let U = 0; U < T; U++) {
      if (U > 0) {
        const p = R.length;
        R.charAt(p - 1) == ";" || p === 0 ? R += " M 0 0 ;" : R += ";";
      }
      let i = -9999, k = -9999;
      for (let p = 0; p < h; p++) {
        const b = q(V[U], p, m), f = m != "bars" ? p % 2 ? 1 : -1 : 1;
        let _ = 1;
        for (let E = 0; E < j; E++) {
          let c = E;
          E >= M && (c = E - M, _ = -1);
          const y = s[c].normalize ? 1 : b;
          if (s[c].minshow <= b && s[c].maxshow >= b)
            switch (s[c].d) {
              case "L": {
                const S = (L * (p + s[c].sdeg / 100) - w) * u, H = (L * (p + s[c].edeg / 100) - w) * u, N = g + (a * (s[c].sr / 100) * y * f * _ * $ + t) * Math.cos(S), v = x + (a * (s[c].sr / 100) * y * f * _ * $ + t) * Math.sin(S), z = g + (a * (s[c].er / 100) * y * f * _ * $ + t) * Math.cos(H), P = x + (a * (s[c].er / 100) * y * f * _ * $ + t) * Math.sin(H);
                (N !== i || v !== k) && (R += `M ${N} ${v} `), R += `L ${z} ${P} `, i = z, k = P;
                break;
              }
              case "C": {
                const S = (L * (p + s[c].sdeg / 100) - w) * u, H = (L * (p + s[c].deg / 100) - w) * u, N = (L * (p + s[c].edeg / 100) - w) * u, v = g + (a * (s[c].sr / 100) * y * f * _ * $ + t) * Math.cos(S), z = x + (a * (s[c].sr / 100) * y * f * _ * $ + t) * Math.sin(S), P = g + (a * (s[c].r / 100) * y * f * _ * $ + t) * Math.cos(H), D = x + (a * (s[c].r / 100) * y * f * _ * $ + t) * Math.sin(H), G = g + (a * (s[c].er / 100) * y * f * _ * $ + t) * Math.cos(N), O = x + (a * (s[c].er / 100) * y * f * _ * $ + t) * Math.sin(N);
                (v !== i || z !== k) && (R += `M ${v} ${z} `), R += `C ${v} ${z} ${P} ${D} ${G} ${O} `, i = G, k = O;
                break;
              }
              case "Q": {
                const S = (L * (p + s[c].sdeg / 100) - w) * u, H = (L * (p + s[c].deg / 100) - w) * u, N = (L * (p + s[c].edeg / 100) - w) * u, v = g + (a * (s[c].sr / 100) * y * f * _ * $ + t) * Math.cos(S), z = x + (a * (s[c].sr / 100) * y * f * _ * $ + t) * Math.sin(S), P = g + (a * (s[c].r / 100) * y * f * _ * $ + t) * Math.cos(H), D = x + (a * (s[c].r / 100) * y * f * _ * $ + t) * Math.sin(H), G = g + (a * (s[c].er / 100) * y * f * _ * $ + t) * Math.cos(N), O = x + (a * (s[c].er / 100) * y * f * _ * $ + t) * Math.sin(N);
                (v !== i || z !== k) && (R += `M ${v} ${z} `), R += `Q ${P} ${D} ${G} ${O} `, i = G, k = O;
                break;
              }
              case "A": {
                const S = (L * (p + s[c].sdeg / 100) - w) * u, H = (L * (p + s[c].edeg / 100) - w) * u, N = g + (a * (s[c].sr / 100) * y * f * _ * $ + t) * Math.cos(S), v = x + (a * (s[c].sr / 100) * y * f * _ * $ + t) * Math.sin(S), z = g + (a * (s[c].er / 100) * y * f * _ * $ + t) * Math.cos(H), P = x + (a * (s[c].er / 100) * y * f * _ * $ + t) * Math.sin(H);
                (N !== i || v !== k) && (R += `M ${N} ${v} `);
                const D = L * p * s[c].angle / 100, G = s[c].rx * L / 100, O = s[c].ry * L / 100;
                let Y = s[c].sweep;
                f == -1 && (Y == 1 ? Y = 0 : Y = 1), _ == -1 && (Y == 1 ? Y = 0 : Y = 1), R += `A ${G} ${O} ${D} ${s[c].arc} ${Y} ${z} ${P} `, i = z, k = P;
                break;
              }
              case "Z":
                R += "Z ";
                break;
            }
        }
      }
    }
    return R;
  });
};
export {
  it as GRANULARITY,
  lt as getAudioData,
  Z as getStatsEntry,
  ht as linearPath,
  et as mixToMono,
  pt as polarPath,
  ot as rangeMinMax
};
