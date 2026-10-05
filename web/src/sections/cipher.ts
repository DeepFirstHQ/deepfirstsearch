import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

// What an outside observer can link to one x402 payment, before and after. Honest by design: fields that
// really change morph into their new value; fields that stay public are marked as such.
type Field = { key: string; before: string; after?: string };

const FIELDS: Field[] = [
  { key: "payer", before: "0x7a3f…9c21 (acme-research-agent)", after: "0xb91c…04ad (new, no history)" },
  { key: "payee", before: "api.pricing-intel.io" },
  { key: "amount", before: "4.20 USDC" },
  { key: "bought", before: "/v1/competitor/northwind/pricing", after: "merchant only" },
  { key: "reason", before: "\"Q4 acquisition due diligence\"", after: "merchant only" },
  { key: "time", before: "2026-10-04T14:22:09Z" },
];

const CHARSET = "abcdef0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

export function initCipher(reduced: boolean) {
  const body = document.querySelector<HTMLElement>("[data-tx]");
  const section = document.querySelector<HTMLElement>("#exposure");
  if (!body || !section) return;

  const rows = FIELDS.map((f) => {
    const dd = el("dd");
    const changed = el("span", "enc");
    const rest = document.createTextNode(f.before);
    const tag = el("span", "tx__public", f.after ? "" : "public");
    dd.append(changed, rest, tag);
    body.append(el("dt", "", f.key), dd);
    return { f, changed, rest, tag };
  });

  const badge = document.querySelector<HTMLElement>("[data-badge]");
  const bar = document.querySelector<HTMLElement>("[data-tx-progress]");
  const before = document.querySelector<HTMLElement>("[data-state-before]");
  const after = document.querySelector<HTMLElement>("[data-state-after]");

  const render = (p: number) => {
    rows.forEach((row, i) => {
      if (!row.f.after) {
        row.tag.classList.toggle("is-on", p > 0.85);
        return;
      }
      // Each changing field morphs in its own window: old text is overwritten left to right by the new one.
      const start = (i / rows.length) * 0.6;
      const local = Math.min(1, Math.max(0, (p - start) / 0.4));
      const target = row.f.after;
      const n = Math.round(local * Math.max(target.length, row.f.before.length));
      const edge = local > 0 && local < 1 ? CHARSET[Math.floor(Math.random() * CHARSET.length)] : "";
      row.changed.textContent = target.slice(0, n) + edge;
      row.rest.data = local >= 1 ? "" : row.f.before.slice(Math.min(row.f.before.length, n + (edge ? 1 : 0)));
    });
    if (bar) bar.style.transform = `scaleX(${p})`;
    const done = p >= 0.999;
    badge?.classList.toggle("is-shielded", done);
    if (badge) badge.textContent = done ? "MINIMIZED" : "LINKABLE";
  };

  if (reduced) {
    render(1);
    return;
  }
  render(0);

  ScrollTrigger.create({
    trigger: section,
    start: "top top",
    end: "bottom bottom",
    scrub: true,
    onUpdate: (self) => render(Math.min(1, Math.max(0, (self.progress - 0.12) / 0.7))),
  });

  gsap
    .timeline({ scrollTrigger: { trigger: section, start: "top top", end: "bottom bottom", scrub: 0.5 } })
    .to(before, { opacity: 0, y: -24, duration: 0.08 }, 0.5)
    .fromTo(after, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.08 }, 0.56)
    .set({}, {}, 1);

  // The card rises and settles as the section arrives, Apple product-shot style.
  gsap.fromTo(
    ".tx",
    { scale: 0.88, rotateX: 12, opacity: 0.4, transformPerspective: 1200 },
    { scale: 1, rotateX: 0, opacity: 1, ease: "none", scrollTrigger: { trigger: section, start: "top bottom", end: "top top", scrub: 0.5 } },
  );
}
