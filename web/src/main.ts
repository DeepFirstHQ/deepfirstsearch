// Fonts are self-hosted: no request to third parties, so visitors' IPs never leave this origin.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-800.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles.css";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { TICKER } from "./config";
import { initHero } from "./sections/hero";
import { initCipher } from "./sections/cipher";
import { initPillars } from "./sections/pillars";
import { initToken } from "./sections/token";
import { initCounters, initFlow, initReveals, initTimeline, initWords } from "./sections/extras";

gsap.registerPlugin(ScrollTrigger);

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

document.querySelectorAll("[data-ticker]").forEach((el) => (el.textContent = TICKER));

// Smooth, inertial scroll drives every ScrollTrigger (skipped for reduced motion).
let lenis: Lenis | null = null;
if (!reduced) {
  lenis = new Lenis({ lerp: 0.09, smoothWheel: true });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis!.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

// Nav tucks away while reading down, returns when scrolling up.
const nav = document.querySelector<HTMLElement>("#nav");
let lastY = 0;
const onScroll = (y: number) => {
  nav?.classList.toggle("is-hidden", y > lastY && y > 240);
  lastY = y;
};
if (lenis) lenis.on("scroll", (l: Lenis) => onScroll(l.scroll));
else window.addEventListener("scroll", () => onScroll(window.scrollY), { passive: true });

// In-page links glide instead of jumping.
document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    const target = document.querySelector<HTMLElement>(a.getAttribute("href")!);
    if (!target) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(target, { duration: 1.6 });
    else target.scrollIntoView();
  });
});

initHero(reduced);
initWords(reduced);
initCipher(reduced);
initPillars(reduced);
initToken(reduced);
initReveals(reduced);
initCounters(reduced);
initFlow(reduced);
initTimeline(reduced);

// Fonts change layout metrics; re-measure pinned sections once they land.
document.fonts?.ready.then(() => ScrollTrigger.refresh());
