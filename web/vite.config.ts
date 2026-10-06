import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { marked } from "marked";
import { defineConfig, type Plugin } from "vite";

const DOCS = resolve(__dirname, "../docs");
const REPO = "https://github.com/DeepFirstHQ/deepfirstsearch/blob/main/docs/";

// Markdown documents published as static pages next to the landing.
const PAGES: Record<string, { src: string; title: string }> = {
  "whitepaper.html": { src: "WHITEPAPER.md", title: "Whitepaper" },
  "tokenomics.html": { src: "TOKENOMICS.md", title: "Tokenomics" },
  "developers.html": { src: "DEVELOPERS.md", title: "Developers" },
  "partners.html": { src: "PARTNERS.md", title: "Partners" },
  "legal/terms.html": { src: "legal/TERMS.md", title: "Terms of Use" },
  "legal/privacy.html": { src: "legal/PRIVACY.md", title: "Privacy Policy" },
  "legal/risks.html": { src: "legal/RISKS.md", title: "Risk Disclosure" },
};

const CSP =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types 'none'";

function render(out: string): string {
  const page = PAGES[out];
  const up = "../".repeat(out.split("/").length - 1) || "./";
  const sourceDir = page.src.includes("/") ? page.src.slice(0, page.src.lastIndexOf("/") + 1) : "";
  const pageFor = (md: string) => Object.entries(PAGES).find(([, p]) => p.src === md)?.[0];

  const body = marked.parse(readFileSync(resolve(DOCS, page.src), "utf8"), { async: false }) as string;
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
  },
});
