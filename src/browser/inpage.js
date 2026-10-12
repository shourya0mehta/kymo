// In-page instrument for kymo. Injected with page.addInitScript before any app code runs.
// Plain JavaScript on purpose: it is serialized into the page, so it must not depend on build helpers.
// It watches one interaction at a time: arm() before the press, disarm() after the watch window.
(() => {
  if (window.__fc) return;

  const GROUP_ATTR = window.__fcGroupAttr || "data-kymo-group";
  const JUMP_PX = 24; // teleport threshold (researcher proposal, see rule MOT-09)
  const POP_SHARE = 0.02; // pop threshold: share of viewport area
  const MAX_TRACKED = 1500;
  const LAYOUT_PROPS = /^(width|height|min-width|min-height|max-width|max-height|top|left|right|bottom|inset.*|margin.*|padding.*|grid-template-.*|font-size|border-width)$/;
  const SIG_PROPS = [
    "background-color", "color", "transform", "opacity", "box-shadow", "border-top-color",
    "outline-style", "outline-color", "scale", "translate", "filter", "text-decoration-line",
  ];
  const IGNORE_KF = new Set(["offset", "computedOffset", "easing", "composite"]);

  const fc = { armed: false };
  window.__fc = fc;

  // ---------- helpers ----------
  const cssPath = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (cur.id) { parts.unshift("#" + CSS.escape(cur.id)); break; }
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ");
  };

  const implicitRole = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "button" || t === "submit" || t === "reset") return "button";
    }
    return null;
  };

  const describe = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const groupEl = el.closest("[" + GROUP_ATTR + "]");
    const text = (el.getAttribute("aria-label") || el.innerText || el.textContent || "")
      .trim().replace(/\s+/g, " ").slice(0, 60);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      testid: el.getAttribute("data-testid"),
      group: groupEl ? groupEl.getAttribute(GROUP_ATTR) : null,
      text,
      css: cssPath(el),
      role: implicitRole(el),
    };
  };
  fc.describe = describe;

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const effOpacity = (el) => {
    let o = 1;
    for (let c = el; c && c !== document.documentElement; c = c.parentElement) {
      o *= parseFloat(getComputedStyle(c).opacity || "1");
    }
    return o;
  };

  const docRect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  };

  const sig = (el) => {
    let s = "";
    for (let c = el, i = 0; c && i < 3; c = c.parentElement, i++) {
      const cs = getComputedStyle(c);
      for (const p of SIG_PROPS) s += cs.getPropertyValue(p) + "|";
    }
    s += (el.innerText || "").slice(0, 200) + "|";
    s += ["aria-pressed", "aria-expanded", "aria-busy", "aria-checked", "disabled", "class"]
      .map((a) => el.getAttribute(a)).join(",");
    if (el.type === "checkbox" || el.type === "radio") s += "|" + el.checked;
    return s;
  };

  const runningAnimations = () => {
    const set = new Set();
    const list = document.getAnimations();
    for (const a of list) {
      if (a.playState === "running" || a.pending) {
        const t = a.effect && a.effect.target;
        if (t) set.add(t);
      }
    }
    return { set, list };
  };

  const chainAnimated = (el, set) => {
    for (let c = el; c; c = c.parentElement) if (set.has(c)) return true;
    return false;
  };
  const subtreeAnimated = (el, set) => {
    if (chainAnimated(el, set)) return true;
    for (const t of set) if (el.contains(t)) return true;
    return false;
  };

  const visibleLines = () => {
    const txt = (document.body && document.body.innerText) || "";
    return new Set(txt.split("\n").map((s) => s.trim()).filter(Boolean));
  };

  const easingOf = (a) => {
    const timing = a.effect.getTiming();
    let easing = timing.easing || "linear";
    if (easing === "linear") {
      try {
        const kf = a.effect.getKeyframes();
        if (kf.length && kf[0].easing && kf[0].easing !== "linear") easing = kf[0].easing;
      } catch (e) { /* ignore */ }
    }
    return easing;
  };

  // ---------- mutation tracking ----------
  const onMutations = (list) => {
    if (!fc.armed) return;
    for (const m of list) {
      const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (!target) continue;
      if (fc.baseline) { fc.ambientMut.add(target); continue; }
      let ambient = false;
      for (const a of fc.ambientMut) if (a.contains(target)) { ambient = true; break; }
      if (ambient) continue;
      fc.mutTargets.add(target);
      if (m.type === "attributes") {
        fc.candidates.add(target);
        if (visible(target)) fc.mutFlag = true;
      } else if (m.type === "childList") {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) { fc.candidates.add(n); if (visible(n)) fc.mutFlag = true; }
          else if (n.nodeType === 3 && visible(target)) fc.mutFlag = true;
        }
        if (m.removedNodes.length) {
          fc.swapParents.add(target);
          if (visible(target)) fc.mutFlag = true;
        }
      } else if (m.type === "characterData") {
        if (visible(target)) fc.mutFlag = true;
      }
    }
  };
  let observer = null;
  const ensureObserver = () => {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
  };

  // ---------- input timestamps ----------
  addEventListener("pointerdown", (e) => { if (fc.armed && fc.downAt == null) fc.downAt = e.timeStamp; }, true);
  addEventListener("pointerup", (e) => { if (fc.armed && fc.upAt == null) fc.upAt = e.timeStamp; }, true);
  addEventListener("click", (e) => { if (fc.armed && fc.clickAt == null) fc.clickAt = e.timeStamp; }, true);
  addEventListener("scroll", () => { if (fc.armed && !fc.baseline) fc.scrollEvt = true; }, true);

  // ---------- frame loop ----------
  const frame = (t) => {
    fc.frame++;
    const { set: anim, list } = runningAnimations();
    let changed = false;
    const reasons = [];

    // scrolling: the window or any inner scroller (scroll events are seen in the capture phase)
    let scrolled = false;
    if (scrollX !== fc.lastSX || scrollY !== fc.lastSY || fc.scrollEvt) {
      fc.lastSX = scrollX; fc.lastSY = scrollY;
      fc.scrollEvt = false;
      scrolled = true;
      if (!fc.baseline) { changed = true; reasons.push("scroll"); fc.lastScrollT = t; }
    }
    if (!fc.baseline) fc.scrollFrames.push(scrolled);

    // new animations (inventory + change signal)
    for (const a of list) {
      if (fc.seenAnims.has(a)) continue;
      fc.seenAnims.add(a);
      const tgt = a.effect && a.effect.target;
      if (!tgt) continue;
      if (fc.baseline || fc.ambientAnimTargets.has(tgt)) { fc.ambientAnimTargets.add(tgt); continue; }
      const timing = a.effect.getTiming();
      let props = [];
      try {
        props = Array.from(new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k))))
          .filter((k) => !IGNORE_KF.has(k))
          .map((k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));
      } catch (e) { /* ignore */ }
      if (a.transitionProperty && !props.includes(a.transitionProperty)) props.push(a.transitionProperty);
      const dur = typeof timing.duration === "number" ? timing.duration : 0;
      const tcs = getComputedStyle(tgt);
      const tProps = tcs.transitionProperty.split(",").map((x) => x.trim());
      const tDurs = tcs.transitionDuration.split(",").map((x) => parseFloat(x) * (x.trim().endsWith("ms") ? 1 : 1000));
      const durAt = (i) => tDurs[i % tDurs.length] || 0;
      const transitionAll = tProps.some((p, i) => p === "all" && durAt(i) > 0);
      let declared = isFinite(dur) ? dur : -1;
      if (a.transitionProperty) {
        const i = tProps.indexOf(a.transitionProperty);
        const j = i >= 0 ? i : tProps.indexOf("all");
        if (j >= 0) declared = durAt(j);
      }
      fc.anims.push({
        el: tgt,
        rec: {
          kind: a.constructor ? a.constructor.name : "Animation",
          name: a.animationName || null,
          prop: a.transitionProperty || null,
          target: describe(tgt),
          duration: isFinite(dur) ? dur : -1,
          delay: timing.delay || 0,
          iterations: isFinite(timing.iterations) ? timing.iterations : -1,
          easing: easingOf(a),
          props,
          computedTransitionProperty: tcs.transitionProperty,
          transitionAll,
          declaredDuration: declared,
          enter: false,
          afterScroll: fc.lastScrollT != null,
          t,
        },
      });
      if (!fc.baseline) { changed = true; reasons.push("animation"); }
    }

    // target style / text / state
    if (fc.target && fc.target.isConnected) {
      const s = sig(fc.target);
      if (s !== fc.lastSig) {
        fc.lastSig = s;
        if (fc.baseline) fc.targetAmbient = true;
        else if (!fc.targetAmbient) { changed = true; reasons.push("target"); }
      }
    }
    if (location.href !== fc.lastHref) { fc.lastHref = location.href; changed = true; reasons.push("url"); }

    if (fc.mutFlag) { fc.mutFlag = false; changed = true; reasons.push("dom"); }

    // tracked element geometry
    let layoutChanged = false;
    for (const rec of fc.tracked) {
      const el = rec.el;
      if (!el.isConnected) {
        // A removed element counts as shrinking to nothing, so whatever it pushed is reflow, not a teleport.
        rec.hist.push(rec.gone ? { m: 0, rs: false, a: false } : { m: 0, rs: true, dh: -rec.r.h, dw: -rec.r.w, a: false });
        rec.gone = true;
        continue;
      }
      const r = docRect(el);
      const dx = r.x - rec.r.x, dy = r.y - rec.r.y;
      const dw = r.w - rec.r.w, dh = r.h - rec.r.h;
      const m = Math.hypot(dx, dy);
      const rs = Math.abs(dw) > 0.5 || Math.abs(dh) > 0.5;
      const a = chainAnimated(el, anim);
      if (m > 0.5 || rs) {
        if (fc.baseline) rec.ambient = true;
        else if (!rec.ambient) layoutChanged = true;
      }
      rec.hist.push({ m, dx, dy, rs, dh, dw, a, from: rec.r, to: r, t });
      rec.r = r;
    }
    if (layoutChanged) { changed = true; reasons.push("layout"); }

    // appearing elements (pop candidates)
    if (!fc.baseline) {
      for (const el of fc.candidates) {
        if (fc.appearedSeen.has(el)) continue;
        if (fc.visibleAtStart.has(el) || !visible(el)) continue;
        let root = el;
        while (root.parentElement && root.parentElement !== document.body &&
               !fc.visibleAtStart.has(root.parentElement)) root = root.parentElement;
        if (fc.appearedSeen.has(root)) { fc.appearedSeen.add(el); continue; }
        fc.appearedSeen.add(el); fc.appearedSeen.add(root);
        // Content swapped into a container that just lost children (a chart redraw, a list refresh)
        // and shapes inside an SVG are redraws, not new surfaces.
        if (fc.ambientEls.has(root)) continue;
        const swap = !!(root.parentElement && fc.swapParents.has(root.parentElement));
        const inSvg = !!root.ownerSVGElement;
        fc.appears.push({ el: root, frame: fc.frame, t, states: [], swap, inSvg });
        changed = true; reasons.push("appear");
      }
      for (const ap of fc.appears) {
        if (ap.states.length >= 4) continue;
        const el = ap.el;
        ap.states.push({
          r: el.isConnected ? docRect(el) : null,
          o: el.isConnected ? effOpacity(el) : 0,
          a: el.isConnected ? subtreeAnimated(el, anim) : false,
        });
      }
    }

    // rAF's timestamp is the frame's start, which can be earlier than events handled in the same frame.
    // So time the change with performance.now(), and call it press feedback only if the pointer was
    // still down when this frame ran.
    if (changed && !fc.baseline && fc.downAt != null && fc.firstChangeAt == null) {
      fc.firstChangeAt = performance.now();
      fc.changeWhileDown = fc.upAt == null;
      fc.firstChangeReasons = Array.from(new Set(reasons));
    }
  };

  const loop = (t) => {
    if (!fc.armed) return;
    try { frame(t); } catch (e) { fc.err = String(e && e.stack || e); }
    fc.raf = requestAnimationFrame(loop);
  };

  // ---------- public API ----------
  fc.arm = (target, ambientCss) => {
    ensureObserver();
    fc.ambientEls = new Set();
    for (const sel of ambientCss || []) {
      try { for (const el of document.querySelectorAll(sel)) fc.ambientEls.add(el); } catch (e) { /* bad selector */ }
    }
    fc.mutTargets = new Set();
    fc.armed = true;
    fc.baseline = true;
    fc.target = target || null;
    fc.downAt = null; fc.upAt = null; fc.clickAt = null;
    fc.firstChangeAt = null; fc.firstChangeReasons = []; fc.changeWhileDown = false;
    fc.frame = 0;
    fc.mutFlag = false;
    fc.ambientMut = new Set(fc.ambientEls);
    fc.ambientAnimTargets = new Set(fc.ambientEls);
    fc.targetAmbient = false;
    fc.candidates = new Set();
    fc.swapParents = new Set();
    fc.scrollFrames = [];
    fc.lastScrollT = null;
    fc.scrollEvt = false;
    fc.appearedSeen = new Set();
    fc.appears = [];
    fc.anims = [];
    fc.seenAnims = new WeakSet();
    for (const a of document.getAnimations()) fc.seenAnims.add(a);
    fc.lastSig = target ? sig(target) : "";
    fc.lastHref = location.href;
    fc.lastSX = scrollX; fc.lastSY = scrollY;
    fc.startLines = visibleLines();
    fc.armSig = fc.lastSig;
    fc.startVisibleCount = 0;
    fc.visibleAtStart = new WeakSet();
    fc.tracked = [];
    const all = document.body ? document.body.getElementsByTagName("*") : [];
    for (const el of all) {
      if (!visible(el)) continue;
      fc.startVisibleCount++;
      fc.visibleAtStart.add(el);
      if (fc.tracked.length < MAX_TRACKED) fc.tracked.push({ el, r: docRect(el), hist: [], ambient: fc.ambientEls.has(el) });
    }
    fc.visibleAtStart.add(document.body);
    fc.raf = requestAnimationFrame(loop);
    return true;
  };

  // Called by the runner right before the press: ends the baseline period.
  fc.go = () => {
    fc.baseline = false;
    for (const rec of fc.tracked) rec.hist = [];
    fc.scrollFrames = [];
    fc.swapParents = new Set();
    fc.frameAtGo = fc.frame;
    return true;
  };

  fc.disarm = () => {
    fc.armed = false;
    cancelAnimationFrame(fc.raf);
    const vw = innerWidth, vh = innerHeight;
    const inputRef = fc.clickAt != null ? fc.clickAt : fc.upAt;

    // teleports: one big jump, stable before and after, no running animation, no reflow above
    const jumpsByFrame = new Map();
    for (const rec of fc.tracked) {
      const h = rec.hist;
      for (let k = 0; k < h.length; k++) {
        const f = h[k];
        if (!(f.m > JUMP_PX) || f.a || rec.ambient || fc.scrollFrames[k]) continue;
        if (rec.el.ownerSVGElement) continue; // shapes inside an SVG are drawn, not moved
        const before = k === 0 ? 0 : h[k - 1].m;
        const after1 = k + 1 < h.length ? h[k + 1].m : 0;
        const after2 = k + 2 < h.length ? h[k + 2].m : 0;
        if (before > 1 || after1 > 1 || after2 > 1) continue;
        if (!jumpsByFrame.has(k)) jumpsByFrame.set(k, []);
        jumpsByFrame.get(k).push({ rec, f });
      }
    }
    const teleports = [];
    const resizedAt = (el, k) => {
      const rec = fc.tracked.find((r) => r.el === el);
      return rec && rec.hist[k] && rec.hist[k].rs;
    };
    for (const [k, jumps] of jumpsByFrame) {
      const els = new Set(jumps.map((j) => j.rec.el));
      for (const j of jumps) {
        const el = j.rec.el;
        let skip = false;
        // keep only the top-most element of a group that moved together
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (els.has(p)) { skip = true; break; }
        }
        // reflow: an ancestor changed size in the same frame
        let p = el.parentElement;
        for (let i = 0; p && i < 3 && !skip; i++, p = p.parentElement) if (resizedAt(p, k)) skip = true;
        // reflow: pushed down or up by something earlier in the page that grew or shrank by the same amount
        const vertical = Math.abs(j.f.dx) < 1, horizontal = Math.abs(j.f.dy) < 1;
        if (!skip && (vertical || horizontal)) {
          for (const other of fc.tracked) {
            const o = other.hist[k];
            if (!o || !o.rs || other.el === el || other.el.contains(el) || el.contains(other.el)) continue;
            if (vertical && (other.el.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) &&
                Math.abs(o.dh - j.f.dy) <= 2) { skip = true; break; }
            // a neighbour in the same row got wider or narrower (text changed, a badge appeared)
            if (horizontal && other.el.parentElement && other.el.parentElement.contains(el) &&
                Math.abs(Math.abs(o.dw) - Math.abs(j.f.dx)) <= 2) { skip = true; break; }
          }
          // something new was inserted above it in the same frame, about as tall as the jump
          for (const ap of fc.appears) {
            const ak = ap.frame - (fc.frameAtGo || 0) - 1; // appear frame on the same index as hist
            if (skip || !vertical || Math.abs(ak - k) > 1) continue;
            const r0 = ap.states[0] && ap.states[0].r;
            if (r0 && (ap.el.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) &&
                Math.abs(Math.abs(r0.h) - Math.abs(j.f.dy)) <= 24) skip = true;
          }
        }
        if (skip) continue;
        teleports.push({
          el: describe(el), frame: k, t: j.f.t, dx: Math.round(j.f.dx), dy: Math.round(j.f.dy),
          from: j.f.from, to: j.f.to,
        });
      }
    }

    // pops: something sizable appears fully formed soon after the input, with no animation
    const pops = [];
    for (const ap of fc.appears) {
      const s0 = ap.states[0];
      if (!s0 || !s0.r) continue;
      const share = (s0.r.w * s0.r.h) / (vw * vh);
      const since = inputRef != null ? ap.t - inputRef : 0;
      const animated = ap.states.slice(0, 3).some((s) => s.a);
      let stable = true;
      for (let i = 1; i < Math.min(3, ap.states.length); i++) {
        const s = ap.states[i];
        if (!s.r || Math.abs(s.r.w - s0.r.w) > 1 || Math.abs(s.r.h - s0.r.h) > 1 ||
            Math.abs(s.r.x - s0.r.x) > 1 || Math.abs(s.r.y - s0.r.y) > 1 || Math.abs(s.o - s0.o) > 0.02) stable = false;
      }
      if (share > POP_SHARE && s0.o >= 0.9 && !animated && stable && since <= 150 && !ap.swap && !ap.inSvg) {
        pops.push({ el: describe(ap.el), frame: ap.frame, t: ap.t, rect: s0.r, areaShare: share, opacity: s0.o, sinceInputMs: Math.round(since) });
      }
    }

    // animations: mark entrances
    const animations = fc.anims.map(({ el, rec }) => {
      rec.enter = fc.appears.some((ap) => ap.el === el || ap.el.contains(el));
      return rec;
    });

    return {
      downAt: fc.downAt, upAt: fc.upAt, clickAt: fc.clickAt,
      firstChangeAt: fc.firstChangeAt, firstChangeReasons: fc.firstChangeReasons,
      changeWhileDown: !!fc.changeWhileDown,
      frames: fc.frame - (fc.frameAtGo || 0),
      teleports, pops, animations,
      errorUi: null,
      viewport: { w: vw, h: vh },
      err: fc.err || null,
    };
  };

  // After an idle window (armed, no input): which elements change on their own?
  fc.ambientReport = () => {
    const out = new Set();
    for (const rec of fc.tracked) if (rec.hist.some((h) => h.m > 0.5 || h.rs)) out.add(cssPath(rec.el));
    for (const el of fc.mutTargets) if (el.isConnected) out.add(cssPath(el));
    for (const { el } of fc.anims) if (el.isConnected) out.add(cssPath(el));
    for (const ap of fc.appears) if (ap.el.isConnected) out.add(cssPath(ap.el));
    return Array.from(out).slice(0, 300);
  };

  // Is the screen different from just before the press? Used while a request is held:
  // a press style that reverts on release does not count, a spinner or "Saving..." does.
  fc.stateChanged = () => {
    const lines = visibleLines();
    let textChanged = lines.size !== fc.startLines.size;
    if (!textChanged) for (const l of lines) if (!fc.startLines.has(l)) { textChanged = true; break; }
    const targetChanged = !!(fc.target && fc.target.isConnected && sig(fc.target) !== fc.armSig);
    let visibleCount = 0;
    for (const el of document.body.getElementsByTagName("*")) if (visible(el)) visibleCount++;
    const busy = Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')).some(visible);
    return { changed: textChanged || targetChanged || visibleCount !== fc.startVisibleCount || busy, textChanged, targetChanged, busy };
  };

  // After a failed request: did any error UI appear, or did the content go blank?
  fc.errorScan = () => {
    const now = visibleLines();
    const added = [];
    for (const l of now) if (!fc.startLines.has(l)) added.push(l);
    const re = /(error|fail|couldn.?t|could not|try again|went wrong|unable|problem|offline|retry)/i;
    let found = added.some((l) => re.test(l));
    for (const el of document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-invalid="true"]')) {
      if (visible(el) && (el.getAttribute("aria-invalid") === "true" || (el.innerText || "").trim())) found = true;
    }
    let lost = 0;
    for (const l of fc.startLines) if (!now.has(l)) lost++;
    const blank = fc.startLines.size > 0 && lost / fc.startLines.size > 0.5;
    return { found, newText: added.slice(0, 10), blank };
  };

  // Motion inventory from stylesheets (same-origin only).
  fc.styleInventory = () => {
    const durations = {}, easings = {};
    let reducedQuery = false;
    const splitList = (v) => (v || "").split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
    const toMs = (v) => (v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000);
    const walk = (rules) => {
      for (const r of rules) {
        if (r.media && /prefers-reduced-motion/.test(r.media.mediaText)) reducedQuery = true;
        if (r.conditionText && /prefers-reduced-motion/.test(r.conditionText)) reducedQuery = true;
        if (r.cssRules && !r.style) { walk(r.cssRules); continue; }
        if (!r.style) continue;
        const s = r.style;
        // Looping animations (spinners, shimmer) are not UI transitions; leave them out of the count.
        const loops = /infinite/.test(s.animationIterationCount || "");
        for (const d of [...splitList(s.transitionDuration), ...(loops ? [] : splitList(s.animationDuration))]) {
          const ms = toMs(d);
          if (ms > 0 && isFinite(ms)) durations[ms] = (durations[ms] || 0) + 1;
        }
        for (const e of [...splitList(s.transitionTimingFunction), ...(loops ? [] : splitList(s.animationTimingFunction))]) {
          // var(--token) references are the goal, not sprawl; their resolved values show up at runtime.
          if (e && e !== "initial" && e !== "inherit" && !e.includes("var(")) easings[e] = (easings[e] || 0) + 1;
        }
        if (r.cssRules && r.cssRules.length) walk(r.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules); } catch (e) { /* cross-origin */ }
    }
    return { durations, easings, reducedQuery };
  };

  // Interactive targets for discovery.
  fc.discover = (include, exclude) => {
    const out = [];
    const nodes = Array.from(document.querySelectorAll(include));
    for (const el of nodes) {
      if (!visible(el)) continue;
      if (el.closest("[data-kymo-ignore]")) continue;
      if (exclude.some((sel) => { try { return el.matches(sel) || el.closest(sel); } catch (e) { return false; } })) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      if (el.tagName === "A") {
        const href = el.getAttribute("href") || "";
        if (href && !href.startsWith("#")) continue; // v0: skip navigation links
      }
      const d = describe(el);
      out.push({ id: d.id, testid: d.testid, role: d.role, name: d.text, css: d.css, text: d.text, group: d.group });
    }
    return out;
  };

  // Signals for motion-profile inference.
  fc.profileSignals = () => {
    const vw = innerWidth, vh = innerHeight;
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && r.width > 0 && r.height > 0; };
    // Links are left out: every landing page has a nav full of them, which says nothing about density.
    const controls = Array.from(document.querySelectorAll('button, [role="button"], input, select, textarea, [role="tab"], [role="switch"], [role="slider"]')).filter((el) => visible(el) && inView(el)).length;
    const tables = document.querySelectorAll('table, [role="grid"], [role="table"]').length;
    const bodyText = ((document.body && document.body.innerText) || "").length || 1;
    let prose = 0, longBlocks = 0;
    // Prose means real paragraphs; one-line captions and card blurbs do not count.
    for (const p of document.querySelectorAll("p, li, blockquote")) {
      const n = (p.innerText || "").length;
      if (n >= 120) prose += n;
      if (n > 280) longBlocks++;
    }
    let imageArea = 0;
    for (const m of document.querySelectorAll("img, video, picture, canvas, svg")) {
      if (!inView(m)) continue;
      const r = m.getBoundingClientRect();
      if (r.width * r.height > 0.05 * vw * vh) imageArea += r.width * r.height;
    }
    let hero = false;
    const h1 = document.querySelector("h1");
    if (h1) {
      let block = h1.parentElement;
      while (block && block.parentElement && block.parentElement !== document.body && block.getBoundingClientRect().height < 0.6 * vh) block = block.parentElement;
      if (block && block.getBoundingClientRect().height >= 0.6 * vh && block.getBoundingClientRect().top < 0.2 * vh && (block.innerText || "").length < 600) hero = true;
    }
    let displayHeading = false;
    for (const h of document.querySelectorAll("h1, h2")) {
      if (inView(h) && parseFloat(getComputedStyle(h).fontSize) >= 40) displayHeading = true;
    }
    const family = getComputedStyle(document.body).fontFamily.toLowerCase();
    const serif = /serif/.test(family) && !/sans-serif/.test(family);
    let touchAction = false;
    for (const sheet of document.styleSheets) {
      // "manipulation" only removes the tap delay; none / pan-x / pan-y mark real drag surfaces.
      try { for (const r of sheet.cssRules) if (r.style && /^(none|pan-x|pan-y|pinch-zoom)/.test(r.style.touchAction || "")) touchAction = true; } catch (e) { /* ignore */ }
    }
    const draggable = document.querySelectorAll('[draggable="true"]').length;
    return {
      controlsInView: controls, tables, proseShare: Math.min(1, prose / bodyText), longBlocks,
      imageShare: Math.min(1, imageArea / (vw * vh)), hero, displayHeading, serif, touchAction, draggable,
    };
  };
})();
