// Pruebas sin conexión: cada respuesta sale de las grabaciones test/fx-*.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../sdk/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "kino-plugin.json"), "utf8"));

async function run(file, fn, ...args) {
  const r = await validate(root, { run: fn, args, replay: join(root, "test", file) });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.drops, []);
  return r.output;
}
const itemsOf = (o) => (Array.isArray(o) ? o : o.items || []);

test("Kino acepta el manifiesto y las funciones", async () => {
  const r = await validate(root);
  assert.deepEqual(r.problems, []);
});

test("el manifiesto cumple las reglas del plugin", () => {
  assert.equal(manifest.apiVersion, 6);
  assert.equal(manifest.entry, "plugin.js");
  assert.ok(!manifest.debug);
  assert.ok(!manifest.icon || !manifest.icon.startsWith("./"));
  assert.ok(manifest.capabilities.includes("download"));
});

test("la búsqueda devuelve títulos marcados +18", async () => {
  const items = itemsOf(await run("fx-search.json", "search", "oushun"));
  assert.ok(items.length >= 1);
  assert.ok(items.some((i) => /Oushun/.test(i.title)));
  assert.ok(items.every((i) => i.adult === true));
});

test("los títulos con género oculto no aparecen", async () => {
  const items = itemsOf(await run("fx-blocked.json", "search", "heart mark"));
  assert.ok(!items.some((i) => /Heart Mark Oome/.test(i.title)));
});

test("el inicio trae una fila con series", async () => {
  const out = await run("fx-home.json", "home");
  const rows = Array.isArray(out) ? out : out.rows || [];
  assert.ok(rows.length >= 1);
  assert.ok(rows[0].items.length > 0);
});

test("los capítulos salen numerados", async () => {
  const out = await run("fx-episodes.json", "episodes", "oushun-jogakuen-no-danyuu");
  assert.ok(out.episodes.length >= 1);
  assert.equal(out.episodes[0].number, 1);
  assert.equal(out.episodes[0].ref, "oushun-jogakuen-no-danyuu|1");
});

test("resolve entrega un mp4 por https", async () => {
  const s = await run("fx-resolve.json", "resolve", "oushun-jogakuen-no-danyuu|1");
  assert.ok(s.url.startsWith("https://"));
  assert.equal(s.mime, "video/mp4");
});
