// In-page instrument for kymo. Injected with page.addInitScript before any app code runs.
// Plain JavaScript on purpose: it is serialized into the page, so it must not depend on build helpers.
// It watches one interaction at a time: arm() before the input, go() right before it, disarm() after.
(() => {
  if (window.__fc) return;

  const CFG = window.__fcConfig || {};
  const GROUP_ATTR = CFG.groupAttribute || "data-kymo-group";
  const JUMP_PX = CFG.jumpPx || 24; // teleport threshold (researcher proposal, see rule MOT-09)
  const POP_SHARE = CFG.popShare || 0.02; // pop and vanish threshold: share of viewport area
  const INCLUDE = CFG.include || "button, [role=button]";
  let SKIP_NAMES = null;
  try { SKIP_NAMES = CFG.skipNames ? new RegExp(CFG.skipNames, "i") : null; } catch (e) { SKIP_NAMES = null; }
  const MAX_TRACKED = 1500;
  const SIG_PROPS = [
    "background-color", "color", "transform", "opacity", "box-shadow", "border-top-color",
    "outline-style", "outline-color", "scale", "translate", "filter", "text-decoration-line",
  ];
  const FOCUS_PROPS = [
    "outline-style", "outline-width", "outline-color", "outline-offset", "box-shadow", "border-top-color",
    "border-bottom-color", "border-top-width", "background-color", "color", "text-decoration-line", "transform",
  ];
  const IGNORE_KF = new Set(["offset", "computedOffset", "easing", "composite"]);
  const DIALOG_SEL = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const TABBABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable="true"]';

  const fc = { armed: false, shifts: [], loafs: [] };
  window.__fc = fc;

  // ---------- always-on observers: layout shifts and long animation frames ----------
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        let src = null, best = 0;
        for (const s of e.sources || []) {
          const r = s.currentRect || {};
          const area = (r.width || 0) * (r.height || 0);
          if (s.node && s.node.nodeType === 1 && area >= best) { best = area; src = s.node; }
          else if (s.node && s.node.nodeType === 3 && s.node.parentElement && area >= best) { best = area; src = s.node.parentElement; }
        }
        fc.shifts.push({ t: e.startTime, value: e.value, src });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch (e) { /* unsupported */ }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const scripts = e.scripts || [];
        fc.loafs.push({
          start: e.startTime,
          duration: e.duration,
          blocking: e.blockingDuration || 0,
          // where the time went: script, or style and layout (the rest is waiting to be scheduled)
          script: scripts.reduce((n, sc) => n + (sc.duration || 0), 0),
          render: e.styleAndLayoutStart ? Math.max(0, e.startTime + e.duration - e.styleAndLayoutStart) : 0,
          scripts: (e.scripts || []).map((s) => ({
            url: s.sourceURL || "", fn: s.sourceFunctionName || "", invoker: s.invoker || "",
            charPos: s.sourceCharPosition == null ? -1 : s.sourceCharPosition, duration: s.duration,
          })),
        });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch (e) { /* unsupported */ }

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
  fc.cssPath = cssPath;

  const implicitRole = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "textarea") return "textbox";
    if (tag === "dialog") return "dialog";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "button" || t === "submit" || t === "reset") return "button";
      if (["text", "email", "search", "url", "tel", "password"].includes(t)) return t === "search" ? "searchbox" : "textbox";
      if (t === "number") return "spinbutton";
    }
    return null;
  };

  const accName = (el) => {
    const label = el.getAttribute("aria-label");
    if (label) return label;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.innerText).join(" ");
      if (t.trim()) return t;
    }
    if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => l.innerText).join(" ");
    if (el.getAttribute("placeholder")) return el.getAttribute("placeholder");
    return el.innerText || el.textContent || el.getAttribute("title") || "";
  };

  const describe = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const groupEl = el.closest("[" + GROUP_ATTR + "]");
    const srcEl = el.closest("[data-kymo-src]");
    // Containers are named by their heading ("section 'Pricing'"), not by all the text inside them.
    let name = accName(el);
    if (!el.getAttribute("aria-label") && !el.getAttribute("role") && /^(section|article|header|footer|main|aside|div|form|nav)$/i.test(el.tagName)) {
      const h = el.querySelector("h1, h2, h3, h4, legend");
      if (h && (h.innerText || "").trim()) name = h.innerText;
    }
    const text = name.trim().replace(/\s+/g, " ").slice(0, 60);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      testid: el.getAttribute("data-testid"),
      group: groupEl ? groupEl.getAttribute(GROUP_ATTR) : null,
      text,
      css: cssPath(el),
      role: implicitRole(el),
      src: srcEl ? srcEl.getAttribute("data-kymo-src") : null,
    };
  };
  fc.describe = describe;

  const locator = (el) => {
    const d = describe(el);
    return { id: d.id || undefined, testid: d.testid || undefined, role: d.role || undefined, name: d.text || undefined, css: d.css, text: d.text, group: d.group };
  };

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: false })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  fc.visible = visible;

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
    s += ["aria-pressed", "aria-expanded", "aria-busy", "aria-checked", "aria-invalid", "disabled", "class"]
      .map((a) => el.getAttribute(a)).join(",");
    if (el.type === "checkbox" || el.type === "radio") s += "|" + el.checked;
    if ("value" in el && typeof el.value === "string") s += "|v:" + el.value;
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

  const isControl = (el) => {
    try { return el.matches(INCLUDE); } catch (e) { return false; }
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
          if (n.nodeType === 1) { fc.candidates.add(n); fc.gainParents.add(target); if (visible(n)) fc.mutFlag = true; }
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

  // ---------- input timestamps (pointer, then keyboard for typing and dialogs) ----------
  addEventListener("pointerdown", (e) => { if (fc.armed && !fc.baseline && fc.downAt == null) fc.downAt = e.timeStamp; }, true);
  addEventListener("pointerup", (e) => { if (fc.armed && !fc.baseline && fc.upAt == null) fc.upAt = e.timeStamp; }, true);
  addEventListener("click", (e) => { if (fc.armed && !fc.baseline && fc.clickAt == null) fc.clickAt = e.timeStamp; }, true);
  addEventListener("keydown", (e) => { if (fc.armed && !fc.baseline && fc.downAt == null) fc.downAt = e.timeStamp; }, true);
  addEventListener("keyup", (e) => { if (fc.armed && !fc.baseline && fc.upAt == null) fc.upAt = e.timeStamp; }, true);
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
      // An element that also moves on its own (seen in the idle watch) still gets its animation judged
      // when the animation starts right after the input: that one was caused by the press. It never
      // counts as the press's feedback, though, since it might have happened anyway.
      let idleAmbient = false;
      for (const amb of fc.ambientEls) if (amb === tgt || amb.contains(tgt)) { idleAmbient = true; break; }
      if (idleAmbient) {
        const since = fc.downAt != null ? performance.now() - fc.downAt : -1;
        if (since < 0 || since > 250) { fc.ambientAnimTargets.add(tgt); continue; }
      }
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
      if (!fc.baseline && !idleAmbient) { changed = true; reasons.push("animation"); }
    }

    // target style / text / value / state
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
        if (fc.baseline) rec.ambient = true; // went away on its own before the input
        // A removed element counts as shrinking to nothing, so whatever it pushed is reflow, not a teleport.
        rec.hist.push(rec.gone ? { m: 0, rs: false, a: false, gone: true, t } : { m: 0, rs: true, dh: -rec.r.h, dw: -rec.r.w, a: false, gone: true, t });
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
      rec.hist.push({ m, dx, dy, rs, dh, dw, a, from: rec.r, to: r, t, gone: r.w === 0 && r.h === 0 });
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
    fc.err = null;
    fc.ambientMut = new Set(fc.ambientEls);
    fc.ambientAnimTargets = new Set();
    fc.targetAmbient = false;
    fc.candidates = new Set();
    fc.swapParents = new Set();
    fc.gainParents = new Set();
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
    fc.dialogsAtStart = new Set(Array.from(document.querySelectorAll(DIALOG_SEL)).filter(visible));
    fc.tracked = [];
    const all = document.body ? document.body.getElementsByTagName("*") : [];
    for (const el of all) {
      if (!visible(el)) continue;
      fc.startVisibleCount++;
      fc.visibleAtStart.add(el);
      if (fc.tracked.length < MAX_TRACKED) {
        // idx is tree order (getElementsByTagName walks the document in order), which stays valid after removal
        fc.tracked.push({ el, parent: el.parentElement, inSvg: !!el.ownerSVGElement, idx: fc.tracked.length, r: docRect(el), hist: [], ambient: fc.ambientEls.has(el), area0: 0 });
      }
    }
    fc.visibleAtStart.add(document.body);
    // Large elements are described now: if one is removed, a detached node no longer knows its group or path.
    const bigArea = POP_SHARE * innerWidth * innerHeight;
    for (const rec of fc.tracked) {
      rec.area0 = rec.r.w * rec.r.h;
      if (rec.area0 > bigArea) rec.desc = describe(rec.el);
    }
    fc.raf = requestAnimationFrame(loop);
    return true;
  };

  // Called by the runner right before the input: ends the baseline period.
  fc.go = () => {
    fc.baseline = false;
    for (const rec of fc.tracked) rec.hist = [];
    fc.scrollFrames = [];
    fc.swapParents = new Set();
    fc.gainParents = new Set();
    fc.frameAtGo = fc.frame;
    fc.goAt = performance.now();
    return true;
  };

  fc.disarm = () => {
    fc.armed = false;
    cancelAnimationFrame(fc.raf);
    const vw = innerWidth, vh = innerHeight;
    const inputRef = fc.clickAt != null ? fc.clickAt : (fc.upAt != null ? fc.upAt : fc.downAt);

    // teleports: one big jump, stable before and after, no running animation, no reflow above
    const jumpsByFrame = new Map();
    for (const rec of fc.tracked) {
      const h = rec.hist;
      for (let k = 0; k < h.length; k++) {
        const f = h[k];
        if (!(f.m > JUMP_PX) || f.a || rec.ambient || fc.scrollFrames[k]) continue;
        // hidden (display: none) or shown from hidden: a size of zero on either side is not a move
        if (f.gone || (f.from && f.from.w === 0 && f.from.h === 0) || (k > 0 && h[k - 1].gone)) continue;
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
    const byEl = new Map(fc.tracked.map((r) => [r.el, r]));
    const resizedAt = (el, k) => {
      const rec = byEl.get(el);
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
            if (vertical && other.idx < j.rec.idx &&
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

    // vanishes: something sizable disappears in one frame with no exit animation, and stays gone
    const vanishCands = [];
    for (const rec of fc.tracked) {
      if (rec.ambient || rec.area0 / (vw * vh) <= POP_SHARE) continue;
      const h = rec.hist;
      const k = h.findIndex((f) => f.gone);
      if (k < 0 || !h.slice(k).every((f) => f.gone)) continue; // never left, or came back (a re-render)
      if (h.slice(0, k + 1).some((f) => f.a)) continue; // it had an exit animation
      const parent = rec.parent; // the live parentElement is null once the node is removed
      if (parent && fc.gainParents.has(parent)) continue; // replaced by new content: a swap, not an exit
      let inAmbient = false;
      for (let p = parent; p && !inAmbient; p = p.parentElement) if (fc.ambientEls.has(p)) inAmbient = true;
      if (inAmbient) continue; // a carousel or ticker replacing its own slides
      if (rec.inSvg) continue; // shapes in a chart are redrawn, not dismissed (a detached node no longer knows its SVG)
      const t = rec.hist[k].t || 0;
      const since = inputRef != null ? t - inputRef : -1;
      if (since < 0 || since > 600) continue; // a dismissal starts with the input; later removals are async updates
      vanishCands.push({ rec, k });
    }
    const vanishEls = new Set(vanishCands.map((v) => v.rec.el));
    const vanishes = [];
    for (const { rec, k } of vanishCands) {
      let nested = false;
      for (let p = rec.el.parentElement; p; p = p.parentElement) if (vanishEls.has(p)) { nested = true; break; }
      if (nested) continue;
      const t = rec.hist[k].t || 0;
      vanishes.push({ el: rec.desc || describe(rec.el), t, areaShare: rec.area0 / (vw * vh), sinceInputMs: inputRef != null ? Math.round(t - inputRef) : 0 });
    }

    // animations: mark entrances
    const animations = fc.anims.map(({ el, rec }) => {
      rec.enter = fc.appears.some((ap) => ap.el === el || ap.el.contains(el));
      return rec;
    });

    // controls that became visible (a dialog's buttons, a menu's items)
    const newControls = [];
    for (const el of document.querySelectorAll(INCLUDE)) {
      if (fc.visibleAtStart.has(el) || !visible(el) || el.disabled) continue;
      if (SKIP_NAMES && SKIP_NAMES.test(accName(el).trim().replace(/\s+/g, " "))) continue;
      if (el.tagName === "A" && (el.getAttribute("href") || "").match(/^(?!#)/) && el.getAttribute("href")) continue;
      newControls.push(locator(el));
      if (newControls.length >= 12) break;
    }

    // a dialog that opened
    let dialog = null;
    for (const d of document.querySelectorAll(DIALOG_SEL)) {
      if (visible(d) && !fc.dialogsAtStart.has(d)) { dialog = describe(d); break; }
    }

    const t0 = fc.goAt || 0;
    const longFrames = fc.loafs.filter((l) => l.start + l.duration >= t0);

    return {
      downAt: fc.downAt, upAt: fc.upAt, clickAt: fc.clickAt,
      firstChangeAt: fc.firstChangeAt, firstChangeReasons: fc.firstChangeReasons,
      changeWhileDown: !!fc.changeWhileDown,
      frames: fc.frame - (fc.frameAtGo || 0),
      teleports, pops, vanishes, animations, longFrames, newControls, dialog,
      goAt: fc.goAt || 0,
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

  // After typing one character: did the field already complain?
  fc.earlyErrorScan = (field) => {
    if (field.getAttribute("aria-invalid") === "true") return { earlyError: true, errorText: "aria-invalid" };
    const now = visibleLines();
    const re = /(invalid|error|required|must|valid|please enter|not a|too short|incorrect)/i;
    for (const l of now) if (!fc.startLines.has(l) && re.test(l)) return { earlyError: true, errorText: l.slice(0, 80) };
    for (const el of document.querySelectorAll('[role="alert"]')) {
      const txt = (el.innerText || "").trim();
      if (visible(el) && txt && !fc.startLines.has(txt)) return { earlyError: true, errorText: txt.slice(0, 80) };
    }
    return { earlyError: false, errorText: null };
  };

  // ---------- hover: what moves or appears when the pointer arrives ----------
  // The layout box ignores transforms, so a hover that scales or lifts a neighbour on purpose
  // does not count as a shift; only real reflow (size, margin, border, font weight) does.
  const layoutBox = (el) => {
    if (!(el instanceof HTMLElement) || getComputedStyle(el).position === "fixed") return null;
    return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight, parent: el.offsetParent };
  };
  fc.hoverSnap = (target, ambientCss) => {
    const scope = (target.parentElement && target.parentElement.parentElement) || target.parentElement || document.body;
    const ambient = [];
    for (const css of ambientCss || []) { try { const a = document.querySelector(css); if (a) ambient.push(a); } catch (e) { /* bad selector */ } }
    const nearAmbient = (el) => ambient.some((a) => a === el || a.contains(el) || el.contains(a));
    const els = [];
    for (const el of scope.getElementsByTagName("*")) {
      if (target.contains(el) || el === target) continue;
      if (!visible(el) || nearAmbient(el)) continue;
      els.push(el);
      if (els.length > 300) break;
    }
    fc.hover = {
      target,
      ambient,
      rects: els.map((el) => ({ el, r: layoutBox(el) })),
      visibleBefore: new WeakSet(Array.from(document.body.getElementsByTagName("*")).filter(visible)),
    };
    return els.length;
  };
  // After the pointer has left again: real hover effects undo themselves. Anything still moved or
  // still showing was changing on its own (a typed headline, a rotating caption), not because of hover.
  fc.hoverRecheck = () => {
    const h = fc.hover;
    if (!h || !h.last) return { shifted: [], appeared: null };
    const shifted = h.last.shifted.filter(({ el, r }) => {
      const n = layoutBox(el);
      return n && Math.max(Math.abs(n.left - r.left), Math.abs(n.top - r.top), Math.abs(n.width - r.width), Math.abs(n.height - r.height)) < 1;
    });
    let appeared = h.last.appeared;
    if (appeared && visible(appeared) && effOpacity(appeared) > 0.05) appeared = null;
    fc.hoverAppeared = appeared;
    return {
      shifted: shifted.map(({ el, px }) => ({ el: describe(el), px: Math.round(px) })),
      appeared: appeared ? describe(appeared) : null,
    };
  };
  fc.hoverDiff = () => {
    const h = fc.hover;
    if (!h) return { shifted: [], appeared: null };
    const shifted = [];
    const moved = new Set();
    const running = new Set();
    for (const a of document.getAnimations()) if (a.playState === "running" && a.effect && a.effect.target) running.add(a.effect.target);
    for (const { el, r } of h.rects) {
      if (!el.isConnected || !r) continue;
      const n = layoutBox(el);
      if (!n || n.parent !== r.parent) continue;
      const px = Math.max(Math.abs(n.left - r.left), Math.abs(n.top - r.top), Math.abs(n.width - r.width), Math.abs(n.height - r.height));
      if (px >= 1 && !chainAnimated(el, running)) { moved.add(el); shifted.push({ el, px, r }); }
    }
    // report the outermost shifted elements only
    const top = shifted.filter(({ el }) => { for (let p = el.parentElement; p; p = p.parentElement) if (moved.has(p)) return false; return true; });
    let appeared = null;
    const tr = h.target.getBoundingClientRect();
    for (const el of document.body.getElementsByTagName("*")) {
      if (h.visibleBefore.has(el) || !visible(el)) continue;
      if (h.ambient.some((a) => a === el || a.contains(el) || el.contains(a))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const inside = r.left >= tr.left - 1 && r.right <= tr.right + 1 && r.top >= tr.top - 1 && r.bottom <= tr.bottom + 1;
      if (inside) continue;
      let root = el;
      while (root.parentElement && !h.visibleBefore.has(root.parentElement) && root.parentElement !== document.body) root = root.parentElement;
      appeared = root;
      break;
    }
    fc.hoverAppeared = appeared;
    h.last = { shifted: top.slice(0, 6), appeared };
    return {
      shifted: top.slice(0, 6).map(({ el, px }) => ({ el: describe(el), px: Math.round(px) })),
      appeared: appeared ? describe(appeared) : null,
    };
  };
  fc.hoverContentState = () => {
    const el = fc.hoverAppeared;
    if (!el) return { exists: false, visible: false, center: null };
    const r = el.getBoundingClientRect();
    return { exists: true, visible: visible(el) && effOpacity(el) > 0.05, center: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
  };

  // ---------- dialogs ----------
  // Dialogs already open before the trigger (a cookie banner with role=dialog) are not the one under test.
  fc.dialogSnap = () => {
    fc.dialogsBefore = new Set(Array.from(document.querySelectorAll(DIALOG_SEL)).filter(visible));
    return fc.dialogsBefore.size;
  };
  fc.openDialog = () => {
    for (const d of document.querySelectorAll(DIALOG_SEL)) if (visible(d) && !(fc.dialogsBefore && fc.dialogsBefore.has(d))) return d;
    return null;
  };
  fc.dialogState = (trigger) => {
    const d = fc.openDialog();
    const a = document.activeElement;
    const tabbables = d ? Array.from(d.querySelectorAll(TABBABLE)).filter(visible).length : 0;
    return {
      open: !!d,
      dialog: d ? describe(d) : null,
      focusInside: !!(d && a && d.contains(a)),
      focusOnTrigger: !!(trigger && a === trigger),
      tabbables,
    };
  };

  // ---------- keyboard focus ----------
  const focusSig = (el) => {
    let s = "";
    for (let c = el, i = 0; c && i < 2; c = c.parentElement, i++) {
      const cs = getComputedStyle(c);
      for (const p of FOCUS_PROPS) s += cs.getPropertyValue(p) + "|";
    }
    return s;
  };
  fc.focusBaseline = () => {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    fc.focusSigs = new Map();
    for (const el of document.querySelectorAll(TABBABLE)) if (visible(el) && !el.closest("[data-kymo-ignore]")) fc.focusSigs.set(el, focusSig(el));
    return fc.focusSigs.size;
  };
  fc.focusCheck = () => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const base = fc.focusSigs && fc.focusSigs.get(el);
    if (base == null) return { el: describe(el), visible: true, obscured: false, known: false };
    const vis = focusSig(el) !== base;
    const r = el.getBoundingClientRect();
    let obscured = false;
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight) {
      // elementFromPoint skips pointer-events: none, so a keyboard-only hit area over a canvas would
      // look covered by the canvas. Hit-test it as if it took pointer events, then put it back.
      const pe = getComputedStyle(el).pointerEvents === "none";
      const prev = el.style.getPropertyValue("pointer-events"), prio = el.style.getPropertyPriority("pointer-events");
      if (pe) el.style.setProperty("pointer-events", "auto", "important");
      try {
        const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.bottom - 2]];
        obscured = pts.every(([x, y]) => {
          const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, x)), Math.min(innerHeight - 1, Math.max(0, y)));
          return hit && hit !== el && !el.contains(hit) && !hit.contains(el);
        });
      } finally {
        if (pe) { if (prev) el.style.setProperty("pointer-events", prev, prio); else el.style.removeProperty("pointer-events"); }
      }
    }
    return { el: describe(el), visible: vis, obscured, known: true };
  };

  // ---------- tap targets (WCAG 2.5.8) ----------
  fc.targetScan = (minPx) => {
    const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"]';
    const els = Array.from(document.querySelectorAll(sel)).filter((el) => {
      if (!visible(el) || el.closest("[data-kymo-ignore]")) return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.right > 0;
    });
    const boxes = els.map((el) => ({ el, r: el.getBoundingClientRect() }));
    const out = [];
    for (const { el, r } of boxes) {
      if (r.width >= minPx && r.height >= minPx) continue;
      if (r.width * r.height <= 4 || effOpacity(el) < 0.05) continue; // visually hidden (sr-only, a native control behind a custom one)
      const cs = getComputedStyle(el);
      if (/inset\(\s*50%|circle\(\s*0/.test(cs.clipPath) || /rect\(\s*0(px)?,?\s+0(px)?/.test(cs.clip)) continue;
      // inline links inside running text are exempt
      if (el.tagName === "A" && el.parentElement) {
        const block = el.parentElement.closest("p, li, td, dd, blockquote, figcaption, span");
        if (block && (block.innerText || "").trim().length > (el.innerText || "").trim().length + 20) continue;
      }
      // native inputs sized by the browser are exempt (user agent control)
      if ((el.tagName === "INPUT" && /checkbox|radio/.test(el.type)) && getComputedStyle(el).appearance !== "none") continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const half = minPx / 2;
      const crowded = boxes.some(({ el: o, r: or }) => {
        if (o === el || o.contains(el) || el.contains(o)) return false;
        // spacing exception: a minPx circle centred on this target must not touch another target
        const nx = Math.max(or.left, Math.min(cx, or.right)), ny = Math.max(or.top, Math.min(cy, or.bottom));
        return Math.hypot(nx - cx, ny - cy) < half;
      });
      out.push({ el, w: Math.round(r.width), h: Math.round(r.height), crowded });
    }
    // crowded ones first: they are the WCAG failures; the rest only matter for touch sizes
    out.sort((a, b) => Number(b.crowded) - Number(a.crowded));
    return out.slice(0, 40).map((x) => ({ ...x, el: describe(x.el) }));
  };

  // ---------- layout shift and long frames since a time ----------
  fc.now = () => performance.now();
  fc.shiftsSince = (t0) => {
    let cls = 0, src = null, best = 0;
    for (const s of fc.shifts) {
      if (s.t < t0) continue;
      cls += s.value;
      if (s.value > best && s.src && s.src.isConnected) { best = s.value; src = s.src; }
    }
    return { cls: Math.round(cls * 1000) / 1000, source: src ? describe(src) : null };
  };
  fc.longFramesSince = (t0) => fc.loafs.filter((l) => l.start + l.duration >= t0);

  fc.sectionStats = () => {
    let sections = Array.from(document.querySelectorAll("main section, body > section, article > section"));
    if (sections.length < 3) {
      const main = document.querySelector("main") || document.body;
      sections = Array.from(main.children).filter((el) => visible(el) && el.getBoundingClientRect().height > 120);
    }
    const animated = new Set(fc.anims.filter(({ rec }) => rec.props.some((p) => /opacity|transform|translate/.test(p))).map(({ el }) => el));
    let revealed = 0;
    for (const s of sections) {
      for (const el of animated) if (s === el || s.contains(el)) { revealed++; break; }
    }
    return { sections: sections.length, revealed };
  };

  // ---------- template look (AI-01) ----------
  fc.aiScan = () => {
    const tells = [];
    const add = (id, label, detail) => tells.push({ id, label, detail });
    const rgb = (s) => { const m = (s || "").match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return p.length >= 3 ? { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } : null; };
    const hue = ({ r, g, b }) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return -1; let h; if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; return (h * 60 + 360) % 360; };
    const sat = ({ r, g, b }) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx ? (mx - mn) / mx : 0; };
    const vis = Array.from(document.body.getElementsByTagName("*")).filter(visible).slice(0, 3000);

    // page background (walk up from the body until something is opaque)
    let bg = null;
    for (const el of [document.body, document.documentElement]) { const c = rgb(getComputedStyle(el).backgroundColor); if (c && c.a > 0.5) { bg = c; break; } }
    const dark = bg ? Math.max(bg.r, bg.g, bg.b) <= 45 : false;
    let glows = 0;
    for (const el of vis) {
      const sh = getComputedStyle(el).boxShadow;
      if (!sh || sh === "none") continue;
      for (const part of sh.split(/,(?![^(]*\))/)) {
        const c = rgb(part); const blur = (part.replace(/rgba?\([^)]*\)/, "").match(/-?\d+(\.\d+)?px/g) || []).map(parseFloat)[2] || 0;
        if (c && blur >= 10 && Math.max(c.r, c.g, c.b) > 100 && Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) > 60) { glows++; break; }
      }
    }
    if (dark && glows > 2) add("dark-glow", "Dark page with glowing accents", glows + " elements glow on a near-black background");

    let purple = 0, gradText = 0;
    for (const el of vis) {
      const cs = getComputedStyle(el);
      const bi = cs.backgroundImage;
      if (bi && bi.includes("gradient")) {
        const stops = (bi.match(/rgba?\([^)]*\)/g) || []).map(rgb).filter(Boolean);
        if (stops.some((c) => { const h = hue(c); return h >= 230 && h <= 300 && sat(c) > 0.3; })) purple++;
        if (/^H[1-3]$/.test(el.tagName) || el.closest("h1, h2, h3")) {
          if ((cs.webkitBackgroundClip || cs.backgroundClip) === "text") gradText++;
        }
      }
    }
    if (purple) add("purple-gradient", "Purple-to-blue gradients", purple + " element(s) use a violet or indigo gradient");
    if (gradText) add("gradient-text", "Gradient headline text", gradText + " heading(s) use background-clip: text");

    const fam = (el) => (el ? getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim().toLowerCase() : "");
    const defaults = ["inter", "roboto", "arial", "open sans", "system-ui", "-apple-system", "geist", "helvetica", "helvetica neue", "segoe ui", "blinkmacsystemfont"];
    const h1 = document.querySelector("h1, h2");
    if (defaults.includes(fam(document.body)) && (!h1 || defaults.includes(fam(h1)))) add("default-fonts", "Default font pair", "body and headings both use " + fam(document.body));

    const glass = vis.filter((el) => { const f = getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter; return f && f !== "none" && /blur/.test(f); }).length;
    if (glass >= 3) add("glass", "Glassmorphism", glass + " elements blur what is behind them");

    // identical cards: 3+ siblings of the same size with a similar structure
    let cardRows = 0;
    const parents = new Set(vis.map((el) => el.parentElement).filter(Boolean));
    for (const p of parents) {
      const kids = Array.from(p.children).filter((k) => visible(k));
      if (kids.length < 3) continue;
      const rs = kids.map((k) => k.getBoundingClientRect());
      const big = kids.filter((k, i) => rs[i].width >= 100 && rs[i].height >= 80);
      if (big.length < 3) continue;
      const r0 = big[0].getBoundingClientRect();
      const same = big.filter((k) => { const r = k.getBoundingClientRect(); return Math.abs(r.width - r0.width) < 2 && Math.abs(r.height - r0.height) < 2 && Math.abs(k.getElementsByTagName("*").length - big[0].getElementsByTagName("*").length) <= 2; });
      const shadowed = same.filter((k) => { const cs = getComputedStyle(k); return cs.boxShadow !== "none" || parseFloat(cs.borderTopLeftRadius) >= 8; });
      if (same.length >= 3 && shadowed.length >= 3) cardRows++;
    }
    if (cardRows) add("identical-cards", "Identical card grid", cardRows + " row(s) of look-alike rounded cards");

    // one radius everywhere
    const radii = {};
    let rounded = 0;
    for (const el of vis) { const r = parseFloat(getComputedStyle(el).borderTopLeftRadius); if (r > 0 && r < 999) { rounded++; radii[r] = (radii[r] || 0) + 1; } }
    const topRadius = Object.entries(radii).sort((a, b) => b[1] - a[1])[0];
    if (rounded >= 8 && topRadius && topRadius[1] / rounded > 0.8) add("one-radius", "One corner radius everywhere", Math.round(topRadius[1] / rounded * 100) + "% of rounded elements use " + topRadius[0] + "px");

    const emoji = /^\p{Extended_Pictographic}/u;
    const emojiHeads = Array.from(document.querySelectorAll("h1, h2, h3, h4, button, nav a")).filter((el) => visible(el) && emoji.test((el.innerText || "").trim())).length;
    if (emojiHeads >= 2) add("emoji-icons", "Emoji as icons", emojiHeads + " headings or buttons start with an emoji");

    let eyebrows = 0;
    for (const h of document.querySelectorAll("h1, h2, h3")) {
      const prev = h.previousElementSibling;
      if (!prev || !visible(prev)) continue;
      const cs = getComputedStyle(prev);
      if (cs.textTransform === "uppercase" && parseFloat(cs.letterSpacing) >= 0.5 && parseFloat(cs.fontSize) <= 14 && (prev.innerText || "").length < 40) eyebrows++;
    }
    if (eyebrows >= 3) add("eyebrows", "Tracked caps eyebrow above headings", eyebrows + " headings have a small uppercase label above them");

    const copy = ((document.body.innerText || "").match(/\b(elevate|seamless(ly)?|unleash|supercharge|effortless(ly)?|revolutioni[sz]e|next-level|game-chang)/gi) || []).length;
    if (copy >= 2) add("hype-copy", "Template copy", copy + " stock phrases such as elevate or seamless");
    return { tells };
  };

  // ---------- discovery ----------
  // A pointer can only press what is on the page and bigger than a pixel. Controls parked off the
  // page until they get focus (skip links) or clipped to nothing (screen-reader text) are keyboard
  // only, and the focus walk already covers them.
  const pointerReachable = (el) => {
    const r = el.getBoundingClientRect();
    if (r.bottom + scrollY <= 0 || r.right + scrollX <= 0) return false;
    if (r.width * r.height <= 4) return false;
    const cs = getComputedStyle(el);
    if (cs.clip === "rect(0px, 0px, 0px, 0px)" || /inset\(50%\)/.test(cs.clipPath)) return false;
    return true;
  };
  fc.discover = (include, exclude) => {
    const out = [];
    const nodes = Array.from(document.querySelectorAll(include));
    for (const el of nodes) {
      if (!visible(el)) continue;
      if (!pointerReachable(el)) continue; // skip links parked above the page, screen-reader-only text
      if (el.closest("[data-kymo-ignore]")) continue;
      if (exclude.some((sel) => { try { return el.matches(sel) || el.closest(sel); } catch (e) { return false; } })) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true" || el.readOnly) continue;
      if (SKIP_NAMES && SKIP_NAMES.test(accName(el).trim().replace(/\s+/g, " "))) continue; // sign-out, pay, third-party sign-in
      if (el.tagName === "A") {
        const href = el.getAttribute("href") || "";
        if (href && !href.startsWith("#")) continue; // navigation links leave the page
      }
      out.push(locator(el));
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
})();
