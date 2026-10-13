// Jank zoo behaviour. Each exhibit is wired up on purpose, good or bad.
const $ = (id) => document.getElementById(id);
const toggle = (btn, el, cls) => btn.addEventListener("click", () => el.classList.toggle(cls));

// slow-ack: updates 600 ms late, no pressed state
$("slow-ack-btn").addEventListener("click", (e) => {
  const count = e.currentTarget.querySelector(".count");
  setTimeout(() => { count.textContent = String(Number(count.textContent) + 1); }, 600);
});

toggle($("teleport-btn"), $("teleport-slab"), "moved");
toggle($("pop-btn"), $("pop-sheet"), "open");
toggle($("acc-btn"), $("acc"), "open");
toggle($("tile-btn"), $("tile"), "on");
toggle($("drawer-btn"), $("drawer"), "open");
toggle($("rail-btn"), $("rail"), "open");

$("toast-btn").addEventListener("click", () => {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = "Link copied";
  $("toast-slot").replaceChildren(t);
});

$("banner-btn").addEventListener("click", () => {
  const b = document.createElement("div");
  b.className = "banner";
  b.textContent = "New: shared workspaces";
  $("banner-slot").replaceChildren(b);
});

// silent-save: no pending state, and a failure says nothing
$("silent-save-btn").addEventListener("click", async () => {
  try {
    const r = await fetch("/api/save", { method: "POST", body: "{}" });
    if (!r.ok) return;
    $("silent-save-status").textContent = "Saved";
  } catch (e) {
    /* swallowed */
  }
});

// blank-on-error: spinner, then nothing if it fails
$("load-btn").addEventListener("click", async () => {
  const list = $("load-list");
  list.innerHTML = '<div class="spinner" role="progressbar" aria-label="Loading"></div>';
  try {
    const r = await fetch("/api/items");
    if (!r.ok) throw new Error("bad status");
    const items = await r.json();
    list.innerHTML = items.map((i) => `<div class="item">${i}</div>`).join("");
  } catch (e) {
    list.innerHTML = "";
  }
});

// ===== clean twins =====
$("good-like").addEventListener("click", (e) => {
  const count = e.currentTarget.querySelector(".count");
  count.textContent = String(Number(count.textContent) + 1);
});

$("good-save-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const status = $("good-save-status");
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.textContent = "Saving...";
  status.className = "status";
  status.removeAttribute("role");
  status.textContent = "";
  try {
    const r = await fetch("/api/save", { method: "POST", body: "{}" });
    if (!r.ok) throw new Error("bad status");
    status.textContent = "Saved";
  } catch (err) {
    status.className = "status error";
    status.setAttribute("role", "alert");
    status.textContent = "Couldn't save your profile. Try again.";
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.textContent = "Save profile";
  }
});

toggle($("good-dialog-btn"), $("good-sheet"), "open");
toggle($("good-toggle-btn"), $("good-slab"), "moved");
toggle($("good-reveal-btn"), $("good-reveal"), "shown");

// ===== v0.2 exhibits: exits, long frames, typing, focus, targets, hover, dialogs, menus, canvas =====
const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* block the main thread */ } };
const say = (id, text) => () => { $(id).textContent = text; };

// vanish-notice: gone in one frame
$("vanish-btn").addEventListener("click", () => $("vanish-notice").remove());

// long-task: pressed state is instant, then 250 ms of blocking work
$("sort-btn").addEventListener("click", () => { busy(250); $("sort-state").textContent = "Sorted by date"; });

// typing-lag: 180 ms of work in every keydown, before the browser inserts the letter
$("lag-input").addEventListener("keydown", () => busy(180));

// eager-validation: an error on the first character
$("eager-email").addEventListener("input", (e) => {
  const f = e.currentTarget;
  const bad = !f.validity.valid || !f.value.includes("@");
  f.setAttribute("aria-invalid", String(bad));
  $("eager-error").textContent = bad ? "Please enter a valid email address." : "";
});

$("archive-btn").addEventListener("click", say("archive-state", "Archived"));
for (const b of document.querySelectorAll(".ico")) {
  b.addEventListener("click", () => b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")));
}
$("follow-btn").addEventListener("click", say("follow-state", "Following"));
$("msg-btn").addEventListener("click", say("follow-state", "Draft started"));
$("share-btn").addEventListener("click", () => { $("share-btn").textContent = "Link copied"; });

// dialog-trap: opens, but focus stays on the trigger and Escape does nothing
$("trap-open").addEventListener("click", () => $("trap-dialog").classList.add("open"));
$("trap-cancel").addEventListener("click", () => $("trap-dialog").classList.remove("open"));

// nested-menu: Pin works, Duplicate is wired to nothing
$("menu-btn").addEventListener("click", (e) => {
  const open = $("menu").classList.toggle("open");
  e.currentTarget.setAttribute("aria-expanded", String(open));
});
$("mi-pin").addEventListener("click", say("menu-state", "Pinned"));

// canvas: the slow one redraws 300 ms after the click, the fast one in the next frame
function heat(canvas) {
  const ctx = canvas.getContext("2d");
  let phase = 0;
  const draw = () => {
    for (let x = 0; x < 15; x++) for (let y = 0; y < 4; y++) {
      const v = (Math.sin((x + phase * 3) * 0.7) * Math.cos((y + phase) * 1.3) + 1) / 2;
      ctx.fillStyle = `hsl(${150 - v * 140} 55% ${88 - v * 40}%)`;
      ctx.fillRect(x * 20, y * 22, 19, 21);
    }
  };
  draw();
  return () => { phase++; draw(); };
}
const slowHeat = heat($("heat-slow"));
$("heat-slow").addEventListener("click", () => setTimeout(slowHeat, 300));
const fastHeat = heat($("heat-fast"));
$("heat-fast").addEventListener("click", () => requestAnimationFrame(fastHeat));

// ===== clean twins =====
$("good-dismiss-btn").addEventListener("click", () => {
  const n = $("good-notice");
  if (!n) return;
  n.classList.add("leaving");
  const running = n.getAnimations();
  if (!running.length) return n.remove(); // reduced motion: no transition, leave at once
  Promise.all(running.map((a) => a.finished)).then(() => n.remove(), () => n.remove());
});

const goodEmail = $("good-email");
const checkEmail = () => goodEmail.validity.valid && goodEmail.value.includes("@");
goodEmail.addEventListener("blur", () => {
  const bad = goodEmail.value !== "" && !checkEmail();
  goodEmail.setAttribute("aria-invalid", String(bad));
  $("good-email-error").textContent = bad ? "Enter an email address like name@example.com." : "";
});
goodEmail.addEventListener("input", () => {
  // reward early: clear a shown error as soon as the value is fixed, never add one while typing
  if (goodEmail.getAttribute("aria-invalid") === "true" && checkEmail()) {
    goodEmail.setAttribute("aria-invalid", "false");
    $("good-email-error").textContent = "";
  }
});

$("good-archive-btn").addEventListener("click", say("good-archive-state", "Archived"));
$("good-follow-btn").addEventListener("click", say("good-follow-state", "Following"));
$("good-msg-btn").addEventListener("click", say("good-follow-state", "Draft started"));
$("usage-btn").addEventListener("click", () => { $("usage-btn").textContent = "Usage: 24%"; });

// good-tooltip: Escape hides it until the pointer leaves
const tipwrap = $("good-tipwrap");
addEventListener("keydown", (e) => { if (e.key === "Escape") tipwrap.classList.add("tip-off"); });
tipwrap.addEventListener("pointerleave", () => tipwrap.classList.remove("tip-off"));

// good-modal: native dialog, exit animated, focus handed back on close
const dlg = $("rename-dialog");
$("rename-open").addEventListener("click", () => dlg.showModal());
dlg.addEventListener("close", () => $("rename-open").focus());
const closeDialog = (save) => {
  if (save) $("rename-state").textContent = $("rename-input").value || "Untitled";
  dlg.classList.add("closing");
  const running = dlg.getAnimations();
  const done = () => { dlg.classList.remove("closing"); dlg.close(); };
  if (!running.length) return done();
  Promise.all(running.map((a) => a.finished)).then(done, done);
};
$("rename-cancel").addEventListener("click", () => closeDialog(false));
$("rename-save").addEventListener("click", () => closeDialog(true));
