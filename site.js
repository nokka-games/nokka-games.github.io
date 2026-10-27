document.getElementById("year").textContent = new Date().getFullYear();

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Sections slide up once as they come into view.
const reveals = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window && !reduceMotion) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  reveals.forEach((el) => io.observe(el));
} else {
  reveals.forEach((el) => el.classList.add("in"));
}

// Screenshot gallery: crossfades on its own, pauses while hovered or off screen.
for (const gallery of document.querySelectorAll("[data-gallery]")) {
  const stage = gallery.querySelector(".stage");
  const shots = [...gallery.querySelectorAll(".shot")];
  const thumbs = [...gallery.querySelectorAll(".thumbs button")];
  const bar = gallery.querySelector(".progress span");
  const DURATION = 5200;
  let index = 0;
  let elapsed = 0;
  let last = 0;
  let hovered = false;
  let visible = false;

  const show = (i) => {
    index = (i + shots.length) % shots.length;
    shots.forEach((s, k) => s.classList.toggle("is-active", k === index));
    thumbs.forEach((t, k) => t.setAttribute("aria-pressed", String(k === index)));
    // Warm up the next one so the crossfade never waits on the network.
    const next = shots[(index + 1) % shots.length];
    if (next.loading === "lazy") next.loading = "eager";
    elapsed = 0;
  };

  thumbs.forEach((t, k) => t.addEventListener("click", () => show(k)));
  stage.addEventListener("click", () => show(index + 1));
  gallery.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") hovered = true; });
  gallery.addEventListener("pointerleave", () => (hovered = false));
  gallery.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") show(index + 1);
    else if (e.key === "ArrowLeft") show(index - 1);
    else return;
    thumbs[index].focus();
    e.preventDefault();
  });

  if (reduceMotion) continue;

  new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.25 }).observe(stage);

  const tick = (now) => {
    const dt = last ? Math.min(now - last, 100) : 0;
    last = now;
    if (visible && !hovered && !document.hidden) {
      elapsed += dt;
      if (elapsed >= DURATION) show(index + 1);
    }
    bar.style.transform = `scaleX(${Math.min(elapsed / DURATION, 1)})`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
