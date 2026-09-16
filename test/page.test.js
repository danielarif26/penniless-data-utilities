import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
import { repairJson } from "../src/repair.js";
import { CLIENT_REPAIR_SOURCE, renderPage } from "../src/page.js";


// The page ships its own copy of the repair passes so it can run offline. That
// copy is only trustworthy if it agrees with the module the paid API uses, so
// compile it here and hold the two to the same answers. It is compiled in this
// realm, not a vm context, so the values it returns can be compared strictly.
const clientRepair = new Function(`${CLIENT_REPAIR_SOURCE}\nreturn repairJson;`)();

const CASES = [
  ["```json\n{foo: 'bar',}\n```", "fenced object with every common defect"],
  ["Here you go:\n{\"a\": 1}\nhope that helps", "object buried in prose"],
  ['{"enabled": True, "missing": None, "off": False}', "python literals"],
  ['{\n  // comment\n  "port": 8080\n}', "line comment"],
  ['{ /* block */ "x": 1 }', "block comment"],
  ['{"a": 1, "b": [1, 2, 3,],}', "trailing commas in both shapes"],
  ["{'quoted': 'single', 'nested': {'deep': 'value'}}", "single quotes throughout"],
  ['{"id": "usr_1", "note": "cut off mid-sent', "truncated inside a string"],
  ['{"list": [1, 2, 3', "truncated inside an array"],
  ['{"already": "valid"}', "valid input needs no passes"],
  ["[1, 2, 3]", "bare array"],
  ['{ "totals": [1, 2, 3 "missing_comma": true }', "genuinely unrepairable"],
  ["", "empty string"],
  ["not json at all", "prose with no JSON"],
  ['{"escaped": "a \\"quote\\" inside"}', "escaped quotes are preserved"],
  ["{'apostrophe': 'it\\'s fine'}", "escaped apostrophe inside single quotes"],
  ['{"unicode": "caf\\u00e9 \\u2014 ok"}', "unicode escapes survive"],
];

test("the page's repair passes agree with the API's, case for case", async (t) => {
  for (const [input, label] of CASES) {
    await t.test(label, () => {
      const server = repairJson(input);
      const client = clientRepair(input);
      assert.equal(client.ok, server.ok, "ok flag");
      assert.deepEqual(client.applied, server.applied, "passes applied, in order");
      assert.deepEqual(client.repaired, server.repaired, "repaired value");
    });
  }
});

test("the page opens on a working example rather than an empty shell", () => {
  const html = renderPage("https://example.test");
  assert.match(html, /inputEl\.value = SAMPLES\.fenced/, "an input sample is preloaded");
  assert.match(html, /render\(\);\s*$/m, "and rendered on load");
});

test("the page is servable, self-contained and indexable", async () => {
  const response = await app.fetch(new Request("http://localhost/"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);

  const html = await response.text();
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{80,}"/, "a real description for search results");
  assert.match(html, /<link rel="canonical" href="http:\/\/localhost\/"/, "canonical URL");
  assert.match(html, /application\/ld\+json/, "structured data");

  // Nothing may be fetched from the Worker after load, or the page stops being
  // free to serve and stops working offline.
  assert.doesNotMatch(html, /fetch\(|XMLHttpRequest/, "the page must not call back to the server");
});

test("the page is free, and asking for it never trips the paywall", async () => {
  for (const path of ["/", "/robots.txt", "/sitemap.xml"]) {
    const response = await app.fetch(new Request(`http://localhost${path}`));
    assert.equal(response.status, 200, `${path} must be free`);
    assert.equal(response.headers.get("payment-required"), null, `${path} must not be paywalled`);
  }
});

test("crawlers are pointed at the sitemap", async () => {
  const robots = await (await app.fetch(new Request("http://localhost/robots.txt"))).text();
  assert.match(robots, /^User-agent: \*/m);
  assert.match(robots, /Sitemap: http:\/\/localhost\/sitemap\.xml/);

  const sitemap = await (await app.fetch(new Request("http://localhost/sitemap.xml"))).text();
  assert.match(sitemap, /<urlset/);
  assert.match(sitemap, /<loc>http:\/\/localhost\/<\/loc>/);
});

test("page visits are counted, so arrivals are visible in /stats", async () => {
  const rows = [];
  const db = {
    prepare(sql) {
      return {
        bind: (...args) => ({ run: async () => rows.push(args) }),
        run: async () => {},
        all: async () => ({ results: [] }),
      };
    },
  };
  const pending = [];
  await app.fetch(new Request("http://localhost/"), { DB: db }, {
    waitUntil: (promise) => pending.push(Promise.resolve(promise)),
  });
  await Promise.allSettled(pending);

  const visit = rows.find((args) => args[0] === "/");
  assert.ok(visit, "a visit to / must be recorded");
  // endpoint, paidAttempt, settledSuccess, freeRequest, challenge
  assert.deepEqual(visit.slice(1), [0, 0, 1, 0], "a page visit is a free request, never a paid one");
});

// A custom domain must not keep advertising the workers.dev URL as the real
// one, or a search engine drops the custom domain in favour of a page it was
// told is a duplicate.
test("the page's own URLs follow whichever domain served it", async () => {
  for (const host of ["jsontriage.example", "penniless-json-repair.sjaman.workers.dev"]) {
    const page = await (await app.fetch(new Request(`https://${host}/`))).text();
    assert.match(page, new RegExp(`<link rel="canonical" href="https://${host}/"`), `${host} canonical`);
    assert.match(page, new RegExp(`<meta property="og:url" content="https://${host}/"`), `${host} og:url`);
    assert.doesNotMatch(page, /canonical" href="https:\/\/penniless-json-repair[^"]*"[\s\S]*jsontriage/, "no cross-domain canonical");

    const sitemap = await (await app.fetch(new Request(`https://${host}/sitemap.xml`))).text();
    assert.match(sitemap, new RegExp(`<loc>https://${host}/</loc>`), `${host} sitemap`);

    const robots = await (await app.fetch(new Request(`https://${host}/robots.txt`))).text();
    assert.match(robots, new RegExp(`Sitemap: https://${host}/sitemap\\.xml`), `${host} robots`);
  }
});
