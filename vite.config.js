import { defineConfig } from "vite";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { genManifest } from "./tools/gen-manifest.mjs";

// the shipped campaign — the delete endpoint refuses to touch these files
const PROTECTED = new Set([
  "sh01-first-arc", "sh02-the-span", "sh03-sporefall",
  "sh04-undertow", "sh05-reaper-below",
  "m01-cave-mouth", "m02-the-prospect", "m03-the-descent", "m04-deep-gallery",
  "m05-crushing-way", "m06-gate-below", "m07-baphomet",
  "i01-the-threshold", "i02-sinking-fields", "i03-the-geysers",
  "i04-arcs-of-ash", "i05-the-crucible", "i06-last-descent", "i07-leviathan",
]);

// dev-server middleware: the editor's SAVE writes the real level JSON in
// src/levels/ (edit-in-place; save-as-new also regenerates the manifest),
// DELETE unlinks a custom level's file + regenerates the manifest
export default defineConfig({
  base: "./",
  plugins: [{
    name: "tether-level-save",
    configureServer(server) {
      server.middlewares.use("/__tether/save", (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; return res.end("POST only"); }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const { data } = JSON.parse(body);
            if (!/^[a-z0-9-]+$/.test(data.id)) throw new Error("bad id");
            writeFileSync(`src/levels/${data.id}.json`, JSON.stringify(data, null, 1) + "\n");
            genManifest();
            res.end("ok");
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
          }
        });
      });
      server.middlewares.use("/__tether/delete", (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; return res.end("POST only"); }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const { id } = JSON.parse(body);
            if (!/^[a-z0-9-]+$/.test(id)) throw new Error("bad id");
            if (PROTECTED.has(id)) throw new Error("protected level");
            const file = `src/levels/${id}.json`;
            if (existsSync(file)) unlinkSync(file);
            genManifest();
            res.end("ok");
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
          }
        });
      });
    },
  }],
});
