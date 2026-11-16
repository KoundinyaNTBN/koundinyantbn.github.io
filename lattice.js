/*
 * SAFEE background: Nabarro–Herring creep in a small tensile specimen under your cursor
 *
 * The background is a close-packed {111} plane of the nickel-base FCC lattice.
 * Empty sites are vacancies. The lattice is only visible in a soft spotlight around
 * the cursor; the rest of the page stays a plain colour.
 *
 * Under the cursor a small dog-bone tensile specimen is drawn, held at turbine-blade
 * conditions for the single-crystal superalloy CMSX-4: 1100 °C (1373 K) with 120 MPa
 * tension along its axis.
 *
 *  Temperature  In the gauge section, vacancies exchange with neighbouring atoms at an
 *               Arrhenius rate, Γ = Γ0 · exp(−Em / kT).
 *  Stress       Tension raises the vacancy concentration at the faces normal to the
 *               load by exp(σΩ/kT). The loaded ends of the gauge emit vacancies, which
 *               drift to the free sides and are absorbed there. Atoms move the other
 *               way, so the gauge lengthens and narrows: Nabarro–Herring creep.
 *               The creep strain ε is shown under the specimen.
 *
 * Each atom that jumps into a vacancy turns blue and fades back, so the blue atoms
 * mark the vacancy paths. Rates, the number of vacancies, the stress bias and the
 * creep strain are scaled so they can be seen.
 */
(function () {
  'use strict';

  var canvas = document.getElementById('lattice');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- conditions ---------- */
  var T_HOT = 1373;          // K, 1100 °C inside the grain
  var SIGMA = 120;           // MPa, tension along the horizontal
  var T_LABEL = 'T = 1100 °C';
  var S_LABEL = 'σ = 120 MPa';
  var K_B = 1.380649e-23;    // J/K
  var OMEGA = 1.094e-29;     // m³, atomic volume of nickel
  var GAMMA_HOT = 4;         // jumps per second per vacancy inside the hot grain
  var STRESS_GAIN = 8;       // the stress bias σΩ/kT is magnified this many times on screen
  var VAC_FRACTION = 0.03;   // empty sites in the cold background (display value)
  var GRAIN_VACANCIES = 3;   // vacancies kept inside the gauge by the loaded ends
  var CREEP_RATE = 0.04;     // creep strain per second while the cursor rests (display value)
  var MAX_STRAIN = 0.45;
  var TAIL_JUMPS = 3;        // a vacancy's blue trail is about this many atoms long
  var HOP_TIME = 0.18;
  var TWO_PI = Math.PI * 2;
  var SPOT_IN = 5.0, SPOT_OUT = 7.2;  // spotlight radii, in units of G
  var BIAS = STRESS_GAIN * (SIGMA * 1e6 * OMEGA) / (K_B * T_HOT);

  /* ---------- colours ---------- */
  var NBINS = 7, BIN_FILL = [];
  (function () {
    var grey = [134, 134, 139], crimson = [110, 110, 115], ember = [191, 72, 0];
    for (var b = 0; b < NBINS; b++) {
      var f = b / (NBINS - 1), c;
      c = f < 0.65 ? mix(grey, crimson, f / 0.65) : mix(crimson, ember, (f - 0.65) / 0.35);
      BIN_FILL.push('rgba(' + c.join(',') + ',' + (0.3 + 0.3 * f).toFixed(3) + ')');
    }
    function mix(p, q, t) { return [0, 1, 2].map(function (i) { return Math.round(p[i] + (q[i] - p[i]) * t); }); }
  })();
  var NBLUE = 6, BLUE_FILL = [];
  for (var z0 = 0; z0 < NBLUE; z0++) BLUE_FILL.push('rgba(0,113,227,' + (0.3 + 0.55 * (z0 + 1) / NBLUE).toFixed(3) + ')');
  function crimson(al) { return 'rgba(29,29,31,' + al.toFixed(3) + ')'; }

  /* ---------- lattice ---------- */
  var W = 0, H = 0, dpr = 1, a = 26, h = 22.5, M = 2, G = 120;
  var nRows = 0, nCols = 0, rowY = [], rowStag = [];
  var site = [], atoms = [], vac = [];
  var clock = 0, lastFrame = 0, raf = 0;
  var ptr = { x: -1e5, y: -1e5, on: false };
  var grain = { x: -1e5, y: -1e5, strain: 0, placed: false };
  var heat = 0;   // 0..1, rises when the cursor arrives and falls when it leaves

  function baseX(i, j) { return (i - M) * a + rowStag[j]; }
  // Tensile specimen (dog-bone). The gauge section is where diffusion happens; under creep
  // it lengthens and narrows (area conserved), while the grips keep their size.
  function halfW() { return 1.5 * G * (1 + grain.strain); }        // half gauge length
  function halfH() { return 0.3 * G / (1 + grain.strain); }        // half gauge width
  function filletLen() { return 0.55 * G; }
  function gripHalfW() { return 1.0 * G; }
  function gripLen() { return 0.95 * G; }
  function specimenHalfLen(strain) { return 1.5 * G * (1 + strain) + filletLen() + gripLen(); }
  function inGrain(x, y, pad) {
    pad = pad || 0;
    return Math.abs(x - grain.x) < halfW() - pad && Math.abs(y - grain.y) < halfH() - pad;
  }
  function arrowLen() { return 46; }
  function clampX(x) { var m = specimenHalfLen(MAX_STRAIN) + arrowLen() + 26; return Math.max(m, Math.min(W - m, x)); }
  function clampY(y) { var top = 72 + gripHalfW() + 22; return Math.max(top, Math.min(H - gripHalfW() - 30, y)); }
  // 1 well inside the grain, falling to 0 just outside its boundary
  function hotness(x, y) {
    if (heat <= 0.002) return 0;
    var ex = Math.abs(x - grain.x) - halfW(), ey = Math.abs(y - grain.y) - halfH();
    var d = Math.max(ex, ey);            // signed distance to the boundary (negative inside)
    var s = Math.max(0, Math.min(1, 0.5 - d / (1.6 * a)));
    return heat * s;
  }

  function neighbours(i, j) {
    var out = [], x = baseX(i, j), y = rowY[j];
    for (var k = j - 1; k <= j + 1; k++) {
      if (k < 0 || k >= nRows) continue;
      var ik = Math.round((x - rowStag[k]) / a + M);
      for (var q = ik - 1; q <= ik + 1; q++) {
        if (q < 0 || q >= nCols || (q === i && k === j)) continue;
        var dx = baseX(q, k) - x, dy = rowY[k] - y;
        if (dx * dx + dy * dy < 1.45 * a * a) out.push([q, k]);
      }
    }
    return out;
  }

  function build() {
    W = window.innerWidth; H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    a = Math.max(6, Math.min(8, W / 180));             // atomic spacing (px): close-packed
    h = a * Math.sqrt(3) / 2;
    G = Math.max(15, Math.min(19, W * 0.013));          // size unit of the specimen (px)
    nCols = Math.ceil(W / a) + 2 * M + 1;
    nRows = Math.ceil(H / h) + 2 * M + 1;
    rowY = []; rowStag = []; site = []; atoms = []; vac = [];
    for (var j = 0; j < nRows; j++) {
      rowY[j] = (j - M) * h + h / 2;
      rowStag[j] = (j & 1) ? a / 2 : 0;
      site[j] = new Int32Array(nCols);
      for (var i = 0; i < nCols; i++) {
        if (Math.random() < VAC_FRACTION) { site[j][i] = -1; vac.push({ i: i, j: j }); continue; }
        site[j][i] = atoms.length;
        atoms.push({ i: i, j: j, fx: 0, fy: 0, t: 1, moved: 0, fade: 1,
                     p1: Math.random() * TWO_PI, p2: Math.random() * TWO_PI,
                     w1: 6 + Math.random() * 5, w2: 6 + Math.random() * 5 });
      }
    }
  }

  /* ---------- vacancy sources and sinks at the grain faces ---------- */
  function siteNear(x, y) {
    var j = Math.round((y - h / 2) / h + M);
    if (j < 0 || j >= nRows) return null;
    var i = Math.round((x - rowStag[j]) / a + M);
    if (i < 0 || i >= nCols) return null;
    return [i, j];
  }
  // A loaded face emits a vacancy: an atom just inside the left or right face leaves.
  // To keep the overall count steady, a vacancy far from the grain is filled at the same time.
  function emitAt(v) {
    for (var t = 0; t < 12; t++) {
      var side = Math.random() < 0.5 ? -1 : 1;
      var x = grain.x + side * (halfW() - 0.6 * a);
      var y = grain.y + (Math.random() * 1.6 - 0.8) * halfH();
      var s = siteNear(x, y);
      if (!s || !inGrain(baseX(s[0], s[1]), rowY[s[1]], 0.2 * a)) continue;
      var idx = site[s[1]][s[0]];
      if (idx < 0 || atoms[idx].t < 1) continue;
      var at = atoms[idx];          // the atom fills the old vacancy site instead
      at.i = v.i; at.j = v.j; at.t = 1;
      site[v.j][v.i] = idx;
      site[s[1]][s[0]] = -1;
      v.i = s[0]; v.j = s[1];
      return true;
    }
    return false;
  }

  // move a vacancy to a random cold site well away from the spotlight (keeps the total constant)
  function relocateFar(v) {
    var far2 = Math.pow(SPOT_OUT * G + 4 * a, 2);
    for (var t = 0; t < 30; t++) {
      var j = Math.floor(Math.random() * nRows), i = Math.floor(Math.random() * nCols);
      var x = baseX(i, j), y = rowY[j];
      if ((x - grain.x) * (x - grain.x) + (y - grain.y) * (y - grain.y) < far2) continue;
      var idx = site[j][i];
      if (idx < 0 || atoms[idx].t < 1) continue;
      var at = atoms[idx];
      at.i = v.i; at.j = v.j; at.t = 1; at.moved = 0;
      site[v.j][v.i] = idx; site[j][i] = -1;
      v.i = i; v.j = j;
      return;
    }
  }

  function step(dt) {
    // the grain glides after the cursor; it creeps while the cursor rests
    if (ptr.on) {
      if (!grain.placed) { grain.x = clampX(ptr.x); grain.y = clampY(ptr.y); grain.placed = true; }
      var tx = clampX(ptr.x), ty = clampY(ptr.y);
      var gx = tx - grain.x, gy = ty - grain.y, k0 = Math.min(1, dt * 10);
      grain.x += gx * k0; grain.y += gy * k0;
      var speed = Math.sqrt(gx * gx + gy * gy) / Math.max(dt, 1e-3);
      if (speed < 120) grain.strain = Math.min(MAX_STRAIN, grain.strain + CREEP_RATE * heat * dt);
      else grain.strain *= Math.exp(-dt / 0.6);
    } else {
      grain.strain *= Math.exp(-dt / 1.2);
      if (heat < 0.01) grain.placed = false;
    }
    heat += ((ptr.on ? 1 : 0) - heat) * Math.min(1, dt * (ptr.on ? 3 : 1.5));

    if (heat > 0.05) {
      var inside = [], outside = [];
      for (var k = 0; k < vac.length; k++) {
        var vx = baseX(vac[k].i, vac[k].j), vy = rowY[vac[k].j];
        if (inGrain(vx, vy)) { inside.push(vac[k]); continue; }
        // vacancies left just outside the narrowing gauge are absorbed by its free surface
        if (Math.abs(vx - grain.x) < halfW() && Math.abs(vy - grain.y) < halfH() + 1.6 * a) { relocateFar(vac[k]); continue; }
        outside.push(vac[k]);
      }
      // the loaded faces keep the grain supplied with vacancies
      if (inside.length < GRAIN_VACANCIES && outside.length && Math.random() < 6 * dt) {
        var far = outside[Math.floor(Math.random() * outside.length)];
        if (emitAt(far)) inside.push(far);
      }

      var rate = GAMMA_HOT * heat;
      for (k = 0; k < inside.length; k++) {
        var v = inside[k];
        var x = baseX(v.i, v.j), y = rowY[v.j];
        if (Math.random() >= rate * dt) continue;

        // drift in from the loaded faces, out towards the free faces
        var fx = -(x - grain.x) / halfW(), fy = (y - grain.y) / halfH();
        var nb = neighbours(v.i, v.j), cand = [], wsum = 0;
        for (var q = 0; q < nb.length; q++) {
          var idx = site[nb[q][1]][nb[q][0]];
          if (idx < 0 || atoms[idx].t < 1) continue;
          var nx = baseX(nb[q][0], nb[q][1]), ny = rowY[nb[q][1]];
          if (Math.abs(nx - grain.x) >= halfW()) continue;     // no escape through the loaded faces
          var w = Math.exp(BIAS * ((nx - x) * fx + (ny - y) * fy) / a);
          cand.push([nb[q][0], nb[q][1], w]); wsum += w;
        }
        if (!cand.length) continue;
        var r = Math.random() * wsum, c = cand[0];
        for (q = 0; q < cand.length; q++) { r -= cand[q][2]; if (r <= 0) { c = cand[q]; break; } }

        var ai = site[c[1]][c[0]], at = atoms[ai];
        at.fx = baseX(c[0], c[1]); at.fy = rowY[c[1]]; at.t = 0;
        at.i = v.i; at.j = v.j;
        at.moved = 1;
        at.fade = Math.min(4, Math.max(0.6, TAIL_JUMPS / Math.max(rate, 0.5)));
        site[v.j][v.i] = ai; site[c[1]][c[0]] = -1;
        v.i = c[0]; v.j = c[1];

        // reaching a free face, the vacancy is absorbed; a loaded face emits a new one
        if (Math.abs(rowY[v.j] - grain.y) >= halfH() - 0.3 * a) emitAt(v);
      }
    }

    for (var n = 0; n < atoms.length; n++) {
      var A = atoms[n];
      if (A.t < 1) A.t = Math.min(1, A.t + dt / HOP_TIME);
      if (A.moved > 0) A.moved = Math.max(0, A.moved - dt / A.fade);
    }
  }

  /* ---------- drawing ---------- */
  var bx = [], by = [], ux = [], uy = [];
  for (var z = 0; z < NBINS; z++) { bx.push([]); by.push([]); }
  for (z = 0; z < NBLUE; z++) { ux.push([]); uy.push([]); }

  function dots(xs, ys, r, fill) {
    if (!xs.length) return;
    ctx.fillStyle = fill;
    ctx.beginPath();
    for (var q = 0; q < xs.length; q++) { ctx.moveTo(xs[q] + r, ys[q]); ctx.arc(xs[q], ys[q], r, 0, TWO_PI); }
    ctx.fill();
  }
  function roundRect(x, y, w, hh, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function arrowHead(x, y, ang, size) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - size * Math.cos(ang - 0.45), y - size * Math.sin(ang - 0.45));
    ctx.lineTo(x - size * Math.cos(ang + 0.45), y - size * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
  }

  function specimenPath() {
    var L = halfW(), Wd = halfH(), RF = filletLen(), WG = gripHalfW(), LG = gripLen();
    var cx = grain.x, cy = grain.y, E = L + RF + LG, r = Math.min(6, WG * 0.2);
    ctx.beginPath();
    ctx.moveTo(cx - E + r, cy - WG);
    ctx.lineTo(cx - L - RF, cy - WG);
    ctx.bezierCurveTo(cx - L - RF * 0.45, cy - WG, cx - L - RF * 0.55, cy - Wd, cx - L, cy - Wd);   // shoulder
    ctx.lineTo(cx + L, cy - Wd);                                                                  // gauge
    ctx.bezierCurveTo(cx + L + RF * 0.55, cy - Wd, cx + L + RF * 0.45, cy - WG, cx + L + RF, cy - WG);
    ctx.lineTo(cx + E - r, cy - WG);
    ctx.quadraticCurveTo(cx + E, cy - WG, cx + E, cy - WG + r);
    ctx.lineTo(cx + E, cy + WG - r);
    ctx.quadraticCurveTo(cx + E, cy + WG, cx + E - r, cy + WG);
    ctx.lineTo(cx + L + RF, cy + WG);
    ctx.bezierCurveTo(cx + L + RF * 0.45, cy + WG, cx + L + RF * 0.55, cy + Wd, cx + L, cy + Wd);
    ctx.lineTo(cx - L, cy + Wd);
    ctx.bezierCurveTo(cx - L - RF * 0.55, cy + Wd, cx - L - RF * 0.45, cy + WG, cx - L - RF, cy + WG);
    ctx.lineTo(cx - E + r, cy + WG);
    ctx.quadraticCurveTo(cx - E, cy + WG, cx - E, cy + WG - r);
    ctx.lineTo(cx - E, cy - WG + r);
    ctx.quadraticCurveTo(cx - E, cy - WG, cx - E + r, cy - WG);
    ctx.closePath();
  }

  // under the atoms: a faint warm fill for the temperature
  function drawSpecimenFill() {
    if (heat < 0.03) return;
    specimenPath();
    ctx.fillStyle = 'rgba(191,72,0,' + (0.04 * heat).toFixed(3) + ')';
    ctx.fill();
  }

  // over the atoms: outline, vacancy flux, load arrows and labels
  function drawSpecimenOverlay() {
    if (heat < 0.03) return;
    var L = halfW(), Wd = halfH(), E = specimenHalfLen(grain.strain), WG = gripHalfW(), al = heat;
    var cx = grain.x, cy = grain.y;

    specimenPath();
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = crimson(0.24 * al);
    ctx.stroke();

    // gauge marks at the ends of the gauge section
    ctx.lineWidth = 1;
    ctx.strokeStyle = crimson(0.3 * al);
    ctx.beginPath();
    ctx.moveTo(cx - L, cy - Wd - 3); ctx.lineTo(cx - L, cy - Wd + 2);
    ctx.moveTo(cx + L, cy - Wd - 3); ctx.lineTo(cx + L, cy - Wd + 2);
    ctx.stroke();

    // vacancy flux in the gauge: from the loaded ends to the free sides
    if (Wd >= 8) {
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = ctx.fillStyle = crimson(0.2 * al);
    for (var sx = -1; sx <= 1; sx += 2) {
      for (var sy = -1; sy <= 1; sy += 2) {
        var ax = cx + sx * L * 0.8, ay = cy + sy * Wd * 0.15;
        var bx2 = cx + sx * L * 0.3, by2 = cy + sy * Wd * 0.78;
        var qx = cx + sx * L * 0.72, qy = cy + sy * Wd * 0.75;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(qx, qy, bx2, by2); ctx.stroke();
        ctx.setLineDash([]);
        arrowHead(bx2, by2, Math.atan2(by2 - qy, bx2 - qx), 4);
        ctx.setLineDash([3, 4]);
      }
    }
    ctx.setLineDash([]);
    }

    // applied load: one arrow on each grip
    var len = arrowLen();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ctx.fillStyle = crimson(0.32 * al);
    for (var s = -1; s <= 1; s += 2) {
      var xs = cx + s * (E + 4), xe = xs + s * len;
      ctx.beginPath(); ctx.moveTo(xs, cy); ctx.lineTo(xe - s * 5, cy); ctx.stroke();
      arrowHead(xe, cy, s > 0 ? 0 : Math.PI, 6);
    }

    // labels
    ctx.font = '600 10px "SN Pro", -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    ctx.fillStyle = crimson(0.4 * al);
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'center';
    ctx.fillText(T_LABEL, cx, cy - WG - 5);
    ctx.textAlign = 'left';
    ctx.fillText(S_LABEL, cx + E + 6, cy - 5);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('ε = ' + Math.round(grain.strain * 100) + '%', cx, cy + WG + 5);
  }

  var lastBox = null;   // only the region around the specimen is redrawn each frame
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (lastBox) ctx.clearRect(lastBox[0], lastBox[1], lastBox[2], lastBox[3]);
    else ctx.clearRect(0, 0, W, H);
    lastBox = null;
    if (heat < 0.01 || !grain.placed) return;   // no cursor: plain background
    var reach = Math.max(SPOT_OUT * G, specimenHalfLen(grain.strain) + arrowLen() + 70) + 2 * a;
    lastBox = [Math.floor(grain.x - reach), Math.floor(grain.y - reach), Math.ceil(2 * reach), Math.ceil(2 * reach)];
    ctx.clearRect(lastBox[0], lastBox[1], lastBox[2], lastBox[3]);
    for (var z = 0; z < NBINS; z++) { bx[z].length = 0; by[z].length = 0; }
    for (z = 0; z < NBLUE; z++) { ux[z].length = 0; uy[z].length = 0; }

    drawSpecimenFill();

    var sx0 = grain.x, sy0 = grain.y, sr2 = Math.pow(SPOT_OUT * G + a, 2);
    for (var n = 0; n < atoms.length; n++) {
      var at = atoms[n];
      var x = baseX(at.i, at.j), y = rowY[at.j];
      if ((x - sx0) * (x - sx0) + (y - sy0) * (y - sy0) > sr2) continue;   // outside the spotlight
      if (at.t < 1) { var e = at.t * at.t * (3 - 2 * at.t); x = at.fx + (x - at.fx) * e; y = at.fy + (y - at.fy) * e; }
      var f = hotness(x, y);
      if (f > 0.02 && !reduceMotion) {           // thermal vibration in the hot grain
        var amp = a * 0.07 * f;
        x += amp * Math.sin(clock * at.w1 + at.p1);
        y += amp * Math.sin(clock * at.w2 + at.p2);
      }
      if (at.moved > 0.04) {
        var ub = Math.min(NBLUE - 1, Math.floor(at.moved * NBLUE));
        ux[ub].push(x); uy[ub].push(y);
      } else {
        var b = Math.round(f * (NBINS - 1));
        bx[b].push(x); by[b].push(y);
      }
    }
    var r0 = a * 0.26, r1 = a * 0.32;
    for (z = 0; z < NBINS; z++) dots(bx[z], by[z], r0, BIN_FILL[z]);
    for (z = 0; z < NBLUE; z++) dots(ux[z], uy[z], r1, BLUE_FILL[z]);

    // vacancies: faint in the cold crystal, stronger inside the grain
    var hot = [];
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = crimson(0.4);
    ctx.beginPath();
    for (var v = 0; v < vac.length; v++) {
      var vx = baseX(vac[v].i, vac[v].j), vy = rowY[vac[v].j];
      if ((vx - sx0) * (vx - sx0) + (vy - sy0) * (vy - sy0) > sr2) continue;
      if (hotness(vx, vy) > 0.3) { hot.push(vx, vy); continue; }
      ctx.moveTo(vx + a * 0.28, vy); ctx.arc(vx, vy, a * 0.28, 0, TWO_PI);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = crimson(0.75);
    ctx.beginPath();
    for (v = 0; v < hot.length; v += 2) { ctx.moveTo(hot[v] + a * 0.32, hot[v + 1]); ctx.arc(hot[v], hot[v + 1], a * 0.32, 0, TWO_PI); }
    ctx.stroke();

    // spotlight: keep only a soft circle around the grain, the rest stays plain
    var cx = grain.x, cy = grain.y, rIn = SPOT_IN * G, rOut = SPOT_OUT * G;
    var mask = ctx.createRadialGradient(cx, cy, rIn, cx, cy, rOut);
    mask.addColorStop(0, 'rgba(0,0,0,' + heat.toFixed(3) + ')');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = mask;
    ctx.fillRect(lastBox[0], lastBox[1], lastBox[2], lastBox[3]);
    ctx.globalCompositeOperation = 'source-over';

    drawSpecimenOverlay();
  }

  /* ---------- pointer ---------- */
  function onMove(x, y) { ptr.x = x; ptr.y = y; ptr.on = true; if (asleep) schedule(); }
  window.addEventListener('pointermove', function (e) { onMove(e.clientX, e.clientY); }, { passive: true });
  window.addEventListener('pointerdown', function (e) { onMove(e.clientX, e.clientY); }, { passive: true });
  window.addEventListener('touchmove', function (e) { if (e.touches[0]) onMove(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  window.addEventListener('touchend', function () { ptr.on = false; });
  document.documentElement.addEventListener('mouseleave', function () { ptr.on = false; });
  window.addEventListener('blur', function () { ptr.on = false; });

  /* ---------- loop ---------- */
  function frame(now) {
    raf = 0;
    var dt = Math.min(0.05, (now - (lastFrame || now)) / 1000);
    lastFrame = now; clock += dt;
    step(dt);
    draw();
    // sleep when the cursor has gone and everything has faded; the next move wakes it
    if (!ptr.on && heat < 0.005) { asleep = true; lastFrame = 0; return; }
    schedule();
  }
  var asleep = false;
  function schedule() { if (!raf && !document.hidden && !reduceMotion) { asleep = false; raf = requestAnimationFrame(frame); } }
  document.addEventListener('visibilitychange', function () { lastFrame = 0; schedule(); });

  var lastW = window.innerWidth, lastH = window.innerHeight, rt = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      if (window.innerWidth === lastW && Math.abs(window.innerHeight - lastH) < 140) return; // mobile toolbars
      lastW = window.innerWidth; lastH = window.innerHeight;
      lastBox = null; build(); draw();
    }, 180);
  });

  build();
  if (reduceMotion) draw(); else schedule();

  window.safeeLattice = {
    state: function () {
      var inside = 0;
      for (var k = 0; k < vac.length; k++) if (inGrain(baseX(vac[k].i, vac[k].j), rowY[vac[k].j])) inside++;
      return { vacancies: vac.length, inGrain: inside, heat: +heat.toFixed(2), strain: +grain.strain.toFixed(3) };
    }
  };
})();
