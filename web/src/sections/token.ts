import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ALLOCATIONS, TOTAL_SUPPLY } from "../config";

const SVG = "http://www.w3.org/2000/svg";
const R = 80;
const C = 2 * Math.PI * R;
const GAP = 1.6; // surface gap between segments, in viewBox units

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

// DOM helper: text only, never HTML, so the page can run under Trusted Types.
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function initToken(reduced: boolean) {
  const group = document.querySelector<SVGGElement>("[data-donut]");
  const donut = group?.closest("svg");
  const chart = document.querySelector<HTMLElement>(".token__chart");
  const legend = document.querySelector<HTMLUListElement>("[data-legend]");
  const tbody = document.querySelector<HTMLTableSectionElement>("[data-alloc-table] tbody");
  const tip = document.querySelector<HTMLElement>("[data-tip]");
  const supply = document.querySelector<HTMLElement>("[data-supply]");
  const supplyLabel = document.querySelector<HTMLElement>("[data-supply-label]");
  if (!group || !donut || !chart || !legend || !tbody || !tip || !supply || !supplyLabel) return;

  let offset = 0;
  const segs = ALLOCATIONS.map((a, i) => {
    const len = (a.pct / 100) * C;
    const circle = document.createElementNS(SVG, "circle");
    circle.setAttribute("class", "donut__seg");
    circle.setAttribute("cx", "100");
    circle.setAttribute("cy", "100");
    circle.setAttribute("r", String(R));
    circle.setAttribute("stroke", a.color);
    circle.setAttribute("stroke-dashoffset", String(-offset));
    circle.setAttribute("tabindex", "0");
    circle.setAttribute("aria-label", `${a.name}: ${a.pct}%`);
    group.append(circle);

    const sw = el("span", "legend__sw");
    sw.style.background = a.color;
    const name = el("span", "legend__name", a.name);
    name.append(el("span", "legend__terms", a.terms));
    const li = el("li");
    li.append(sw, name, el("span", "legend__pct", `${a.pct}%`));
    legend.append(li);

    const tr = el("tr");
    tr.append(el("td", "", a.name), el("td", "", `${a.pct}%`), el("td", "", a.terms));
    tbody.append(tr);

    const seg = { a, i, circle, li, start: offset, len };
    offset += len;
    return seg;
  });

  const draw = (p: number) => {
    // Segments draw in sequence; each one's legend row lights up as it lands.
    segs.forEach((s) => {
      const local = Math.min(1, Math.max(0, p * segs.length - s.i));
      const visible = Math.max(0, s.len * local - GAP);
      s.circle.setAttribute("stroke-dasharray", `${visible} ${C}`);
      s.li.style.opacity = String(0.25 + 0.75 * local);
    });
  };

  // Hover / focus: highlight one allocation across chart, legend and tooltip.
  const focus = (index: number | null) => {
    donut.classList.toggle("is-focus", index !== null);
    segs.forEach((s) => {
      s.circle.classList.toggle("is-active", s.i === index);
      s.li.classList.toggle("is-active", s.i === index);
    });
    if (index === null) {
      tip.hidden = true;
      return;
    }
    const s = segs[index];
    const angle = ((s.start + s.len / 2) / C) * Math.PI * 2 - Math.PI / 2;
    const half = chart.clientWidth / 2;
    tip.style.left = `${half + Math.cos(angle) * half * 0.8}px`;
    tip.style.top = `${half + Math.sin(angle) * half * 0.8}px`;
    tip.replaceChildren(el("strong", "", `${s.a.name} · ${s.a.pct}%`), el("span", "", `${fmt((s.a.pct / 100) * TOTAL_SUPPLY)} tokens`));
    tip.hidden = false;
  };
  segs.forEach((s) => {
    for (const el of [s.circle, s.li]) {
      el.addEventListener("pointerenter", () => focus(s.i));
      el.addEventListener("pointerleave", () => focus(null));
    }
    s.circle.addEventListener("focus", () => focus(s.i));
    s.circle.addEventListener("blur", () => focus(null));
  });

  // Illustrative burn: supply can only ever count down.
  const ILLUSTRATIVE_FLOOR = TOTAL_SUPPLY * 0.9;
  const showSupply = (p: number) => {
    supply.textContent = fmt(TOTAL_SUPPLY - (TOTAL_SUPPLY - ILLUSTRATIVE_FLOOR) * p);
    supplyLabel.textContent = p > 0 ? "illustration · burns only subtract" : "total supply, minted once";
  };

  if (reduced) {
    draw(1);
    return;
  }
  draw(0);

  const mm = gsap.matchMedia();
  const bind = (trigger: Element, start: string, end: string) =>
    ScrollTrigger.create({
      trigger,
      start,
      end,
      scrub: true,
      onUpdate: (self) => {
        const p = self.progress;
        draw(Math.min(1, p / 0.6));
        showSupply(Math.min(1, Math.max(0, (p - 0.68) / 0.3)));
      },
    });
  mm.add("(min-width: 861px)", () => {
    bind(document.querySelector("#token")!, "top top", "bottom bottom");
  });
  mm.add("(max-width: 860px)", () => {
    bind(chart, "top 85%", "bottom 20%");
  });
}
