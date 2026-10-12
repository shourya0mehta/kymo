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
