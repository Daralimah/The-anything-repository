// Mud Run: a minigame for TheClaudeSpa™. Claude rolls through mud puddles to get
// filthy while dodging the spa staff's hands, which try to drag it back to the bath.
// The spa calls MudRun.start({ dirt, lengths, clean, dirty, onExit }) and gets the
// tentacles' new dirt levels back through onExit when the run ends.
window.MudRun = (() => {
  const TAU = Math.PI * 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = list => list[Math.floor(Math.random() * list.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const angDiff = (a, b) => ((a - b) % TAU + TAU + Math.PI) % TAU - Math.PI;
  const avg = list => list.reduce((s, v) => s + v, 0) / list.length;
  const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  const GLOVES = {             // [fill, outline] for each kind of hand
    grabby: ['#ffd84a', '#c99a00'],
    lunger: ['#ff8fc0', '#d0568e'],
    soaper: ['#8fd4ff', '#3d98d0'],
    sweeper: ['#b9f28c', '#6bb33a'],
  };
  const STAFF_LINES = ['BATH TIME!', 'Come here, you!', 'You missed a spot!', "Spa day isn't over!", 'Back in the tub!'];
  const EW_LINES = ['EW!', 'GROSS!', 'YUCK!', 'BLEH!'];
  const MILESTONES = [[0.25, 'Grubby!'], [0.5, 'FILTHY!'], [0.75, 'DISGUSTING!'], [0.999, 'MAXIMUM MUD!!']];
  const SPLAT_CD = 2.5;        // seconds between SPLATs
  const SOAP_AIM = 0.55;       // seconds a soaper shows its aim line before throwing
  const SOAP_GAP = 0.7;        // minimum seconds between any two soap throws
  const BEST_KEY = 'claudespa-mudrun-best';

  // Fixed mud-spot layout per tentacle: position along it, sideways nudge, size.
  const SPOTS = Array.from({ length: 12 }, () =>
    [0.4, 0.62, 0.85].map(f => ({ f: f + rand(-0.06, 0.06), off: rand(-1.2, 1.2), r: rand(1.6, 2.8) })));

  const $ = id => document.getElementById(id);
  const root = $('mudrun'), cv = $('mud-canvas'), ctx = cv.getContext('2d');
  const ui = {
    hud: $('mud-hud'), pct: $('mud-pct'), fill: $('mud-fill'), time: $('mud-time'), score: $('mud-score'),
    splat: $('splat'), intro: $('mud-intro'), over: $('mud-over'), result: $('mud-result'),
  };
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');

  let W = 0, H = 0, S = 1, dpr = 1, top = 0, pal, ground, opts = null, g = null, raf = 0, lastT = 0;
  const keys = new Set();
  const pointer = { down: false, x: 0, y: 0 };
  const api = { active: false, start };

  const claudeR = () => 34 * S;
  const rayAngle = (c, i) => c.rot + i * TAU / 12 - Math.PI / 2;
  const colorAt = d => `rgb(${opts.clean.map((c, k) => Math.round(c + (opts.dirty[k] - c) * d))})`;
  const scoreOf = () => Math.round(g.gained * 100 + g.t * 10 + g.splatted * 75);

  function palette() {
    return darkQuery.matches
      ? { ground: '#2f3a22', grass: '#3f4f2c', speck: '#252d1a', mud: '#4a3322', mudEdge: '#35251a',
          deep: '#2e1f14', sleeve: '#d9dde6', sleeveEdge: '#9aa0ad' }
      : { ground: '#8fbf5a', grass: '#a6d36e', speck: '#76a646', mud: '#6e4a2f', mudEdge: '#553823',
          deep: '#48301d', sleeve: '#ffffff', sleeveEdge: '#c9ccd6' };
  }

  // ---------- setup ----------

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    S = clamp(Math.min(W, H) / 700, 0.6, 1.3);
    cv.width = Math.ceil(W * dpr); cv.height = Math.ceil(H * dpr);
    top = ui.hud.getBoundingClientRect().bottom + 4;
    buildGround();
  }

  function buildGround() {
    ground = document.createElement('canvas');
    ground.width = cv.width; ground.height = cv.height;
    const c = ground.getContext('2d');
    c.scale(dpr, dpr);
    c.fillStyle = pal.ground; c.fillRect(0, 0, W, H);
    c.lineCap = 'round';
    for (let i = 0; i < W * H / 1400; i++) {
      const x = Math.random() * W, y = Math.random() * H;
      if (Math.random() < 0.7) {
        c.strokeStyle = pal.grass; c.lineWidth = 1.5;
        c.beginPath();
        for (let b = -1; b <= 1; b++) { c.moveTo(x + b * 2, y); c.lineTo(x + b * 3.5, y - rand(4, 8)); }
        c.stroke();
      } else {
        c.fillStyle = pal.speck;
        c.beginPath(); c.arc(x, y, rand(1, 2.5), 0, TAU); c.fill();
      }
    }
  }

  function newGame(dirt) {
    g = {
      state: 'play', t: 0, clock: 0, caught: null,
      claude: { x: W / 2, y: (top + H) / 2, vx: 0, vy: 0, rot: 0, spin: 0, dash: 0, iframes: 0 },
      dirt: dirt.slice(), gained: 0, splatted: 0,
      milestone: 0, puddles: [], hands: [], soaps: [], blobs: [], decals: [], parts: [], texts: [],
      ducks: [], sweeps: [], nextHand: 2, nextSweep: 35, nextDuck: 15, splatCd: 0, soapCd: 0, shake: 0, trailT: 0,
    };
    while (g.milestone < MILESTONES.length && avg(dirt) >= MILESTONES[g.milestone][0]) g.milestone++;
    for (let i = 0; i < 5; i++) g.puddles.push(makePuddle());
  }

  function makePuddle() {
    const r = rand(45, 85) * S, c = g.claude;
    let x, y, tries = 0;
    do {
      x = rand(r, W - r); y = rand(top + r * 0.75, H - r * 0.75);
    } while (Math.hypot(x - c.x, y - c.y) < r + 90 * S && ++tries < 20);
    return {
      x, y, r, amount: 1, age: 0, deep: Math.random() < 0.2,
      pts: Array.from({ length: 14 }, () => rand(0.82, 1.1)),
      bub: Array.from({ length: 3 }, () => ({ x: rand(-0.4, 0.4), y: rand(-0.4, 0.4), o: Math.random() })),
    };
  }

  const puddleR = p => p.r * (0.35 + 0.65 * clamp(p.amount, 0, 1));
  function puddleAt(x, y) {
    return g.puddles.find(p => {
      const rr = puddleR(p) * 0.9;
      return ((x - p.x) / rr) ** 2 + ((y - p.y) / (rr * 0.75)) ** 2 < 1;
    });
  }

  // ---------- spawning ----------

  function spawnHand(type) {
    const m = 60 * S, c = g.claude;
    let a, tries = 0;
    do {
      a = pick([
        { x: rand(0, W), y: -m }, { x: W + m, y: rand(top, H) },
        { x: rand(0, W), y: H + m }, { x: -m, y: rand(top, H) },
      ]);
    } while (Math.hypot(a.x - c.x, a.y - c.y) < 220 * S && ++tries < 10);
    g.hands.push({
      type, ax: a.x, ay: a.y, x: a.x, y: a.y, dir: Math.atan2(c.y - a.y, c.x - a.x),
      state: 'reach', t: 0, st: 0, life: rand(7, 10), grip: 0, wob: rand(0, TAU), muddy: false,
    });
    if (Math.random() < 0.35) addText(pick(STAFF_LINES), a.x, a.y, '#ffffff', 18);
  }

  function spawnSweep() {
    const c = g.claude, horiz = Math.random() < 0.5;
    g.sweeps.push({ horiz, lane: horiz ? c.y : c.x, w: 150 * S, fromStart: Math.random() < 0.5, t: 0, warn: 1.3, along: null });
    g.shake = Math.max(g.shake, 3);
  }

  function spawnDuck() {
    const left = Math.random() < 0.5;
    g.ducks.push({ x: left ? -40 * S : W + 40 * S, y: rand(top + 30 * S, H - 40 * S), vx: (left ? 1 : -1) * rand(70, 120) * S, t: 0, cool: 0 });
  }

  function spawnStuff(dt) {
    const t = g.t;
    g.nextHand -= dt;
    const active = g.hands.filter(h => h.state !== 'retract' && h.state !== 'ew').length;
    if (g.nextHand <= 0 && active < Math.min(9, 2 + Math.floor(t / 12))) {
      const types = ['grabby', 'grabby'];
      // Soapers are capped so their throws stay dodgeable: one at a time, two after 45s.
      const soapers = g.hands.filter(h => h.type === 'soaper' && h.state !== 'retract' && h.state !== 'ew').length;
      if (t > 10 && soapers < (t > 45 ? 2 : 1)) types.push('soaper');
      if (t > 20) types.push('lunger', 'lunger');
      spawnHand(pick(types));
      g.nextHand = Math.max(0.7, 3 - t * 0.035) * rand(0.7, 1.3);
    }
    if ((g.nextSweep -= dt) <= 0) { spawnSweep(); g.nextSweep = rand(14, 22); }
    if ((g.nextDuck -= dt) <= 0) { spawnDuck(); g.nextDuck = rand(10, 18); }
  }

  // ---------- effects ----------

  function addText(text, x, y, color = '#fff', size = 22, life = 1.1) {
    g.texts.push({ text, x: clamp(x, 70, W - 70), y: clamp(y, top + 24, H - 16), color, size, life, max: life });
  }

  function addDecal(x, y, r, a) {
    g.decals.push({ x, y, r, a });
    if (g.decals.length > 140) g.decals.shift();
  }

  function burst(x, y, n, kind) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), sp = rand(60, 220) * S;
      g.parts.push({
        kind, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (kind === 'bubble' ? 40 * S : 0),
        r: (kind === 'bubble' ? rand(3, 7) : rand(2, 4)) * S, life: kind === 'bubble' ? rand(0.6, 1) : rand(0.3, 0.6),
      });
    }
  }

  // ---------- player ----------

  function inputDir() {
    let x = 0, y = 0;
    if (keys.has('ArrowLeft') || keys.has('a')) x -= 1;
    if (keys.has('ArrowRight') || keys.has('d')) x += 1;
    if (keys.has('ArrowUp') || keys.has('w')) y -= 1;
    if (keys.has('ArrowDown') || keys.has('s')) y += 1;
    if (x || y) { const m = Math.hypot(x, y); return { x: x / m, y: y / m, k: 1 }; }
    if (pointer.down) {
      const c = g.claude, dx = pointer.x - c.x, dy = pointer.y - c.y, d = Math.hypot(dx, dy);
      if (d > 6) return { x: dx / d, y: dy / d, k: Math.min(1, d / (70 * S)) };
    }
    return null;
  }

  function updateClaude(dt) {
    const c = g.claude, R = claudeR(), inp = inputDir(), mud = puddleAt(c.x, c.y);
    if (inp) { c.vx += inp.x * inp.k * 1500 * S * dt; c.vy += inp.y * inp.k * 1500 * S * dt; }
    const keep = Math.pow(mud ? 0.03 : 0.12, dt);   // mud is sticky
    c.vx *= keep; c.vy *= keep;
    let sp = Math.hypot(c.vx, c.vy);
    const maxV = (mud ? 240 : 350) * S * (c.dash > 0 ? 3 : 1);
    if (sp > maxV) { c.vx *= maxV / sp; c.vy *= maxV / sp; sp = maxV; }
    c.x += c.vx * dt; c.y += c.vy * dt;
    if (c.x < R) { c.x = R; c.vx = Math.abs(c.vx) * 0.6; }
    if (c.x > W - R) { c.x = W - R; c.vx = -Math.abs(c.vx) * 0.6; }
    if (c.y < top + R) { c.y = top + R; c.vy = Math.abs(c.vy) * 0.6; }
    if (c.y > H - R) { c.y = H - R; c.vy = -Math.abs(c.vy) * 0.6; }
    c.rot += (c.vx >= 0 ? 1 : -1) * sp * dt / (R * 0.7) + c.spin * dt;
    c.spin *= Math.pow(0.03, dt);
    c.dash -= dt; c.iframes -= dt;

    // Rolling through a puddle muddies the tentacles on the leading edge. Rolling
    // turns Claude, so every tentacle gets its turn in the mud.
    if (mud && sp > 25 * S) {
      const heading = Math.atan2(c.vy, c.vx);
      const w = g.dirt.map((_, i) => Math.max(0, Math.cos(angDiff(rayAngle(c, i), heading))) ** 2);
      const sum = w.reduce((a, b) => a + b, 0) || 1;
      const budget = (mud.deep ? 2 : 1) * Math.min(1, sp / (300 * S)) * dt;
      let taken = 0;
      g.dirt.forEach((d, i) => { const add = Math.min(1 - d, budget * w[i] / sum); g.dirt[i] += add; taken += add; });
      mud.amount -= taken * 0.3;
      g.gained += taken;
      if (Math.random() < 0.6) {
        const a = rayAngle(c, Math.floor(Math.random() * 12)), v = rand(80, 200) * S;
        g.parts.push({ kind: 'drop', x: c.x + Math.cos(a) * R, y: c.y + Math.sin(a) * R, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: rand(2, 4) * S, life: rand(0.3, 0.5) });
      }
    }

    // Leave a muddy trail once there's mud to leave.
    const m = avg(g.dirt);
    if ((g.trailT -= dt) <= 0 && m > 0.15 && sp > 60 * S && !mud) {
      addDecal(c.x + rand(-8, 8) * S, c.y + rand(-8, 8) * S, rand(3, 6) * S, m * 0.35);
      g.trailT = 0.07;
    }

    while (g.milestone < MILESTONES.length && m >= MILESTONES[g.milestone][0]) {
      addText(MILESTONES[g.milestone][1], c.x, c.y - 50 * S, '#ffd9a8', 30, 1.4);
      g.shake = Math.max(g.shake, 5);
      g.milestone++;
    }
  }

  function splat() {
    if (!g || g.state !== 'play' || g.splatCd > 0) return;
    const c = g.claude, inp = inputDir(), sp = Math.hypot(c.vx, c.vy);
    const dir = inp ? Math.atan2(inp.y, inp.x) : sp > 10 ? Math.atan2(c.vy, c.vx) : rand(0, TAU);
    c.vx += Math.cos(dir) * 700 * S; c.vy += Math.sin(dir) * 700 * S;
    c.dash = 0.3; c.iframes = 0.35; c.spin = 30 * (Math.cos(dir) >= 0 ? 1 : -1);
    g.splatCd = SPLAT_CD;
    if (avg(g.dirt) < 0.04) { addText('No mud to fling!', c.x, c.y - 40 * S, '#fff', 18); return; }
    // Fling a blob of mud off the end of every muddy tentacle.
    g.dirt.forEach((d, i) => {
      if (d < 0.03) return;
      const a = rayAngle(c, i), R = claudeR();
      g.blobs.push({ x: c.x + Math.cos(a) * R, y: c.y + Math.sin(a) * R, vx: Math.cos(a) * 520 * S + c.vx * 0.2, vy: Math.sin(a) * 520 * S + c.vy * 0.2, r: (5 + 5 * d) * S, life: 0.55 });
      g.dirt[i] = Math.max(0, d - 0.07);
    });
    addText('SPLAT!', c.x, c.y - 44 * S, '#ffd9a8', 26, 0.8);
    g.shake = Math.max(g.shake, 6);
  }

  // ---------- hazards ----------

  function nab(src) {
    if (g.state !== 'play') return;
    g.state = 'caught';
    g.caught = { ...src, t: 0 };
    if (src.hand) src.hand.state = 'grab';
    for (const h of g.hands) if (h !== src.hand && h.state !== 'ew') h.state = 'retract';
    g.shake = 10;
    addText(src.sweep ? 'SCRUBBED AWAY!' : 'NABBED!', g.claude.x, g.claude.y - 50 * S, '#ffffff', 34, 1.6);
  }

  function steer(h, target, rate, dt) { h.dir += clamp(angDiff(target, h.dir), -rate * dt, rate * dt); }
  function move(h, sp, dt) { h.x += Math.cos(h.dir) * sp * dt; h.y += Math.sin(h.dir) * sp * dt; }

  function throwSoap(h) {
    const a = h.aim, v = 330 * S * Math.min(1.3, 1 + g.t / 80);
    g.soaps.push({ x: h.x + Math.cos(a) * 20 * S, y: h.y + Math.sin(a) * 20 * S, vx: Math.cos(a) * v, vy: Math.sin(a) * v, rot: rand(0, TAU), spin: rand(-8, 8) });
  }

  function updateHands(dt) {
    const c = g.claude, diff = 1 + g.t / 80, playing = g.state === 'play';
    for (const h of g.hands) {
      h.t += dt;
      h.grip += ((h.state === 'grab' ? 1 : 0) - h.grip) * Math.min(1, dt * 10);
      if (h.state === 'grab') continue;              // carried off in updateCaught
      if (!playing && h.state !== 'ew') h.state = 'retract';
      if (h.t > h.life && (h.state === 'reach' || h.state === 'throw')) h.state = 'retract';
      if (h.state === 'retract' || h.state === 'ew') {
        const back = Math.atan2(h.ay - h.y, h.ax - h.x), sp = (h.state === 'ew' ? 750 : 380) * S;
        h.x += Math.cos(back) * sp * dt; h.y += Math.sin(back) * sp * dt;
        if (Math.hypot(h.ax - h.x, h.ay - h.y) < sp * dt + 2) h.dead = true;
        continue;
      }
      const toC = Math.atan2(c.y - h.y, c.x - h.x), d = Math.hypot(c.x - h.x, c.y - h.y);
      if (h.type === 'grabby') {
        // Steady chaser with a limited turning rate, so sharp turns shake it off.
        steer(h, toC, 2.4, dt);
        move(h, Math.min(330, 150 * diff) * S, dt);
      } else if (h.type === 'lunger') {
        // Creeps closer, winds up (the telegraph), then lunges where Claude is heading.
        if (h.state === 'reach') {
          steer(h, toC, 4, dt); move(h, 170 * S, dt);
          if (d < 210 * S) { h.state = 'windup'; h.st = 0; }
        } else if (h.state === 'windup') {
          h.st += dt;
          h.dir = Math.atan2(c.y + c.vy * 0.3 - h.y, c.x + c.vx * 0.3 - h.x);
          if (h.st > Math.max(0.4, 0.8 - g.t / 200)) { h.state = 'lunge'; h.st = 0; g.shake = Math.max(g.shake, 4); }
        } else if (h.state === 'lunge') {
          h.st += dt; move(h, 950 * S, dt);
          if (h.st > 0.4) h.state = 'retract';
        }
      } else if (h.type === 'soaper') {
        // Peeks in from the edge and lobs soap bars. Before each throw it locks its aim
        // on where Claude is and shows an aim line, so a sidestep dodges the bar.
        if (h.state === 'reach') {
          h.dir = toC;
          move(h, 160 * S, dt);
          if (Math.hypot(h.x - h.ax, h.y - h.ay) > 110 * S) { h.state = 'throw'; h.st = 1; h.aim = null; }
        } else {
          h.st -= dt;
          if (h.aim === null) {
            h.dir = toC;
            if (h.st <= SOAP_AIM) h.aim = toC;
          } else {
            h.dir = h.aim;
            if (h.st <= 0 && g.soapCd <= 0) {
              throwSoap(h);
              g.soapCd = SOAP_GAP;
              h.aim = null;
              h.st = Math.max(1.5, 2.4 / diff);
            }
          }
        }
      }
      if (playing && c.iframes <= 0 && d < claudeR() * 0.7 + 15 * S) nab({ hand: h });
    }
    g.hands = g.hands.filter(h => !h.dead);
  }

  function updateSweeps(dt) {
    const c = g.claude;
    for (const sw of g.sweeps) {
      sw.t += dt;
      if (sw.t < sw.warn) continue;
      const len = sw.horiz ? W : H, pad = 260 * S, run = (sw.t - sw.warn) * (len + 2 * pad) / 0.9;
      sw.along = sw.fromStart ? -pad + run : len + pad - run;
      if (run > len + 2 * pad) sw.done = true;
      if (g.state === 'play' && c.iframes <= 0) {
        const perp = Math.abs((sw.horiz ? c.y : c.x) - sw.lane), al = sw.horiz ? c.x : c.y;
        if (perp < sw.w / 2 && Math.abs(al - sw.along) < 70 * S) nab({ sweep: sw });
      }
      if (g.caught && g.caught.sweep === sw) {
        const front = sw.along + (sw.fromStart ? 1 : -1) * 60 * S;
        if (sw.horiz) { c.x = front; c.y = sw.lane; } else { c.x = sw.lane; c.y = front; }
      }
      if (Math.random() < dt * 30) {
        const x = sw.horiz ? sw.along : sw.lane + rand(-0.4, 0.4) * sw.w, y = sw.horiz ? sw.lane + rand(-0.4, 0.4) * sw.w : sw.along;
        burst(x, y, 1, 'bubble');
      }
    }
    g.sweeps = g.sweeps.filter(s => !s.done || (g.caught && g.caught.sweep === s));
  }

  function updateCaught(dt) {
    const k = g.caught, c = g.claude;
    k.t += dt; c.rot += dt * 3;
    if (k.hand) {
      const h = k.hand;
      if (k.t > 0.35) {
        const back = Math.atan2(h.ay - h.y, h.ax - h.x);
        h.x += Math.cos(back) * 420 * S * dt; h.y += Math.sin(back) * 420 * S * dt;
      }
      c.x = h.x + Math.cos(h.dir) * 20 * S; c.y = h.y + Math.sin(h.dir) * 20 * S;
      if ((k.t > 0.35 && Math.hypot(h.ax - h.x, h.ay - h.y) < 10) || k.t > 3) endGame();
    } else if (k.sweep.done || k.t > 2.5) {
      endGame();
    }
  }

  function updateSoaps(dt) {
    const c = g.claude;
    for (const s of g.soaps) {
      s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.spin * dt;
      if (Math.random() < dt * 8) burst(s.x, s.y, 1, 'bubble');
      if (s.x < -80 || s.x > W + 80 || s.y < -80 || s.y > H + 80) s.dead = true;
      if (g.state === 'play' && !s.dead && Math.hypot(c.x - s.x, c.y - s.y) < claudeR() * 0.75 + 12 * S) {
        // Soap washes off the mud on the side it hits.
        s.dead = true;
        const from = Math.atan2(s.y - c.y, s.x - c.x);
        let washed = 0;
        g.dirt.forEach((d, i) => {
          const cut = Math.min(d, 0.35 * Math.max(0, Math.cos(angDiff(rayAngle(c, i), from))) + 0.05);
          g.dirt[i] -= cut; washed += cut;
        });
        burst(s.x, s.y, 14, 'bubble');
        addText(washed > 1 ? 'SQUEAKY CLEAN?!' : 'SQUEAK!', c.x, c.y - 44 * S, '#bfe9ff', 22);
        c.vx += s.vx * 0.3; c.vy += s.vy * 0.3;
        g.milestone = 0;
        while (g.milestone < MILESTONES.length && avg(g.dirt) >= MILESTONES[g.milestone][0]) g.milestone++;
      }
    }
    g.soaps = g.soaps.filter(s => !s.dead);
  }

  function updateBlobs(dt) {
    for (const b of g.blobs) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.vx *= Math.pow(0.2, dt); b.vy *= Math.pow(0.2, dt);
      b.life -= dt;
      for (const h of g.hands) {
        if (h.state === 'ew' || h.state === 'retract' || h.state === 'grab') continue;
        if (Math.hypot(h.x - b.x, h.y - b.y) < 22 * S + b.r) {
          h.state = 'ew'; h.muddy = true; g.splatted++; b.life = 0;
          addText(pick(EW_LINES), h.x, h.y - 24 * S, '#ffd9a8', 24);
          burst(h.x, h.y, 8, 'drop');
          break;
        }
      }
      for (const s of g.soaps) {
        if (!s.dead && Math.hypot(s.x - b.x, s.y - b.y) < 16 * S + b.r) { s.dead = true; b.life = 0; burst(s.x, s.y, 6, 'bubble'); }
      }
      if (b.life <= 0) addDecal(b.x, b.y, b.r * rand(1.1, 1.6), 0.55);
    }
    g.blobs = g.blobs.filter(b => b.life > 0);
  }

  function updateDucks(dt) {
    const c = g.claude, R = claudeR();
    for (const d of g.ducks) {
      d.x += d.vx * dt; d.t += dt; d.cool -= dt;
      if ((d.vx > 0 && d.x > W + 60 * S) || (d.vx < 0 && d.x < -60 * S)) d.dead = true;
      if (g.state !== 'play') continue;
      const dx = c.x - d.x, dy = c.y - d.y, dist = Math.hypot(dx, dy), min = R * 0.6 + 20 * S;
      if (dist < min && dist > 0) {
        // Rubber ducks are bouncy.
        const nx = dx / dist, ny = dy / dist, dot = c.vx * nx + c.vy * ny;
        c.x = d.x + nx * min; c.y = d.y + ny * min;
        if (dot < 0) { c.vx -= 2 * dot * nx; c.vy -= 2 * dot * ny; }
        c.vx += nx * 260 * S; c.vy += ny * 260 * S; c.spin += 15;
        if (d.cool <= 0) { addText('QUACK!', d.x, d.y - 26 * S, '#fff3a0', 20); d.cool = 0.6; }
      }
    }
    g.ducks = g.ducks.filter(d => !d.dead);
  }

  function updatePuddles(dt) {
    g.puddles.forEach((p, i) => {
      p.age += dt;
      if (p.amount <= 0) g.puddles[i] = makePuddle();
    });
  }

  function updateFx(dt) {
    for (const p of g.parts) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      const drag = Math.pow(p.kind === 'bubble' ? 0.3 : 0.05, dt);
      p.vx *= drag; p.vy = p.vy * drag - (p.kind === 'bubble' ? 30 * S * dt : 0);
      p.life -= dt;
    }
    g.parts = g.parts.filter(p => p.life > 0);
    for (const t of g.texts) t.life -= dt;
    g.texts = g.texts.filter(t => t.life > 0);
  }

  function update(dt) {
    g.clock += dt;
    if (g.state === 'play') {
      g.t += dt;
      g.splatCd = Math.max(0, g.splatCd - dt);
      g.soapCd -= dt;
      spawnStuff(dt);
      updateClaude(dt);
    } else if (g.state === 'caught') {
      updateCaught(dt);
    }
    updateHands(dt); updateSweeps(dt); updateSoaps(dt); updateBlobs(dt); updateDucks(dt);
    updatePuddles(dt); updateFx(dt);
    g.shake = Math.max(0, g.shake - dt * 25);
  }

  // ---------- drawing ----------

  function roundRectPath(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); }

  function drawPuddle(p) {
    const rr = puddleR(p), n = p.pts.length;
    const pt = i => {
      const a = i / n * TAU, k = p.pts[i % n];
      return [p.x + Math.cos(a) * rr * k, p.y + Math.sin(a) * rr * 0.75 * k];
    };
    ctx.globalAlpha = Math.min(1, p.age * 2);
    const [px, py] = pt(n - 1), [qx, qy] = pt(0);
    ctx.beginPath();
    ctx.moveTo((px + qx) / 2, (py + qy) / 2);
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pt(i), [bx, by] = pt(i + 1);
      ctx.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2);
    }
    ctx.closePath();
    ctx.fillStyle = p.deep ? pal.deep : pal.mud; ctx.fill();
    ctx.lineWidth = 4 * S; ctx.strokeStyle = pal.mudEdge; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.beginPath(); ctx.ellipse(p.x - rr * 0.3, p.y - rr * 0.25, rr * 0.35, rr * 0.12, -0.2, 0, TAU); ctx.fill();
    if (p.deep) {
      ctx.lineWidth = 1.5 * S;
      for (const b of p.bub) {
        const f = (g.clock * 0.7 + b.o) % 1;
        ctx.strokeStyle = `rgba(255,230,200,${0.6 * (1 - f)})`;
        circle(p.x + b.x * rr, p.y + b.y * rr * 0.75, (2 + f * 6) * S); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawClaude(c) {
    const R = claudeR(), k = R / 42, half = 17 * Math.PI / 180;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.beginPath(); ctx.ellipse(3 * S, 6 * S, R * 0.95, R * 0.8, 0, 0, TAU); ctx.fill();
    if (c.iframes > 0) ctx.globalAlpha = 0.7;
    const cols = g.dirt.map(colorAt);
    ctx.lineCap = 'round';
    // Pale outline so a muddy Claude still stands out against the mud.
    ctx.strokeStyle = 'rgba(255,245,230,.75)'; ctx.lineWidth = 10 * k;
    cols.forEach((_, i) => {
      const a = rayAngle(c, i), len = opts.lengths[i] * k;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * 4 * k, Math.sin(a) * 4 * k); ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len); ctx.stroke();
    });
    // Solid middle: one slice per tentacle, like the spa's.
    cols.forEach((col, i) => {
      const a = rayAngle(c, i);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(-Math.cos(a) * 1.5 * k, -Math.sin(a) * 1.5 * k);
      ctx.arc(0, 0, 9 * k, a - half, a + half);
      ctx.closePath(); ctx.fill();
    });
    ctx.lineWidth = 7 * k;
    cols.forEach((col, i) => {
      const a = rayAngle(c, i), len = opts.lengths[i] * k;
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * 8 * k, Math.sin(a) * 8 * k); ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len); ctx.stroke();
    });
    g.dirt.forEach((d, i) => {
      const a = rayAngle(c, i), len = opts.lengths[i] * k, nx = -Math.sin(a), ny = Math.cos(a);
      SPOTS[i].forEach((s, j) => {
        const alpha = clamp(d * 3 - j, 0, 1);
        if (!alpha) return;
        ctx.fillStyle = `rgba(74,48,32,${alpha})`;
        circle(Math.cos(a) * len * s.f + nx * s.off * k, Math.sin(a) * len * s.f + ny * s.off * k, s.r * k); ctx.fill();
      });
    });
    ctx.restore();
  }

  function drawArm(ax, ay, x, y, dir, scale, wob) {
    const wx = x - Math.cos(dir) * 16 * scale, wy = y - Math.sin(dir) * 16 * scale;
    const len = Math.hypot(wx - ax, wy - ay) || 1, nx = -(wy - ay) / len, ny = (wx - ax) / len;
    const bend = Math.sin(g.clock * 3 + wob) * Math.min(40 * S, len * 0.15);   // noodle arms
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo((ax + wx) / 2 + nx * bend, (ay + wy) / 2 + ny * bend, wx, wy);
    ctx.strokeStyle = pal.sleeveEdge; ctx.lineWidth = 24 * scale; ctx.stroke();
    ctx.strokeStyle = pal.sleeve; ctx.lineWidth = 19 * scale; ctx.stroke();
  }

  // A rubber-gloved hand pointing along +x in its own coordinates.
  function drawHand(x, y, dir, scale, glove, grip, wiggle, muddy) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(dir); ctx.scale(scale, scale);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const spread = 0.34 * (1 - grip) + 0.04;
    const digits = [14, 17, 16, 12].map((l, j) => {
      const a = (j - 1.5) * spread + Math.sin(wiggle + j * 1.3) * 0.12, len = l * (1 - 0.4 * grip), by = (j - 1.5) * 5.2;
      return [7, by, 7 + Math.cos(a) * len, by + Math.sin(a) * len];
    });
    const ta = -1.2 + grip * 0.7;
    digits.push([-2, -9, -2 + Math.cos(ta) * 12, -9 + Math.sin(ta) * 12]);
    const strokeDigits = (color, width) => {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      for (const [x1, y1, x2, y2] of digits) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    };
    strokeDigits(glove[1], 8.5);
    ctx.beginPath(); ctx.ellipse(0, 0, 12, 12.5, 0, 0, TAU);
    ctx.fillStyle = glove[0]; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = glove[1]; ctx.stroke();
    strokeDigits(glove[0], 5.5);
    if (muddy) {
      ctx.fillStyle = pal.mud;
      [[2, -4, 4.5], [-5, 5, 3.2], [9, 3, 2.6], [20, -2, 2.4]].forEach(([mx, my, mr]) => { circle(mx, my, mr); ctx.fill(); });
    }
    ctx.fillStyle = pal.sleeve; ctx.strokeStyle = pal.sleeveEdge; ctx.lineWidth = 2;
    roundRectPath(-18, -11, 8, 22, 3); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function drawHandEntity(h) {
    let x = h.x, y = h.y;
    if (h.state === 'windup' || h.state === 'ew') { x += rand(-2, 2) * S; y += rand(-2, 2) * S; }
    const wiggle = g.clock * (h.state === 'windup' ? 28 : 7) + h.wob;
    if (h.state === 'throw' && h.aim !== null) {
      // Aim line, fading in over the wind-up, and the hand drawn back ready to throw.
      const k = clamp(1 - h.st / SOAP_AIM, 0, 1);
      ctx.save();
      ctx.setLineDash([8 * S, 8 * S]); ctx.lineDashOffset = -g.clock * 80;
      ctx.strokeStyle = `rgba(143,212,255,${0.35 + 0.5 * k})`; ctx.lineWidth = 3 * S; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(h.x + Math.cos(h.aim) * 28 * S, h.y + Math.sin(h.aim) * 28 * S);
      ctx.lineTo(h.x + Math.cos(h.aim) * 280 * S, h.y + Math.sin(h.aim) * 280 * S);
      ctx.stroke();
      ctx.restore();
      x -= Math.cos(h.aim) * 8 * S * k; y -= Math.sin(h.aim) * 8 * S * k;
    }
    drawHand(x, y, h.dir, 1.15 * S, GLOVES[h.type], h.grip, wiggle, h.muddy);
    if (h.state === 'windup') {
      ctx.font = `900 ${30 * S}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 5 * S; ctx.strokeStyle = '#fff'; ctx.strokeText('!', h.x, h.y - 34 * S);
      ctx.fillStyle = '#ff3b5c'; ctx.fillText('!', h.x, h.y - 34 * S);
    }
  }

  function sweepGeom(sw) {
    const fwd = sw.fromStart ? 1 : -1;
    const dir = sw.horiz ? (fwd > 0 ? 0 : Math.PI) : (fwd > 0 ? Math.PI / 2 : -Math.PI / 2);
    return { fwd, dir };
  }

  function drawSweepWarn(sw) {
    const { fwd, dir } = sweepGeom(sw);
    const x0 = sw.horiz ? 0 : sw.lane - sw.w / 2, y0 = sw.horiz ? sw.lane - sw.w / 2 : 0;
    const w = sw.horiz ? W : sw.w, h = sw.horiz ? sw.w : H;
    ctx.save();
    ctx.fillStyle = `rgba(255,70,90,${0.14 + 0.1 * Math.sin(g.clock * 18)})`;
    ctx.fillRect(x0, y0, w, h);
    ctx.setLineDash([12 * S, 10 * S]); ctx.lineDashOffset = -g.clock * 60;
    ctx.strokeStyle = 'rgba(255,70,90,.85)'; ctx.lineWidth = 3 * S;
    ctx.strokeRect(x0, y0, w, h);
    ctx.setLineDash([]);
    // Chevrons marching in the direction the big hand will come from.
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    const span = sw.horiz ? W : H, gap = 90 * S, off = (g.clock * 160 * S) % gap;
    for (let s = -gap; s < span + gap; s += gap) {
      const along = fwd > 0 ? s + off : span - s - off;
      const cx = sw.horiz ? along : sw.lane, cy = sw.horiz ? sw.lane : along;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(dir);
      ctx.beginPath(); ctx.moveTo(10 * S, 0); ctx.lineTo(-6 * S, -12 * S); ctx.lineTo(-6 * S, 12 * S); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.font = `900 ${22 * S}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tx = sw.horiz ? W / 2 : sw.lane, ty = sw.horiz ? sw.lane : (top + H) / 2;
    ctx.lineWidth = 5 * S; ctx.strokeStyle = 'rgba(80,0,20,.8)'; ctx.strokeText('BIG SCRUB!', tx, ty);
    ctx.fillStyle = '#fff'; ctx.fillText('BIG SCRUB!', tx, ty);
    ctx.restore();
  }

  function drawSweepHand(sw) {
    if (sw.along === null) return;
    const { dir } = sweepGeom(sw), scale = 4 * S;
    const x = sw.horiz ? sw.along : sw.lane, y = sw.horiz ? sw.lane : sw.along;
    drawArm(x - Math.cos(dir) * 3000, y - Math.sin(dir) * 3000, x, y, dir, scale, 0);
    drawHand(x, y, dir, scale, GLOVES.sweeper, g.caught && g.caught.sweep === sw ? 1 : 0, g.clock * 10, false);
  }

  function drawDuck(d) {
    const f = d.vx > 0 ? 1 : -1, bob = Math.sin(d.t * 9) * 2 * S;
    ctx.save();
    ctx.translate(d.x, d.y + bob); ctx.scale(f * S, S);
    ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(0, 15, 22, 5, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffd23f'; ctx.strokeStyle = '#d99e00'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 2, 22, 14, 0, 0, TAU); ctx.fill(); ctx.stroke();
    circle(13, -12, 10); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ff8a3d'; ctx.beginPath(); ctx.ellipse(24, -10, 7, 3.5, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f2b90f'; ctx.beginPath(); ctx.ellipse(-3, 2, 10, 6, -0.3, 0, TAU); ctx.fill();
    ctx.fillStyle = '#222'; circle(16, -15, 1.8); ctx.fill();
    ctx.restore();
  }

  function drawSoap(s) {
    ctx.save();
    ctx.translate(s.x, s.y); ctx.rotate(s.rot); ctx.scale(S, S);
    ctx.fillStyle = '#ffc4e1'; ctx.strokeStyle = '#e07aad'; ctx.lineWidth = 2;
    roundRectPath(-14, -9, 28, 18, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    roundRectPath(-9, -5, 12, 4, 2); ctx.fill();
    ctx.restore();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = pal.ground; ctx.fillRect(0, 0, W, H);
    if (g.shake > 0) ctx.translate(rand(-1, 1) * g.shake * S, rand(-1, 1) * g.shake * S);
    ctx.drawImage(ground, 0, 0, W, H);

    ctx.fillStyle = pal.mud;
    for (const d of g.decals) { ctx.globalAlpha = d.a; circle(d.x, d.y, d.r); ctx.fill(); }
    ctx.globalAlpha = 1;
    g.puddles.forEach(drawPuddle);
    g.sweeps.forEach(sw => sw.t < sw.warn && drawSweepWarn(sw));
    g.ducks.forEach(drawDuck);
    g.soaps.forEach(drawSoap);
    drawClaude(g.claude);
    for (const h of g.hands) drawArm(h.ax, h.ay, h.x, h.y, h.dir, 1.15 * S, h.wob);
    g.hands.forEach(drawHandEntity);
    g.sweeps.forEach(drawSweepHand);

    for (const b of g.blobs) {
      ctx.fillStyle = pal.mud; circle(b.x, b.y, b.r); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.25)'; circle(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.35); ctx.fill();
    }
    for (const p of g.parts) {
      ctx.globalAlpha = clamp(p.life * 2.5, 0, 1);
      circle(p.x, p.y, p.r);
      if (p.kind === 'bubble') { ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5 * S; ctx.stroke(); }
      else { ctx.fillStyle = pal.mud; ctx.fill(); }
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const t of g.texts) {
      const k = 1 - t.life / t.max, pop = Math.min(1, k * 6);
      ctx.globalAlpha = Math.min(1, t.life / 0.3);
      ctx.font = `800 ${t.size * S * (0.6 + 0.4 * pop)}px system-ui, sans-serif`;
      ctx.lineWidth = 4 * S; ctx.strokeStyle = 'rgba(40,25,15,.85)';
      ctx.strokeText(t.text, t.x, t.y - k * 30 * S);
      ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y - k * 30 * S);
    }
    ctx.globalAlpha = 1;
  }

  function hud() {
    const m = avg(g.dirt);
    ui.pct.textContent = Math.round(m * 100);
    ui.fill.style.width = m * 100 + '%';
    ui.time.textContent = fmt(g.t);
    ui.score.textContent = scoreOf();
    ui.splat.style.setProperty('--ready', 1 - g.splatCd / SPLAT_CD);
    ui.splat.classList.toggle('ready', g.state === 'play' && g.splatCd === 0);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.033, Math.max(0, (now - lastT) / 1000));
    lastT = now;
    update(dt); draw(); hud();
  }

  // ---------- flow ----------

  function endGame() {
    if (g.state === 'over') return;
    g.state = 'over';
    const score = scoreOf();
    let best = 0;
    try { best = Number(localStorage.getItem(BEST_KEY)) || 0; } catch {}
    const record = score > best;
    if (record) try { localStorage.setItem(BEST_KEY, score); } catch {}
    ui.result.innerHTML = `Rolled for <b>${fmt(g.t)}</b> · <b>${Math.round(avg(g.dirt) * 100)}%</b> muddy · ` +
      `<b>${g.splatted}</b> hand${g.splatted === 1 ? '' : 's'} splatted<br>Score <b>${score}</b>` +
      (record ? ' 🏆 new best!' : ` · best ${best}`);
    ui.over.hidden = false;
  }

  function play() {
    ui.intro.hidden = true; ui.over.hidden = true;
    if (g.state !== 'intro') newGame(g.dirt);
    g.state = 'play';
  }

  function start(o) {
    opts = o; api.active = true; root.hidden = false;
    pal = palette(); resize();
    newGame(o.dirt); g.state = 'intro';
    ui.intro.hidden = false; ui.over.hidden = true;
    keys.clear(); pointer.down = false;
    cancelAnimationFrame(raf);
    lastT = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function close() {
    if (!api.active) return;
    api.active = false; root.hidden = true;
    cancelAnimationFrame(raf);
    opts.onExit(g.dirt.map(d => (d < 0.005 ? 0 : clamp(d, 0, 1))));
  }

  const keyName = e => (e.key.length === 1 ? e.key.toLowerCase() : e.key);
  window.addEventListener('keydown', e => {
    if (!api.active) return;
    const k = keyName(e);
    if (k === 'Escape') return close();
    if (k === ' ' || k === 'Enter' || k.startsWith('Arrow')) e.preventDefault();
    if ((k === ' ' || k === 'Enter') && g.state === 'intro') return play();
    if (k === ' ') return splat();
    keys.add(k);
  });
  window.addEventListener('keyup', e => keys.delete(keyName(e)));
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('resize', () => { if (api.active) resize(); });

  cv.addEventListener('pointerdown', e => {
    pointer.down = true; pointer.x = e.clientX; pointer.y = e.clientY;
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => { pointer.x = e.clientX; pointer.y = e.clientY; });
  cv.addEventListener('pointerup', () => { pointer.down = false; });
  cv.addEventListener('pointercancel', () => { pointer.down = false; });
  ui.splat.addEventListener('pointerdown', e => { e.preventDefault(); splat(); });
  $('mud-go').addEventListener('click', play);
  $('mud-again').addEventListener('click', play);
  $('mud-home').addEventListener('click', close);
  $('mud-quit').addEventListener('click', close);

  return api;
})();
