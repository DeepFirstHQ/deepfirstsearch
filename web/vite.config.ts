import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Marked } from "marked";
import { defineConfig, type Plugin } from "vite";

const DOCS = resolve(__dirname, "../docs");
const REPO = "https://github.com/DeepFirstHQ/deepfirstsearch/blob/main/docs/";

// Markdown documents published as static pages next to the landing.
const PAGES: Record<string, { src: string; title: string }> = {
  "whitepaper.html": { src: "WHITEPAPER.md", title: "Whitepaper" },
  "tokenomics.html": { src: "TOKENOMICS.md", title: "Tokenomics" },
  "developers.html": { src: "DEVELOPERS.md", title: "Developers" },
  "guides/openclaw.html": { src: "guides/OPENCLAW.md", title: "OpenClaw: a wallet it can't be tricked into emptying" },
  "partners.html": { src: "PARTNERS.md", title: "Partners" },
  "legal/terms.html": { src: "legal/TERMS.md", title: "Terms of Use" },
  "legal/privacy.html": { src: "legal/PRIVACY.md", title: "Privacy Policy" },
  "legal/risks.html": { src: "legal/RISKS.md", title: "Risk Disclosure" },
};

// Every integration guide in docs/integrations becomes a page, titled by its first heading.
for (const f of readdirSync(resolve(DOCS, "integrations")).filter((f) => f.endsWith(".md"))) {
  const heading = readFileSync(resolve(DOCS, "integrations", f), "utf8").match(/^# (.+)$/m)?.[1] ?? f;
  PAGES[`integrations/${f.replace(/\.md$/, "").toLowerCase()}.html`] = { src: `integrations/${f}`, title: heading.split(":")[0]! };
}

const CSP =
  "default-src 'none'; script-src https://static.cloudflareinsights.com; connect-src https://cloudflareinsights.com; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types 'none'";

// Headings get GitHub-style ids so links like developers.html#test-without-a-chain work.
function slugify(text: string): string {
  return text.toLowerCase().replace(/<[^>]*>/g, "").replace(/&[a-z0-9#]+;/g, "").trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function markdown(): Marked {
  const seen = new Map<string, number>();
  return new Marked({
    renderer: {
      heading({ tokens, depth, text }) {
        const base = slugify(text);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        return `<h${depth}${id ? ` id="${id}"` : ""}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  });
}

function render(out: string): string {
  const page = PAGES[out];
  const up = "../".repeat(out.split("/").length - 1) || "./";
  const sourceDir = page.src.includes("/") ? page.src.slice(0, page.src.lastIndexOf("/") + 1) : "";
  const pageFor = (md: string) => Object.entries(PAGES).find(([, p]) => p.src === md)?.[0];

  const body = markdown().parse(readFileSync(resolve(DOCS, page.src), "utf8"), { async: false }) as string;
  // Links between docs point at their published page when there is one, otherwise at the repository.
  const html = body.replace(/href="(\.\/|\.\.\/)?([^"#:]+\.md)(#[^"]*)?"/g, (_m, rel = "", file, hash = "") => {
    const path = new URL(rel + file, "https://x/" + sourceDir).pathname.slice(1);
    const target = pageFor(path);
    return `href="${target ? up + target : REPO + path}${hash}"`;
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta http-equiv="Content-Security-Policy" content="${CSP}" />
<meta name="referrer" content="no-referrer" />
<title>${page.title} · Deep First Search</title>
<link rel="stylesheet" href="${up}doc.css" />
<link rel="icon" href="${up}favicon.svg" type="image/svg+xml" />
</head>
<body>
<header class="doc-nav"><a href="${up}index.html">← Deep First Search</a></header>
<main class="doc">${html}</main>
<!-- Cloudflare Web Analytics (cookieless) --><script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "d600e91559984529a7b730d23a891c89"}'></script>
</body>
</html>`;
}

function docsPages(): Plugin {
  return {
    name: "dfs-docs-pages",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0].replace(/^\//, "");
        if (!PAGES[path]) return next();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(render(path));
      });
    },
    generateBundle() {
      for (const out of Object.keys(PAGES)) {
        this.emitFile({ type: "asset", fileName: out, source: render(out) });
      }
    },
  };
}

export default defineConfig({
  // Relative asset paths so the build works from any sub-path or an IPFS gateway.
  base: "./",
  plugins: [docsPages()],
  build: {
    // three.js lives in its own lazy chunk; ~530 kB raw / ~135 kB gzip is expected.
    chunkSizeWarningLimit: 600,
    // The landing plus the read-only vault dashboard (its own bundle: viem never loads on the landing).
    rollupOptions: { input: { main: resolve(__dirname, "index.html"), dashboard: resolve(__dirname, "dashboard.html") } },
  },
});
