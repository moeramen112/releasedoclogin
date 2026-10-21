// Builds dist/release-planner.html: the planner as one self-contained page with no server.
// It bundles engine.js, risk.js, plan.js and plan-ui.js, each in its own scope so names cannot collide.
// Run: node scripts/build-standalone.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

/** Wrap a module in a function scope: strip `export`, rewrite imports to destructuring, return its exports. */
function wrap(name, src) {
  const exported = [];
  let body = src.replace(/^export\s+(const|let|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, id) => { exported.push(id); return `${kind} ${id}`; });
  body = body.replace(/^import\s+\{([^}]+)\}\s+from\s+"[^"]*?([\w-]+)\.js";?\s*$/gm, (_, names, mod) => `const {${names}} = __mod_${mod.replace(/-/g, "_")};`);
  return `const __mod_${name.replace(/-/g, "_")} = (() => {\n${body}\nreturn { ${exported.join(", ")} };\n})();`;
}

const html = read("public/plan.html");
const bodyInner = html.slice(html.indexOf("<body>") + 6, html.indexOf('<script type="module"')).replace(/<nav class="nav"[\s\S]*?<\/nav>/, "").trim();
const css = read("public/styles.css");
const scripts = [
  wrap("engine", read("src/engine.js")),
  wrap("risk", read("src/risk.js")),
  wrap("plan", read("src/plan.js")),
  `window.__STANDALONE = true;\n(() => {\n${read("public/plan-ui.js").replace(/function download\([^)]*\) \{[\s\S]*?\n\}\n/, "function download() {} // file downloads are not available in an embedded page\n").replace(/^import\s+\{([^}]+)\}\s+from\s+"[^"]*?([\w-]+)\.js";?\s*$/gm, (_, names, mod) => `const {${names}} = __mod_${mod};`)}\n})();`,
].join("\n");

const headParts = `<title>Release Planner</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap">
<style>
${css}
</style>`;
const bodyParts = `${bodyInner}
<script>
${scripts}
</script>`;
// The artifact host adds the document skeleton, so the fragment has no html, head or body tags.
const fragment = `${headParts}\n${bodyParts}\n`;

mkdirSync(path.join(root, "dist"), { recursive: true });
writeFileSync(path.join(root, "dist/release-planner.html"), fragment);
// A full document too, for opening the file directly from disk.
writeFileSync(path.join(root, "dist/release-planner.standalone.html"), `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${headParts}\n</head>\n<body>\n${bodyParts}\n</body>\n</html>\n`);
console.log(`Wrote dist/release-planner.html (${(fragment.length / 1024).toFixed(0)} KB)`);
