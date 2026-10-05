import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

// Problem statement: words light up one by one as you read down.
export function initWords(reduced: boolean) {
  const el = document.querySelector<HTMLElement>("[data-words]");
  if (!el) return;
  const words = el.textContent!.trim().split(/\s+/);
  el.setAttribute("aria-label", words.join(" "));
  el.replaceChildren(
    ...words.flatMap((w, i) => {
      const span = document.createElement("span");
      span.className = "w";
      span.setAttribute("aria-hidden", "true");
      span.textContent = w;
      return i ? [" ", span] : [span];
    }),
  );
  if (reduced) return;

  gsap.to(el.querySelectorAll(".w"), {
    opacity: 1,
    ease: "none",
    stagger: 0.1,
    scrollTrigger: { trigger: el, start: "top 80%", end: "bottom 40%", scrub: true },
  });
}

// Generic fade-up for headings and cards.
export function initReveals(reduced: boolean) {
  if (reduced) return;
  gsap.set("[data-reveal]", { opacity: 0 });
  ScrollTrigger.batch("[data-reveal]", {
    start: "top 88%",
    once: true,
    onEnter: (batch) =>
      gsap.fromTo(batch, { y: 48, opacity: 0 }, { y: 0, opacity: 1, duration: 1.1, ease: "power3.out", stagger: 0.08 }),
  });
}

// Big numbers count toward their value; zeros count *down* from 100 for drama.
export function initCounters(reduced: boolean) {
  document.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
    const target = Number(el.dataset.count);
    if (reduced) {
      el.textContent = String(target);
      return;
    }
    const state = { v: target === 0 ? 100 : 0 };
    el.textContent = String(state.v);
    gsap.to(state, {
      v: target,
      duration: 1.8,
      ease: "power3.out",
      onUpdate: () => (el.textContent = String(Math.round(state.v))),
      scrollTrigger: { trigger: el, start: "top 85%", once: true },
    });
  });
}

// Fee → protocol → buyback → burn: each connector fills in sequence.
export function initFlow(reduced: boolean) {
  const flow = document.querySelector<HTMLElement>("[data-flow]");
  if (!flow || reduced) return;
  const lines = [...flow.querySelectorAll<HTMLElement>(".flow__line span")];
  ScrollTrigger.create({
    trigger: flow,
    start: "top 80%",
    end: "bottom 45%",
    scrub: true,
    onUpdate: (self) =>
      lines.forEach((l, i) => l.style.setProperty("--p", String(Math.min(1, Math.max(0, self.progress * lines.length - i))))),
  });
}

// Roadmap rail fills as you scroll; each phase lights up when the rail reaches it.
export function initTimeline(reduced: boolean) {
  const tl = document.querySelector<HTMLElement>("[data-timeline]");
  if (!tl || reduced) return;
  const steps = [...tl.querySelectorAll<HTMLElement>(".step")];
  ScrollTrigger.create({
    trigger: tl,
    start: "top 65%",
    end: "bottom 65%",
    scrub: true,
    onUpdate: (self) => {
      tl.style.setProperty("--fill", String(self.progress));
      const reach = self.progress * tl.offsetHeight;
      steps.forEach((s) => s.classList.toggle("is-lit", s.offsetTop <= reach + 4));
    },
  });
}
