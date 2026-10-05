import { gsap } from "gsap";

export function initPillars(reduced: boolean) {
  const section = document.querySelector<HTMLElement>("#product");
  const track = document.querySelector<HTMLElement>("[data-track]");
  const bar = document.querySelector<HTMLElement>("[data-track-progress]");
  if (!section || !track || reduced) return;

  // scrollWidth ignores a flex container's end padding, so add it back to keep the last card off the edge.
  const distance = () =>
    Math.max(0, track.scrollWidth + parseFloat(getComputedStyle(track).paddingLeft) - window.innerWidth);

  gsap
    .timeline({
      scrollTrigger: { trigger: section, start: "top top", end: "bottom bottom", scrub: 0.6, invalidateOnRefresh: true },
    })
    .fromTo(track, { x: 0 }, { x: () => -distance(), ease: "none" }, 0)
    .fromTo(bar, { scaleX: 0 }, { scaleX: 1, ease: "none" }, 0)
    .fromTo(".pillar__art", { rotate: -30 }, { rotate: 60, ease: "none" }, 0);

  gsap.from(".pillar", {
    y: 60,
    opacity: 0,
    stagger: 0.1,
    duration: 1.1,
    ease: "power3.out",
    scrollTrigger: { trigger: section, start: "top 70%", once: true },
  });
}
