// Planted: a banner that arrives late with no reserved space, a scroll handler that
// blocks the main thread, and a reveal on every section.
const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* block */ } };

addEventListener("load", () => {
  setTimeout(() => {
    const promo = document.createElement("div");
    promo.className = "promo";
    promo.textContent = "Nebula 2.0 is here. Elevate everything.";
    document.body.insertBefore(promo, document.querySelector(".hero"));
  }, 300);
});

addEventListener("scroll", () => busy(120), { passive: true });

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add("in");
    io.unobserve(e.target);
  }
}, { threshold: 0.15 });
for (const s of document.querySelectorAll(".reveal")) io.observe(s);
