// Bundles the whole game into ONE self-contained .html file.
// Double-click the output on any machine (Windows/Mac/Linux) — no install,
// no server, works offline. Run with:  npm run standalone
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { auditLevels } from "./level-audit.mjs";

// boundary gate — never ship a level with an uncapped edge or a void column
{
  const problems = await auditLevels("src/levels.js");
  if (problems.length) {
    console.error(`LEVEL AUDIT FAILED — refusing to build:`);
    for (const p of problems) console.error("  ✗ " + p);
    process.exit(1);
  }
  console.log("level audit: all levels capped + fully floored");
}

const result = await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: true,      // strip comments/whitespace from the shipped single file
  keepNames: false,  // mangle identifier names in the shipped file
  write: false,
});
const js = result.outputFiles[0].text;
const css = readFileSync("src/style.css", "utf8");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>TETHER — grapple-swing combat prototype</title>
<style>
${css}
</style>
</head>
<body>
<div id="wrap">
  <canvas id="game"></canvas>
  <div id="legend">
    MOUSE aim &middot; RMB/E grapple (again mid-swing = chain) &middot; SPACE release / jump &middot;
    SHIFT dash &middot; LMB/J attack &middot; aim down + LMB midair = POGO &middot; A/D steer &middot; W/S climb &middot; M sound &middot; R restart
  </div>
</div>
<script>
${js}
</script>
</body>
</html>
`;

writeFileSync("TETHER.html", html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`Wrote TETHER.html (${kb} KB) — double-click it on any PC to play.`);
