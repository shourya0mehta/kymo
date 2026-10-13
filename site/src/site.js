// kymo launch page. Plain script, no dependencies. window.KYMO is filled in at build time.
(() => {
  const K = window.KYMO;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const $ = (s, el = document) => el.querySelector(s);
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // ---------- the mascot: same pixel grid as src/brand.ts ----------
  const pathOf = (grid, ch) => {
    let d = "";
    grid.forEach((row, y) => {
      for (let x = 0; x < row.length; ) {
        if (row[x] !== ch) { x++; continue; }
        let w = 1;
        while (x + w < row.length && row[x + w] === ch) w++;
        d += `M${x * 4} ${y * 4}h${w * 4}v4h${-w * 4}z`;
        x += w;
      }
    });
    return d;
  };
  const gridFor = (mood, blink, look) => {
    let m = 0;
    const rows = K.grid.body.map((r) => (r === "MOUTH" ? K.grid.mouths[mood][m++] : r));
    if (blink) { rows[4] = rows[4].replace(/o/g, "#"); rows[6] = rows[6].replace(/o/g, "#"); }
    if (look) {
      for (const i of [4, 5, 6]) {
        if (!rows[i].includes("o")) continue;
        const r = rows[i].replace(/o/g, "#").split("");
        for (const c of [4, 5, 10, 11]) r[c + look] = "o";
        rows[i] = r.join("");
      }
    }
    return rows;
  };
  // one drawer per mascot on the page: hero, nav and the dogfood note
  const mascot = (svg, mood = "busy") => {
    if (!svg) return null;
    const st = { mood, blink: false, look: 0 };
    let key = "";
    const draw = () => {
      const k = `${st.mood}${st.blink}${st.look}`;
      if (k === key) return;
      key = k;
      const g = gridFor(st.mood, st.blink, st.look);
      svg.querySelector(".body").setAttribute("d", pathOf(g, "#"));
      svg.querySelector(".face").setAttribute("d", pathOf(g, "o"));
    };
    draw();
    return { svg, st, draw, mood(m) { st.mood = m; draw(); } };
  };
  const pet = $("#pet");
  const hero = mascot(pet), navm = mascot($("#navpet")), dogm = mascot($("#dogpet"), "calm");
  const state = hero ? hero.st : { mood: "busy" };
  const drawPet = () => hero && hero.draw();
  let moodTimer = 0;
  const setMood = (mood, ms = 1600) => {
    state.mood = mood;
    drawPet();
    clearTimeout(moodTimer);
    moodTimer = setTimeout(() => { state.mood = "busy"; drawPet(); }, ms);
  };
  // blink now and then; a blink is a frame swap, like the pixel art it is
  const blinkLater = (m) => m && setTimeout(() => {
    if (!reduce.matches) { m.st.blink = true; m.draw(); setTimeout(() => { m.st.blink = false; m.draw(); }, 130); }
    blinkLater(m);
  }, 2800 + Math.random() * 3200);
  blinkLater(hero);
  blinkLater(navm);
  // the eyes follow the pointer, one pixel at a time
  let pending = false, lastX = 0;
  addEventListener("pointermove", (e) => {
    lastX = e.clientX;
    if (pending || reduce.matches) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      for (const m of [hero, navm]) {
        if (!m) continue;
        const r = m.svg.getBoundingClientRect();
        const dx = lastX - (r.left + r.width / 2);
        const look = Math.abs(dx) < Math.max(r.width, 40) ? 0 : dx < 0 ? -1 : 1;
        if (look !== m.st.look) { m.st.look = look; m.draw(); }
      }
    });
  }, { passive: true });
  // the boot plays once; later hops must not replay it
  if (pet) pet.addEventListener("animationend", (e) => { if (e.animationName === "boot") pet.classList.add("booted"); });

  // ---------- the recorder strip ----------
  const strip = $("#strip");
  const H = 156, BASE = 122, TOP = 26, STEP = 40, MAX_MS = 1200, BUDGET = 100;
  const NS = "http://www.w3.org/2000/svg";
  const amp = (ms) => (Math.log2(1 + Math.min(ms, MAX_MS) / 10) / Math.log2(1 + MAX_MS / 10)) * (BASE - TOP);
  const pulses = K.sample.map((ms) => ({ ms, late: ms > BUDGET, tag: "zoo" }));
  const el = (name, attrs, parent) => {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };
  // a phone shows a shorter stretch of paper at a readable size, not the whole strip shrunk
  const narrow = matchMedia("(max-width: 560px)");
  let W, SHOW, track, first = true;
  const layout = () => {
    W = narrow.matches ? 360 : 640;
    SHOW = narrow.matches ? 6 : 13; // leaves the left edge clear for the budget label
    strip.setAttribute("viewBox", `0 0 ${W} ${H}`);
    strip.replaceChildren();
    let g = "", G = "";
    for (let x = 0, k = 0; x <= W; x += 12, k++) (k % 5 ? (g += `M${x} 0V${H}`) : (G += `M${x} 0V${H}`));
    for (let y = H, k = 0; y >= 0; y -= 12, k++) (k % 5 ? (g += `M0 ${y}H${W}`) : (G += `M0 ${y}H${W}`));
    el("path", { class: "g", d: g }, strip);
    el("path", { class: "G", d: G }, strip);
    const by = BASE - amp(BUDGET);
    el("path", { class: "budget", d: `M0 ${by}H${W}` }, strip);
    el("text", { class: "budget-label", x: 8, y: by - 6 }, strip).textContent = "100 ms budget";
    track = el("g", { class: "track" }, strip);
    el("circle", { class: "stylus", cx: W - 6, cy: BASE, r: 3.5 }, strip);
  };
  const render = (slide) => {
    const visible = pulses.slice(-SHOW);
    const startX = W - 28 - (visible.length - 1) * STEP;
    let d = `M-40 ${BASE}`;
    const lates = [];
    track.replaceChildren();
    visible.forEach((p, i) => {
      const cx = startX + i * STEP, h = Math.max(4, amp(p.ms)), w = 12;
      const seg = `L${cx - w / 2} ${BASE} L${cx - w / 6} ${BASE - h} L${cx + w / 6} ${BASE + Math.min(10, h * 0.25)} L${cx + w / 2} ${BASE}`;
      d += ` ${seg}`;
      if (p.late) lates.push(`M${cx - w / 2} ${BASE} ${seg}`);
      const t = el("text", { class: `ms${p.late ? " late" : ""}`, x: cx, y: Math.max(12, BASE - h - 7), "text-anchor": "middle" }, track);
      t.textContent = p.ms >= 1000 ? `${(p.ms / 1000).toFixed(1)}s` : `${Math.round(p.ms)}`;
    });
    d += ` L${W + 40} ${BASE}`;
    const firstDraw = first;
    const pen = el("path", { class: "pen", d, pathLength: first ? "1" : "" }, track);
    if (first) { pen.classList.add("draw"); first = false; } else pen.removeAttribute("pathLength");
    for (const l of lates) el("path", { class: `pen late${firstDraw ? " first" : ""}`, d: l }, track);
    if (slide && !reduce.matches) {
      // the drum turns: start one step to the right, then glide into place
      track.style.transition = "none";
      track.style.transform = `translateX(${STEP}px)`;
      track.getBoundingClientRect();
      track.style.transition = "";
      track.style.transform = "translateX(0)";
    }
  };
  layout();
  render(false);
  narrow.addEventListener("change", () => { layout(); render(false); });
  const read = $("#rec-read");
  const record = (ms, label, from) => {
    const late = ms > BUDGET;
    pulses.push({ ms, late, tag: label });
    render(true);
    setMood(late ? "alarm" : "calm");
    if (!reduce.matches && pet) { pet.classList.remove("hop"); pet.getBoundingClientRect(); pet.classList.add("hop"); }
    read.innerHTML = `<b>${label}</b>: the screen changed <span class="${late ? "late" : ""}">${Math.round(ms)} ms</span> after the ${from}. ${late ? "Over the 100 ms budget, so kymo would flag it." : "Inside the 100 ms budget."}`;
  };

  // Snappy: the pressed style is the answer, so time from the press to the next frame.
  const snappy = $("#d-snappy");
  snappy.addEventListener("pointerdown", async (e) => {
    const t0 = e.timeStamp;
    await frame();
    record(performance.now() - t0, "Snappy", "press");
  });
  snappy.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const t0 = e.timeStamp;
    snappy.classList.add("done");
    await frame();
    snappy.classList.remove("done");
    record(performance.now() - t0, "Snappy", "key");
  });
  // Laggy: nothing until a timer fires 450 ms after the click.
  const laggy = $("#d-laggy");
  laggy.addEventListener("click", (e) => {
    const t0 = e.timeStamp;
    setTimeout(async () => {
      laggy.classList.add("done");
      await frame();
      record(performance.now() - t0, "Laggy", "release");
      setTimeout(() => laggy.classList.remove("done"), 600);
    }, 450);
  });
  // Frozen: blocks the main thread for 280 ms, so nothing can paint.
  const frozen = $("#d-frozen");
  frozen.addEventListener("click", async (e) => {
    const t0 = e.timeStamp;
    const end = performance.now() + 280;
    while (performance.now() < end) { /* a long task, on purpose */ }
    frozen.classList.add("done");
    await frame();
    record(performance.now() - t0, "Frozen", "release");
    setTimeout(() => frozen.classList.remove("done"), 600);
  });

  // ---------- specimens: Before is the planted problem, After is the fix ----------
  const say = (spec, html) => { spec.querySelector(".verdict").innerHTML = html; };
  const specs = {
    teleport(spec, fixed) {
      const stage = spec.querySelector(".stage"), slab = spec.querySelector(".slab");
      const dist = Math.round(stage.clientWidth - 92 - 28);
      const right = !slab.dataset.right;
      slab.classList.toggle("glide", fixed);
      slab.dataset.right = right ? "1" : "";
      slab.style.transform = right ? `translateX(${dist}px)` : "";
      say(spec, fixed
        ? `<span class="good">Passes.</span> It slides ${dist} px over 240 ms on a decelerating curve, using transform.`
        : `<span class="bad">MOT-09</span> The panel jumped ${dist} px in a single frame, with no transition.`);
    },
    pop(spec, fixed) {
      const stage = spec.querySelector(".stage");
      const t = document.createElement("div");
      t.className = `toast${fixed ? " enter" : ""}`;
      t.textContent = "Link copied to your clipboard";
      stage.replaceChildren(t);
      say(spec, fixed
        ? `<span class="good">Passes.</span> It rises 10 px and fades in over 180 ms.`
        : `<span class="bad">MOT-09</span> A surface covering ${((t.offsetWidth * t.offsetHeight) / (innerWidth * innerHeight) * 100).toFixed(1)}% of the screen appeared fully formed.`);
    },
    vanish(spec, fixed) {
      const stage = spec.querySelector(".stage");
      const n = stage.querySelector(".notice");
      if (!n) {
        const back = document.createElement("div");
        back.className = "notice";
        back.textContent = "Your trial ends in 3 days. Add a card to keep this workspace.";
        stage.replaceChildren(back);
        say(spec, "The notice is back. Dismiss it again to compare.");
        return;
      }
      if (fixed) {
        n.classList.add("leave");
        n.addEventListener("animationend", () => n.remove(), { once: true });
      } else n.remove();
      say(spec, fixed
        ? `<span class="good">Passes.</span> It fades out over 160 ms on an accelerating curve, then leaves.`
        : `<span class="bad">MOT-10</span> The notice vanished in one frame, with no exit.`);
    },
    hover(spec, fixed) {
      const [a, b] = spec.querySelectorAll(".pair span");
      const x0 = b.getBoundingClientRect().left;
      a.classList.remove("bold", "tint");
      a.classList.add(fixed ? "tint" : "bold");
      const moved = Math.round(b.getBoundingClientRect().left - x0);
      setTimeout(() => a.classList.remove("bold", "tint"), 1100);
      say(spec, fixed
        ? `<span class="good">Passes.</span> Hover changes colour, so nothing around it moves.`
        : `<span class="bad">STAB-02</span> Hovering Follow pushed Message ${moved} px to the right.`);
    },
    wait(spec, fixed) {
      const s = spec.querySelector(".saving");
      clearTimeout(s._t);
      if (fixed) {
        s.innerHTML = `<span class="spin" aria-hidden="true"></span>Saving...`;
        say(spec, `<span class="good">Passes.</span> It says Saving right away, then Saved.`);
      } else {
        s.textContent = "Save profile";
        say(spec, `Waiting... nothing has changed yet.`);
      }
      s._t = setTimeout(() => {
        s.textContent = "Saved";
        if (!fixed) say(spec, `<span class="bad">WAIT-01</span> For 1.2 s after the click, nothing on screen changed.`);
        s._t = setTimeout(() => { s.textContent = "Save profile"; }, 1400);
      }, 1200);
    },
    focus(spec, fixed) {
      const [bare, ringed] = spec.querySelectorAll(".focus-target");
      bare.hidden = fixed;
      ringed.hidden = !fixed;
      (fixed ? ringed : bare).focus({ focusVisible: true });
      say(spec, fixed
        ? `<span class="good">Passes.</span> A 2 px ring shows where focus is.`
        : `<span class="bad">CRAFT-02</span> The button has keyboard focus and looks exactly the same.`);
    },
  };
  // the Archive buttons answer a press too; a demo button that does nothing is a dead click
  for (const b of document.querySelectorAll(".focus-target")) {
    b.addEventListener("click", () => {
      clearTimeout(b._t);
      b.textContent = "Archived";
      b._t = setTimeout(() => (b.textContent = "Archive"), 1400);
    });
  }
  for (const spec of document.querySelectorAll(".specimen")) {
    const run = specs[spec.dataset.spec];
    spec.querySelector(".before").addEventListener("click", () => run(spec, false));
    spec.querySelector(".after").addEventListener("click", () => run(spec, true));
  }

  // ---------- nav hairline once the page scrolls, without a scroll handler ----------
  const nav = $("#nav");
  const sentinel = document.createElement("div");
  sentinel.style.cssText = "position:absolute;top:8px;height:1px;width:1px";
  document.body.prepend(sentinel);
  new IntersectionObserver(([e]) => nav.classList.toggle("scrolled", !e.isIntersecting)).observe(sentinel);

  // ---------- copy buttons ----------
  for (const b of document.querySelectorAll("[data-copy]")) {
    b.addEventListener("click", async () => {
      const text = document.getElementById(b.dataset.copy).innerText.split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = "Copied";
      } catch {
        const r = document.createRange();
        r.selectNodeContents(document.getElementById(b.dataset.copy));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        b.textContent = "Selected";
      }
      setTimeout(() => (b.textContent = "Copy"), 1400);
    });
  }

  // ---------- the nav trace: a kymograph of the page, drawn as you scroll ----------
  const trace = $("#navtrace");
  const sections = Array.from(document.querySelectorAll("main > section"));
  let ink = null, dot = null, jank = null, tlen = 0, jankX = Infinity, tw = 0;
  const docSpan = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
  const buildTrace = () => {
    if (!trace) return;
    tw = Math.round(nav.getBoundingClientRect().width);
    const span = docSpan();
    trace.setAttribute("viewBox", `0 0 ${tw} 12`);
    let d = "M0 6", jd = "";
    jankX = Infinity;
    for (const sec of sections.slice(1)) {
      const x = Math.round(Math.min(1, sec.offsetTop / span) * tw);
      if (x < 12 || x > tw - 12) continue;
      // each section is a pulse; the one with the planted jank spikes higher, in red
      const tall = sec.id === "catches";
      const seg = `L${x - 5} 6 L${x - 2} ${tall ? -3 : 1} L${x + 1} ${tall ? 10 : 9} L${x + 4} 6`;
      d += ` ${seg}`;
      if (tall) { jd = `M${x - 5} 6 ${seg}`; jankX = x; }
    }
    d += ` L${tw} 6`;
    trace.innerHTML = `<path class="base" d="${d}"/><path class="ink" d="${d}"/>${jd ? `<path class="jank" d="${jd}"/>` : ""}<circle class="dot" r="2.5" cx="0" cy="6"/>`;
    ink = trace.querySelector(".ink");
    dot = trace.querySelector(".dot");
    jank = trace.querySelector(".jank");
    tlen = ink.getTotalLength();
    ink.style.strokeDasharray = `${tlen} ${tlen}`;
    updateTrace();
  };
  const updateTrace = () => {
    if (!ink) return;
    const p = Math.min(1, Math.max(0, scrollY / docSpan()));
    const len = p * tlen;
    ink.style.strokeDashoffset = String(tlen - len);
    const pt = ink.getPointAtLength(len);
    dot.setAttribute("cx", pt.x.toFixed(1));
    dot.setAttribute("cy", pt.y.toFixed(1));
    if (jank) jank.classList.toggle("on", pt.x > jankX + 4);
  };
  let traceQueued = false;
  addEventListener("scroll", () => {
    if (traceQueued) return;
    traceQueued = true;
    requestAnimationFrame(() => { traceQueued = false; updateTrace(); });
  }, { passive: true });
  let resizeQueued = false;
  addEventListener("resize", () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; buildTrace(); });
  });
  buildTrace();
  if (document.fonts) document.fonts.ready.then(buildTrace);
  addEventListener("load", buildTrace);

  // ---------- which section you are reading: the nav link underlines and the nav mascot reacts ----------
  const moods = { top: "busy", catches: "alarm", loop: "busy", report: "busy", rules: "busy", proof: "calm", install: "calm" };
  const links = Array.from(document.querySelectorAll(".nav nav a"));
  const reading = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = e.target.id;
      if (navm) navm.mood(moods[id] || "busy");
      for (const a of links) a.classList.toggle("current", a.getAttribute("href") === `#${id}`);
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  sections.forEach((sec) => reading.observe(sec));

  // in-page links glide instead of jumping (kept off a global scroll-behavior, so scripts that scroll stay instant)
  for (const a of document.querySelectorAll('a[href^="#"]:not(.skip)')) {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href").slice(1);
      const target = id === "top" ? document.body : document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: reduce.matches ? "auto" : "smooth", block: "start" });
      try { history.replaceState(null, "", `#${id}`); } catch { /* the hash is a convenience */ }
    });
  }

  // ---------- entrances, only where arrival order means something ----------
  const count = (el, delay) => {
    const from = Number(el.dataset.from), to = Number(el.dataset.to);
    // hold the wider of the two widths (measured now, with the real font), so counting never nudges the words beside it
    el.textContent = String(to);
    const wTo = el.getBoundingClientRect().width;
    el.textContent = String(from);
    el.style.minWidth = `${Math.max(wTo, el.getBoundingClientRect().width).toFixed(2)}px`;
    setTimeout(() => {
      const t0 = performance.now(), D = 640;
      const tick = (now) => {
        const k = Math.min(1, (now - t0) / D);
        el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, delay);
  };
  const prepTrace = (box) => {
    const svg = box.querySelector(".trace-box svg");
    if (!svg) return null;
    const pens = Array.from(svg.querySelectorAll(".pen"));
    const marks = Array.from(svg.querySelectorAll(".lbl, .anim, .tick"));
    const lens = pens.map((p) => p.getTotalLength());
    pens.forEach((p) => { p.setAttribute("pathLength", "1"); p.style.strokeDasharray = "1"; p.style.strokeDashoffset = "1"; });
    marks.forEach((m) => { m.style.opacity = "0"; });
    return { svg, pens, marks, lens };
  };
  const drawTrace = (t, start) => {
    // the pen runs left to right at one speed; marks appear as it passes them
    const W = t.svg.viewBox.baseVal.width || 640, D = 520;
    const total = t.lens.reduce((a, b) => a + b, 0) || 1;
    let at = start;
    t.pens.forEach((p, i) => {
      const d = Math.max(40, (D * t.lens[i]) / total);
      p.style.transition = `stroke-dashoffset ${Math.round(d)}ms linear ${Math.round(at)}ms`;
      p.style.strokeDashoffset = "0";
      at += d;
    });
    t.marks.forEach((m) => {
      let x = 0;
      try { x = m.getBBox().x; } catch { /* not rendered */ }
      m.style.transition = `opacity 180ms ease-out ${Math.round(start + (D * x) / W)}ms`;
      m.style.opacity = "";
    });
  };
  const arrive = (els, step) => {
    els.forEach((el, i) => { el.style.setProperty("--i", String(i)); el.style.setProperty("--step", `${step}ms`); el.classList.add("arriving"); el.classList.remove("pre"); });
    setTimeout(() => els.forEach((el) => { el.classList.remove("arriving"); el.style.removeProperty("--i"); el.style.removeProperty("--step"); }), 420 + els.length * step);
  };
  const play = (box) => {
    const kind = box.dataset.enter;
    if (kind === "stagger") {
      arrive(Array.from(box.children), 60);
      box.querySelectorAll(".num").forEach((n, i) => count(n, 180 + i * 60));
    } else if (kind === "loop") {
      box.classList.remove("pre-line");
      arrive(Array.from(box.children), 90);
    } else if (kind === "report") {
      arrive([box], 0);
      if (box._trace) drawTrace(box._trace, 260);
    } else if (kind === "dogfood") {
      arrive([box], 0);
      // the audit found five problems; it settles once they are fixed
      setTimeout(() => { if (dogm) dogm.mood("calm"); }, 900);
    }
  };
  const below = (el) => el.getBoundingClientRect().top > innerHeight * 0.9;
  if (!reduce.matches && "IntersectionObserver" in window) {
    const entering = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        entering.unobserve(e.target);
        play(e.target);
      }
    }, { rootMargin: "0px 0px -12% 0px" });
    for (const box of document.querySelectorAll("[data-enter]")) {
      if (!below(box)) continue; // already on screen: leave it as it is
      const kind = box.dataset.enter;
      const items = kind === "stagger" || kind === "loop" ? Array.from(box.children) : [box];
      items.forEach((el) => el.classList.add("pre"));
      if (kind === "loop") box.classList.add("pre-line");
      if (kind === "report") box._trace = prepTrace(box);
      if (kind === "dogfood" && dogm) dogm.mood("alarm");
      box.querySelectorAll(".num").forEach((n) => { n.textContent = n.dataset.from; });
      entering.observe(box);
    }
    // printing or saving shows everything
    addEventListener("beforeprint", () => document.querySelectorAll(".pre, .pre-line").forEach((el) => el.classList.remove("pre", "pre-line")));
  }
})();
