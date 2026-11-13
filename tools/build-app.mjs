// Baut aus der bestehenden Cockpit-Plus-Datei (unverändert!) die geschützte
// Server-Version: setzt nur das Verbindungsstück (shim.js) als erstes Skript ein.
// Aufruf:  node tools/build-app.mjs <pfad/zur/index.html>  ->  app/cockpit.html
import fs from "node:fs";
import path from "node:path";
const src = process.argv[2];
if (!src) { console.error("Bitte Pfad zur Cockpit-Plus index.html angeben."); process.exit(1); }
const html = fs.readFileSync(src, "utf8");
const shim = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../app/shim.js"), "utf8");
const m = /<head[^>]*>/i.exec(html);
if (!m) { console.error("Kein <head> gefunden."); process.exit(1); }
const out = html.slice(0, m.index + m[0].length) + "\n<script>\n" + shim + "\n</script>\n" + html.slice(m.index + m[0].length);
const dest = path.join(path.dirname(new URL(import.meta.url).pathname), "../app/cockpit.html");
fs.writeFileSync(dest, out);
console.log("Fertig:", dest, (out.length / 1024 / 1024).toFixed(2) + " MB");
