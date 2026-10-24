// ==UserScript==
// @name         Koi Fish Pet
// @namespace    koi-fish-pet
// @version      1.1
// @description  A tiny koi pet that swims around every tab. Click it to change its colour. Grab it and it escapes.
// @author       Minad Uddin
// @license      MIT
// @match        *://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/minaduddin/Koi-fish-pet/main/koi-fish-pet.user.js
// @downloadURL  https://raw.githubusercontent.com/minaduddin/Koi-fish-pet/main/koi-fish-pet.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ---------- Config ----------
    const CFG = {
        size: 0.25,
        speed: 24, waveAmp: 1, waveSpeed: 1, turnRadius: 1.5, wander: 0.8, edgeMargin: 220,
        bodyOpacity: 1, finScale: 1, finOpacity: 1, finFlutter: 1,
        shadowAlpha: 0.14, shadowBlur: 4, shadowDist: 18, shadowAngle: 49,
        auroraA: '#ff4d8d', auroraB: '#22d3ee', auroraC: '#f59e0b', auroraSpin: 0.6,
        glowStrength: 14, glowAlpha: 0.85,
        startleBurst: 4.5, startleSecs: 1.6,
        hideSecs: 5, annoyLimit: 4, hideGrowth: 4, maxHide: 90, annoyReset: 40
    };
    const COLOR_KEY = 'koi-fish-pet-color';

    // ---------- Helpers ----------
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const wrapAngle = (a) => {
        while (a > Math.PI) a -= Math.PI * 2;
        while (a < -Math.PI) a += Math.PI * 2;
        return a;
    };
    function hex2rgb(h) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
        if (!m) return [128, 128, 128];
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    function hslToRgb(h, s, l) {
        s /= 100; l /= 100;
        const k = (n) => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        return [f(0) * 255, f(8) * 255, f(4) * 255];
    }
    const rgbStr = (c, al) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${al})`;

    // ---------- Colour ----------
    function randomHsl(prevHue) {
        let h, tries = 0;
        do {
            h = Math.random() * 360;
            tries++;
        } while (prevHue != null && tries < 50 && Math.abs(((h - prevHue + 540) % 360) - 180) < 60);   // always clearly different
        return { h, s: 70 + Math.random() * 25, l: 42 + Math.random() * 16 };
    }
    function paletteFrom(c) {
        return { body: hslToRgb(c.h, c.s, c.l), shadow: hslToRgb(c.h, c.s * 0.6, c.l * 0.45) };
    }
    // Colour is stored by Tampermonkey, so it is shared across every site
    function loadHsl() {
        try {
            const c = GM_getValue(COLOR_KEY, null);
            if (c && [c.h, c.s, c.l].every(Number.isFinite)) return c;
        } catch (e) { /* ignore */ }
        return randomHsl(null);
    }
    function saveHsl(c) {
        try { GM_setValue(COLOR_KEY, c); } catch (e) { /* ignore */ }
    }

    // ---------- Geometry ----------
    const FISH_SIZE = CFG.size;
    const SEGMENTS = 15;
    const SEG_LEN = 13 * FISH_SIZE;
    const BODY_LEN = SEG_LEN * (SEGMENTS - 1);
    const MAX_HALF_W = 15 * FISH_SIZE;
    const CANVAS_PX = Math.max(260, Math.round(360 * FISH_SIZE));
    const WAVE_PER_SEG = 0.44;

    const fishState = {
        canvas: null, ctx: null, off: null, offCtx: null, dpr: 1,
        pts: [], draw: [], col: null, target: null, hsl: null,
        theta: 0, omega: 0, phase: 0, finPhase: 0, t: 0,
        pulse: 0, startle: 0, fleeAngle: 0, sinceStartle: 99, curlSign: 1,
        fx: [], ripples: [], colorGlow: 0, glowCol: [255, 255, 255],
        effort: 1, hover: 0, pause: 0, idleTimer: 9, popTimer: 0,
        seed: Math.random() * 100,
        mode2: 'swim', hideLeft: 0, hideFor: 6, exitAngle: 0, enterAngle: 0, annoy: 0, lastDisturb: -999,
        down: null, dragging: false, suppressClick: false, cx: -999, cy: -999, handHover: false
    };

    function initFishState(hx0, hy0, th0) {
        const s = fishState;
        const hx = hx0 ?? Math.max(200, window.innerWidth - 200);
        const hy = hy0 ?? Math.max(200, window.innerHeight - 220);
        s.theta = th0 ?? Math.atan2(-0.4, -1);
        s.pts = [];
        for (let i = 0; i < SEGMENTS; i++) {
            s.pts.push({ x: hx - Math.cos(s.theta) * SEG_LEN * i, y: hy - Math.sin(s.theta) * SEG_LEN * i });
        }
        if (!s.hsl) {
            s.hsl = loadHsl();
            s.target = paletteFrom(s.hsl);
            s.col = { body: s.target.body.slice(), shadow: s.target.shadow.slice() };
        }
    }

    // Top-down body width: blunt head, widest ~30% back, long taper to a slim tail
    function halfWidth(t) {
        const peak = 0.32;
        const k = t < peak
            ? 0.55 + 0.45 * Math.sin((t / peak) * Math.PI / 2)
            : 0.06 + 0.94 * Math.pow(Math.cos(((t - peak) / (1 - peak)) * Math.PI / 2), 1.35);
        return MAX_HALF_W * k;
    }

    // ---------- Update ----------
    function updateFish(dt) {
        const s = fishState;
        const W = window.innerWidth, H = window.innerHeight;
        const head = s.pts[0];
        s.t += dt;
        s.sinceStartle += dt;
        const st = s.startle;

        // Hidden: wait off-screen, then sneak back in from a random edge
        if (s.mode2 === 'hidden') {
            s.draw = [];
            s.hideLeft -= dt;
            if (s.hideLeft <= 0) beginReturn();
            return;
        }
        const roaming = s.mode2 === 'swim';

        if (s.dragging) {
            // Grabbed: the head follows the cursor, the fish thrashes about
            const ox0 = head.x, oy0 = head.y, k = Math.min(1, dt * 10);
            head.x += (s.cx - head.x) * k;
            head.y += (s.cy - head.y) * k;
            const vx = (head.x - ox0) / Math.max(dt, 1e-3), vy = (head.y - oy0) / Math.max(dt, 1e-3);
            if (Math.hypot(vx, vy) > 25) s.theta += wrapAngle(Math.atan2(vy, vx) - s.theta) * Math.min(1, dt * 5);
            s.omega = 0;
            s.hover += (0 - s.hover) * Math.min(1, dt * 4);
            s.effort += (2.2 - s.effort) * Math.min(1, dt * 10);
            s.phase += dt * Math.PI * 2 * 5.5 * CFG.waveSpeed;
            s.finPhase += dt * 14;
        } else {
            // Idle: now and then stop, hover and kiss the surface (ripples)
            if (st > 0 || !roaming) {
                s.pause = 0;
            } else if (s.pause > 0) {
                s.pause -= dt;
                s.popTimer -= dt;
                if (s.popTimer <= 0 && s.pause > 0.5) {
                    s.ripples.push({ x: head.x + Math.cos(s.theta) * SEG_LEN * 0.5, y: head.y + Math.sin(s.theta) * SEG_LEN * 0.5, age: 0 });
                    s.popTimer = 0.9 + Math.random() * 1.3;
                }
            } else {
                s.idleTimer -= dt;
                if (s.idleTimer <= 0) {
                    s.pause = 3 + Math.random() * 3;
                    s.popTimer = 0.7;
                    s.idleTimer = 12 + Math.random() * 16;
                }
            }
            s.hover += ((s.pause > 0 ? 1 : 0) - s.hover) * Math.min(1, dt * 1.5);

            // Speed: cruise, hover, startle burst then glide
            const cruise = CFG.speed * (0.85 + 0.15 * Math.sin(s.t * 0.6)) * (1 - 0.88 * s.hover);
            let speed = cruise * (1 + CFG.startleBurst * st * st);
            if (s.mode2 === 'leave') speed = CFG.speed * 4.2;
            else if (s.mode2 === 'return') speed = CFG.speed * 1.7;

            // Steering limited by body length so the body never folds into a hairpin
            const curvLimit = lerp(1 / (CFG.turnRadius * BODY_LEN), 1 / (CFG.turnRadius * 0.6 * BODY_LEN), st);
            const maxTurn = Math.max(0.03, speed * curvLimit);
            let target = (0.6 * Math.sin(s.t * 0.37 + s.seed) + 0.4 * Math.sin(s.t * 0.83 + s.seed * 2.3)) * CFG.wander * maxTurn;
            const m = CFG.edgeMargin;
            const edge = roaming ? Math.max(0, 1 - head.x / m, 1 - (W - head.x) / m, 1 - head.y / m, 1 - (H - head.y) / m) : 0;
            if (s.mode2 === 'leave') target = clamp(wrapAngle(s.exitAngle - s.theta) * 4, -maxTurn, maxTurn);
            else if (s.mode2 === 'return') target = clamp(wrapAngle(s.enterAngle - s.theta) * 2, -maxTurn, maxTurn) * 0.3;
            if (edge > 0) {
                const toCentre = Math.atan2(H / 2 - head.y, W / 2 - head.x);
                target += clamp(wrapAngle(toCentre - s.theta) * 2, -1, 1) * maxTurn * Math.min(1, edge * 1.5);
            }
            if (st > 0) target += wrapAngle(s.fleeAngle - s.theta) * 5 * st;
            target = clamp(target, -maxTurn, maxTurn);
            s.omega += (target - s.omega) * Math.min(1, dt * (2 + 8 * st));
            s.theta += s.omega * dt;
            if (roaming) {
                head.x = clamp(head.x + Math.cos(s.theta) * speed * dt, 20, W - 20);
                head.y = clamp(head.y + Math.sin(s.theta) * speed * dt, 20, H - 20);
            } else {
                head.x += Math.cos(s.theta) * speed * dt;
                head.y += Math.sin(s.theta) * speed * dt;
            }

            // Tail-beat effort: strong during the burst, near-still while gliding, tiny while hovering
            let effTarget = 1;
            if (st > 0.62) effTarget = 1.8;
            else if (st > 0.2) effTarget = 0.3;
            if (s.mode2 === 'leave') effTarget = 1.7;
            effTarget *= 1 - 0.65 * s.hover;
            s.effort += (effTarget - s.effort) * Math.min(1, dt * 10);

            const speedBL = speed / BODY_LEN;
            s.phase += dt * Math.PI * 2 * (0.5 + 1.8 * speedBL) * (0.35 + 0.65 * Math.min(1.5, s.effort)) * CFG.waveSpeed;
            s.finPhase += dt * (2.6 + 2.2 * s.hover);
        }

        // Body follows the head
        for (let i = 1; i < SEGMENTS; i++) {
            const a = s.pts[i - 1], b = s.pts[i];
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.hypot(dx, dy) || 1;
            b.x = a.x + (dx / d) * SEG_LEN;
            b.y = a.y + (dy / d) * SEG_LEN;
        }

        if (s.mode2 === 'leave') {
            const tl = s.pts[SEGMENTS - 1], mg = 50;
            if (tl.x < -mg || tl.x > W + mg || tl.y < -mg || tl.y > H + mg) {
                s.mode2 = 'hidden';
                s.hideLeft = s.hideFor;
                s.draw = [];
            }
        } else if (s.mode2 === 'return') {
            if (head.x > 70 && head.x < W - 70 && head.y > 70 && head.y < H - 70) s.mode2 = 'swim';
        }
        updateHandCursor();

        s.startle = Math.max(0, s.startle - dt / (s.mode2 === 'leave' ? 99 : CFG.startleSecs));
        s.pulse = Math.max(0, s.pulse - dt * 1.4);
        s.colorGlow = Math.max(0, s.colorGlow - dt / 1.2);
        for (const r of s.ripples) r.age += dt;
        s.ripples = s.ripples.filter((r) => r.age < 1.9);
        for (const f of s.fx) f.age += dt;
        s.fx = s.fx.filter((f) => f.age < 2.2);

        // Ease colour toward the current target
        const k = Math.min(1, dt * 5);
        for (let c = 0; c < 3; c++) {
            s.col.body[c] = lerp(s.col.body[c], s.target.body[c], k);
            s.col.shadow[c] = lerp(s.col.shadow[c], s.target.shadow[c], k);
        }
    }

    // ---------- Draw ----------
    function drawFish() {
        const s = fishState;
        const N = SEGMENTS;
        const dpr = s.dpr;
        const size = 1 + 0.2 * Math.sin(Math.PI * (1 - s.pulse));

        // C-start: quick body curl right after a click
        const curl = s.sinceStartle < 0.35 ? Math.sin(Math.PI * s.sinceStartle / 0.35) : 0;
        const lateral = (iF) => {
            const tt = Math.min(1.2, iF / (N - 1));
            const amp = SEG_LEN * 0.9 * CFG.waveAmp * Math.min(1.3, s.effort) * (0.08 + 0.92 * tt * tt);
            return Math.sin(s.phase - iF * WAVE_PER_SEG) * amp + s.curlSign * curl * SEG_LEN * 2.4 * Math.pow(tt, 1.6);
        };

        const tan = [], nrm = [], dp = [], hw = [];
        for (let i = 0; i < N; i++) {
            const a = s.pts[Math.max(0, i - 1)], b = s.pts[Math.min(N - 1, i + 1)];
            let tx = a.x - b.x, ty = a.y - b.y;
            const tl = Math.hypot(tx, ty) || 1;
            tx /= tl; ty /= tl;
            const nx = -ty, ny = tx;
            const off = lateral(i);
            tan.push({ x: tx, y: ty });
            nrm.push({ x: nx, y: ny });
            dp.push({ x: s.pts[i].x + nx * off, y: s.pts[i].y + ny * off });
            hw.push(halfWidth(i / (N - 1)) * size);
        }
        s.draw = dp;

        // Canvas follows the fish
        let cx = 0, cy = 0;
        for (let i = 0; i < N; i++) { cx += s.pts[i].x; cy += s.pts[i].y; }
        cx /= N; cy /= N;
        const ox = cx - CANVAS_PX / 2, oy = cy - CANVAS_PX / 2;

        const oc = s.offCtx;
        oc.setTransform(1, 0, 0, 1, 0, 0);
        oc.clearRect(0, 0, s.off.width, s.off.height);
        oc.setTransform(dpr, 0, 0, dpr, -ox * dpr, -oy * dpr);

        const r = Math.round(s.col.body[0]), g = Math.round(s.col.body[1]), b = Math.round(s.col.body[2]);
        const rgba = (a) => `rgba(${r},${g},${b},${a})`;
        const k2 = Math.max(0.7, FISH_SIZE * 2);

        // Surface ripples
        oc.lineWidth = 1.2;
        for (const rp of s.ripples) {
            for (const delay of [0, 0.25]) {
                const age = rp.age - delay;
                if (age <= 0) continue;
                const alpha = 0.4 * (1 - age / 1.6);
                if (alpha <= 0) continue;
                oc.strokeStyle = rgba(alpha);
                oc.beginPath();
                oc.arc(rp.x, rp.y, (3 + age * 20) * FISH_SIZE * 2, 0, Math.PI * 2);
                oc.stroke();
            }
        }

        // Colour-change burst: rings + bubbles in the new colour
        oc.lineCap = 'round';
        oc.lineJoin = 'round';
        for (const f of s.fx) {
            const cA = (a) => rgbStr(f.col, a);
            if (f.k === 'ring') {
                for (const d of [0, 0.22, 0.44]) {
                    const a = f.age - d;
                    if (a <= 0 || a > 1.5) continue;
                    const t = a / 1.5;
                    oc.strokeStyle = cA(0.7 * (1 - t));
                    oc.lineWidth = (2.4 - 1.7 * t) * k2;
                    oc.beginPath();
                    oc.arc(f.x, f.y, (8 + t * 78) * FISH_SIZE * 2, 0, Math.PI * 2);
                    oc.stroke();
                }
            } else if (f.k === 'bubbles') {
                const t = Math.min(1, f.age / 1.4);
                oc.fillStyle = cA(0.85 * (1 - t));
                for (const q of f.parts) {
                    const dist = q.v * t * (1 - 0.35 * t) * FISH_SIZE * 2;
                    oc.beginPath();
                    oc.arc(f.x + Math.cos(q.a) * dist, f.y + Math.sin(q.a) * dist - t * 14 * k2, q.r * (1 - 0.5 * t) * k2, 0, Math.PI * 2);
                    oc.fill();
                }
            }
        }

        // Pectoral / pelvic fins: held out, sculling gently, fold back while fleeing
        const layers = [{ L: 1, W: 1, da: 0, a: 0.92 }, { L: 0.7, W: 0.75, da: 0.32, a: 0.6 }];
        const fold = clamp(s.startle * 1.6, 0, 1);
        const drawFins = (idx, Lf, Wf, baseSpread, flapAmp, phaseOff) => {
            for (const side of [-1, 1]) {
                const nx = nrm[idx].x * side, ny = nrm[idx].y * side;
                const base = { x: dp[idx].x + nx * hw[idx] * 0.75, y: dp[idx].y + ny * hw[idx] * 0.75 };
                const inner = clamp((s.omega * side) / 0.3, -1, 1);
                const spreadSide = lerp(baseSpread + 0.45 * inner, 0.22, fold);
                const flap = flapAmp * CFG.finFlutter * (1 + 1.2 * s.hover) * (1 - fold);
                for (const layer of layers) {
                    const ang = spreadSide + layer.da * (1 - fold) + flap * Math.sin(s.finPhase + phaseOff + (side > 0 ? 0 : 0.7));
                    const ux = -tan[idx].x * Math.cos(ang) + nx * Math.sin(ang);
                    const uy = -tan[idx].y * Math.cos(ang) + ny * Math.sin(ang);
                    const dot = nx * ux + ny * uy;
                    let wx = nx - ux * dot, wy = ny - uy * dot;
                    const wl = Math.hypot(wx, wy) || 1;
                    wx /= wl; wy /= wl;
                    const L = Lf * layer.L * size, Wd = Wf * layer.W * size;
                    const curlF = Math.sin(s.finPhase * 1.3 + phaseOff + 1.2 + (side > 0 ? 0 : 0.5)) * L * 0.2;
                    const tip = { x: base.x + ux * L + wx * curlF * 1.2, y: base.y + uy * L + wy * curlF * 1.2 };
                    oc.beginPath();
                    oc.moveTo(base.x, base.y);
                    oc.bezierCurveTo(
                        base.x + ux * L * 0.25 + wx * Wd * 0.9, base.y + uy * L * 0.25 + wy * Wd * 0.9,
                        base.x + ux * L * 0.7 + wx * (Wd * 0.75 + curlF), base.y + uy * L * 0.7 + wy * (Wd * 0.75 + curlF),
                        tip.x, tip.y
                    );
                    oc.bezierCurveTo(
                        base.x + ux * L * 0.75 + wx * (curlF - Wd * 0.05), base.y + uy * L * 0.75 + wy * (curlF - Wd * 0.05),
                        base.x + ux * L * 0.35 - wx * Wd * 0.4, base.y + uy * L * 0.35 - wy * Wd * 0.4,
                        base.x, base.y
                    );
                    const grad = oc.createLinearGradient(base.x, base.y, tip.x, tip.y);
                    grad.addColorStop(0, rgba(layer.a * CFG.finOpacity));
                    grad.addColorStop(1, rgba(0.08));
                    oc.fillStyle = grad;
                    oc.fill();
                }
            }
        };
        drawFins(7, 22 * FISH_SIZE * CFG.finScale, 8 * FISH_SIZE * CFG.finScale, 0.8, 0.1, 1.5);    // pelvic
        drawFins(3, 32 * FISH_SIZE * CFG.finScale, 11 * FISH_SIZE * CFG.finScale, 0.7, 0.1, 0);     // pectoral

        // Body: smooth closed outline, blunt nose, slim tail
        const tipLen = SEG_LEN * 2.2;
        const P = [{ x: dp[0].x + tan[0].x * hw[0] * 1.1, y: dp[0].y + tan[0].y * hw[0] * 1.1 }];
        for (let i = 0; i < N; i++) P.push({ x: dp[i].x + nrm[i].x * hw[i], y: dp[i].y + nrm[i].y * hw[i] });
        P.push({ x: dp[N - 1].x - tan[N - 1].x * tipLen, y: dp[N - 1].y - tan[N - 1].y * tipLen });
        for (let i = N - 1; i >= 0; i--) P.push({ x: dp[i].x - nrm[i].x * hw[i], y: dp[i].y - nrm[i].y * hw[i] });
        const n = P.length;
        const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
        const m0 = mid(P[n - 1], P[0]);
        oc.beginPath();
        oc.moveTo(m0.x, m0.y);
        for (let k = 0; k < n; k++) {
            const c = P[k], mm = mid(c, P[(k + 1) % n]);
            oc.quadraticCurveTo(c.x, c.y, mm.x, mm.y);
        }
        oc.closePath();
        oc.fillStyle = rgba(CFG.bodyOpacity);
        oc.fill();

        // Composite: colour-change flash, multi-colour glow, soft shadow
        const ctx = s.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);

        if (s.colorGlow > 0) {
            ctx.shadowColor = rgbStr(s.glowCol, 0.95 * s.colorGlow);
            ctx.shadowBlur = (14 + 20 * s.colorGlow) * dpr * k2;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            ctx.drawImage(s.off, 0, 0);
        }

        const R = CFG.glowStrength * dpr * Math.max(0.8, FISH_SIZE * 2), ph = s.t * CFG.auroraSpin;
        const cols = [CFG.auroraA, CFG.auroraB, CFG.auroraC];
        for (let i = 0; i < 3; i++) {
            const ang = ph + i * 2.094;
            ctx.shadowColor = rgbStr(hex2rgb(cols[i]), CFG.glowAlpha);
            ctx.shadowBlur = R * 1.3;
            ctx.shadowOffsetX = Math.cos(ang) * R * 0.55;
            ctx.shadowOffsetY = Math.sin(ang) * R * 0.55;
            ctx.drawImage(s.off, 0, 0);
        }

        const sAng = CFG.shadowAngle * Math.PI / 180;
        ctx.shadowColor = rgbStr(s.col.shadow, CFG.shadowAlpha);
        ctx.shadowBlur = CFG.shadowBlur * dpr;
        ctx.shadowOffsetX = Math.cos(sAng) * CFG.shadowDist * FISH_SIZE * dpr;
        ctx.shadowOffsetY = Math.sin(sAng) * CFG.shadowDist * FISH_SIZE * dpr;
        ctx.drawImage(s.off, 0, 0);
        ctx.shadowColor = 'transparent';
        s.canvas.style.transform = `translate3d(${ox}px, ${oy}px, 0)`;
    }

    // ---------- Loop / canvas ----------
    function startFishLoop(canvas) {
        let last = performance.now();
        const frame = (now) => {
            if (!canvas.isConnected) return;
            const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
            last = now;
            updateFish(dt);
            if (fishState.mode2 === 'hidden') canvas.style.display = 'none';
            else { canvas.style.display = 'block'; drawFish(); }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }

    function createFish() {
        const s = fishState;
        if (s.canvas && s.canvas.isConnected) return false;
        s.dpr = Math.min(window.devicePixelRatio || 1, 2);
        const px = Math.round(CANVAS_PX * s.dpr);

        const canvas = document.createElement('canvas');
        canvas.id = 'koi-fish-pet';
        canvas.width = px;
        canvas.height = px;
        canvas.style.cssText =
            `position:fixed;left:0;top:0;width:${CANVAS_PX}px;height:${CANVAS_PX}px;` +
            'z-index:2147483647;pointer-events:none;will-change:transform;';

        const off = document.createElement('canvas');
        off.width = px;
        off.height = px;

        s.canvas = canvas;
        s.ctx = canvas.getContext('2d');
        s.off = off;
        s.offCtx = off.getContext('2d');
        if (!s.pts.length) initFishState();

        document.body.appendChild(canvas);
        startFishLoop(canvas);
        return true;
    }

    // ---------- Interaction ----------
    function hitXY(x, y) {
        const s = fishState, pts = s.draw;
        if (!pts.length || (s.mode2 !== 'swim' && s.mode2 !== 'return')) return false;
        const radius = MAX_HALF_W * 1.2 + 10;
        return pts.some((p) => Math.hypot(x - p.x, y - p.y) <= radius);
    }

    function ensureCursorStyle() {
        if (document.getElementById('koi-fish-cursor')) return;
        const st = document.createElement('style');
        st.id = 'koi-fish-cursor';
        st.textContent = 'html.koi-hover, html.koi-hover *{cursor:grab !important} html.koi-drag, html.koi-drag *{cursor:grabbing !important}';
        (document.head || document.documentElement).appendChild(st);
    }
    function updateHandCursor() {
        const s = fishState;
        const want = s.dragging || hitXY(s.cx, s.cy);
        if (want === s.handHover) return;
        s.handHover = want;
        if (want) ensureCursorStyle();
        document.documentElement.classList.toggle('koi-hover', want);
    }

    // The more you pester it, the longer it sulks off-screen
    function disturb(kind) {
        const s = fishState, now = performance.now() / 1000;
        if (now - s.lastDisturb > CFG.annoyReset) s.annoy = 0;
        s.lastDisturb = now;
        s.annoy++;
        const over = s.annoy - CFG.annoyLimit;
        let hide = 0;
        if (over > 0) hide = CFG.hideSecs + Math.random() + over * CFG.hideGrowth;
        else if (kind === 'grab') hide = CFG.hideSecs + Math.random();
        if (hide > 0) beginLeave(Math.min(hide, CFG.maxHide));
    }

    function beginLeave(secs) {
        const s = fishState, h = s.pts[0], W = window.innerWidth, H = window.innerHeight;
        const d = [[h.x, Math.PI], [W - h.x, 0], [h.y, -Math.PI / 2], [H - h.y, Math.PI / 2]].sort((a, b) => a[0] - b[0])[0];
        s.exitAngle = d[1] + (Math.random() - 0.5) * 0.3;
        s.fleeAngle = s.exitAngle;
        s.curlSign = wrapAngle(s.exitAngle - s.theta) >= 0 ? 1 : -1;
        s.hideFor = secs;
        s.mode2 = 'leave';
        s.startle = 1;
        s.pause = 0;
        s.ripples.push({ x: h.x, y: h.y, age: 0 });
    }

    function beginReturn() {
        const s = fishState, W = window.innerWidth, H = window.innerHeight, off = BODY_LEN + 40;
        const e = Math.floor(Math.random() * 4), u = 0.2 + Math.random() * 0.6;
        let x, y, th;
        if (e === 0) { x = -off; y = H * u; th = 0; }
        else if (e === 1) { x = W + off; y = H * u; th = Math.PI; }
        else if (e === 2) { x = W * u; y = -off; th = Math.PI / 2; }
        else { x = W * u; y = H + off; th = -Math.PI / 2; }
        th += (Math.random() - 0.5) * 0.4;
        initFishState(x, y, th);
        s.enterAngle = th;
        s.mode2 = 'return';
        s.startle = 0;
        s.omega = 0;
    }

    function startleFish(x, y) {
        const s = fishState;
        if (!s.pts.length) return;
        let cx = 0, cy = 0;
        for (const p of s.pts) { cx += p.x; cy += p.y; }
        cx /= s.pts.length; cy /= s.pts.length;
        s.fleeAngle = Math.atan2(cy - y, cx - x) + (Math.random() - 0.5) * 0.5;
        s.curlSign = wrapAngle(s.fleeAngle - s.theta) >= 0 ? 1 : -1;
        s.sinceStartle = 0;
        s.startle = 1;
        s.pause = 0;
    }

    // Every click = a new, clearly different colour
    function changeColour() {
        const s = fishState;
        s.hsl = randomHsl(s.hsl ? s.hsl.h : null);
        s.target = paletteFrom(s.hsl);
        saveHsl(s.hsl);
        s.pulse = 1;
        s.colorGlow = 1;
        s.glowCol = s.target.body.slice();
        const h = s.pts[0];
        if (!h) return;
        const col = s.target.body.slice();
        s.fx.push({ k: 'ring', age: 0, x: h.x, y: h.y, col });
        const parts = [];
        for (let i = 0; i < 16; i++) parts.push({ a: Math.random() * Math.PI * 2, v: 30 + Math.random() * 60, r: 1.2 + Math.random() * 2.2 });
        s.fx.push({ k: 'bubbles', age: 0, x: h.x, y: h.y, parts, col });
    }

    function releaseFish() {
        const s = fishState, was = s.dragging;
        s.down = null;
        s.dragging = false;
        document.documentElement.classList.remove('koi-drag');
        if (was) {
            s.suppressClick = true;
            setTimeout(() => { s.suppressClick = false; }, 120);
            disturb('grab');
        }
    }

    // Catch clicks on the fish before the page sees them
    function swallow(e) {
        const s = fishState;
        const up = e.type === 'pointerup' || e.type === 'mouseup';
        if (up && s.down) {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            if (e.type === 'pointerup') releaseFish();
            return true;
        }
        if (e.button !== 0 || !hitXY(e.clientX, e.clientY)) return false;
        if (e.type === 'pointerdown') { s.down = { x: e.clientX, y: e.clientY }; s.dragging = false; }
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return true;
    }

    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((t) => window.addEventListener(t, swallow, true));

    window.addEventListener('pointermove', (e) => {
        const s = fishState;
        s.cx = e.clientX; s.cy = e.clientY;
        if (s.down && !s.dragging) {
            if (e.buttons === 0) s.down = null;
            else if (Math.hypot(e.clientX - s.down.x, e.clientY - s.down.y) > 6) {
                s.dragging = true;
                if (s.mode2 === 'return') s.mode2 = 'swim';
                s.startle = 0;
                ensureCursorStyle();
                document.documentElement.classList.add('koi-drag');
            }
        } else if (s.dragging && e.buttons === 0) releaseFish();
    }, true);

    window.addEventListener('blur', () => { if (fishState.down) releaseFish(); });

    window.addEventListener('click', (e) => {
        if (!swallow(e)) return;
        if (fishState.suppressClick) { fishState.suppressClick = false; return; }
        changeColour();
        startleFish(e.clientX, e.clientY);
        disturb('click');
    }, true);

    // ---------- Init ----------
    function init() {
        if (!document.body || document.contentType && !/html/i.test(document.contentType)) return;   // skip PDFs, raw files, etc.
        createFish();
        setInterval(createFish, 2000);   // re-attach if the page rebuilds itself
    }

    if (document.body) init();
    else window.addEventListener('DOMContentLoaded', init, { once: true });
})();
