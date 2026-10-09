// Pruebas sin conexión: cada respuesta sale de las grabaciones test/fx-*.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

test("las categorías son 24 fichas +18, con imagen y sin géneros de menores", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hentaila-cat-"));
  const copy = join(dir, "plugin.mjs");
  writeFileSync(copy, readFileSync(join(root, "plugin.js")));
  const card = '<h3 class="x">Ejemplo</h3><a href="/media/ejemplo-uno"></a><img src="https://cdn.hentaila.com/covers/1.jpg">';
  globalThis.kino = {
    fetch: async () => ({ ok: true, status: 200, text: async () => card }),
    storage: { get: async () => { throw new Error("vacío"); }, set: async () => ({}) },
    log: () => {},
    error: (code, msg) => new Error(code + ": " + msg),
  };
  const mod = await import(pathToFileURL(copy).href);
  const tiles = await mod.categories();
  assert.equal(tiles.length, 24);
  assert.ok(tiles.every((x) => x.adult === true && x.title.length <= 40));
  assert.ok(tiles.every((x) => x.art === "https://cdn.hentaila.com/covers/1.jpg"));
  assert.ok(tiles.every((x) => !/shota|loli|petit/.test(x.ref)));
});

test("una categoría trae títulos y los géneros ocultos no traen ninguno", async () => {
  const ok = await run("fx-cat.json", "browse", "g:vanilla");
  assert.ok(itemsOf(ok).length > 0);
  const no = await run("fx-shota.json", "browse", "g:shota");
  assert.equal(itemsOf(no).length, 0);
});

test("la sección trae tres pestañas, filas con Ver más y todo +18", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hentaila-sec-"));
  const copy = join(dir, "plugin.mjs");
  writeFileSync(copy, readFileSync(join(root, "plugin.js")));
  const card = '<h3 class="x">Ejemplo</h3><a href="/media/ejemplo-uno"></a><img src="https://cdn.hentaila.com/covers/1.jpg">';
  globalThis.kino = {
    fetch: async () => ({ ok: true, status: 200, text: async () => card }),
    storage: { get: async () => { throw new Error("vacío"); }, set: async () => ({}) },
    log: () => {},
    error: (code, msg) => new Error(code + ": " + msg),
  };
  const mod = await import(pathToFileURL(copy).href);
  const a = await mod.section({ tab: null });
  assert.equal(a.tab, "novedades");
  assert.equal(a.tabs.length, 3);
  assert.equal(a.rows.length, 1);
  const g1 = await mod.section({ tab: "generos1" });
  assert.equal(g1.rows.length, 12);
  const g2 = await mod.section({ tab: "generos2" });
  assert.equal(g2.rows.length, 12);
  assert.ok([a, g1, g2].every((x) => x.rows.every((r) => r.ref && r.items.length > 0 && r.items.every((i) => i.adult === true))));
});
