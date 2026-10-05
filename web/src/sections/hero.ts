import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

export async function initHero(reduced: boolean) {
  const canvas = document.querySelector<HTMLCanvasElement>("#core");
  const hero = document.querySelector<HTMLElement>("#hero");
  if (!canvas || !hero) return;

  if (!reduced) {
    gsap.from(".hero__copy > *", { y: 40, opacity: 0, duration: 1.4, ease: "power3.out", stagger: 0.12, delay: 0.2 });
  }

  // three.js is the heaviest dependency: load it after the page is already readable.
  const { createCore } = await import("../scene");
  const core = createCore(canvas, reduced);
  if (reduced) return;

  // Intro: the cloud starts gathering.
  const intro = { v: 0 };
  gsap.to(intro, { v: 1, duration: 2.6, ease: "power2.out", onUpdate: () => core?.setIntro(intro.v) });

  ScrollTrigger.create({
    trigger: hero,
    start: "top top",
    end: "bottom bottom",
    scrub: true,
    onUpdate: (self) => core?.setProgress(self.progress),
  });

  // Headline recedes like a product shot pulling back.
  gsap
    .timeline({ scrollTrigger: { trigger: hero, start: "top top", end: "bottom bottom", scrub: 0.6 } })
    .to(".hero__copy", { scale: 0.86, opacity: 0, y: -60, ease: "none", duration: 0.35 }, 0)
    .to(".scroll-cue", { opacity: 0, duration: 0.1 }, 0)
    .fromTo(".hero__after-line", { opacity: 0, y: 40 }, { opacity: 1, y: 0, stagger: 0.08, duration: 0.2 }, 0.55)
    .to(".hero__after", { opacity: 0.0, duration: 0.1 }, 0.9);

  // Stop rendering when the hero is fully off screen.
  new IntersectionObserver(([entry]) => core?.setActive(entry.isIntersecting)).observe(hero);
}
