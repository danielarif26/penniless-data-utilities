import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HTTPFacilitatorClient } from "@x402/core/server";
import app from "../src/index.js";
import { NETWORK } from "../src/shared.js";
import { applyToken, clearToken, isFileToken, normalizeToken } from "../scripts/set-google-verification.mjs";

const CONFIG = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

// Keep the real payment middleware, minus the network call it makes on first
// use, so the paywall assertion below exercises the real 402 path.
const realGetSupported = HTTPFacilitatorClient.prototype.getSupported;
HTTPFacilitatorClient.prototype.getSupported = async () => ({
  kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
  extensions: [],
  signers: {},
});
test.after(() => { HTTPFacilitatorClient.prototype.getSupported = realGetSupported; });
const TAG_TOKEN = "Xy3_aB9cD1eF2gH3iJ4kL5mN6oP7qR8sT9uV0wX1yZ";
const FILE_TOKEN = "google1a2b3c4d5e6f7890.html";

test("the value is accepted however Search Console presented it", () => {
  // Search Console shows the tag method as a whole meta element, and people
  // copy the element rather than picking the token out of it.
  const pasted = {
    [TAG_TOKEN]: TAG_TOKEN,
    [`  ${TAG_TOKEN}  `]: TAG_TOKEN,
    [`<meta name="google-site-verification" content="${TAG_TOKEN}" />`]: TAG_TOKEN,
    [`<meta name='google-site-verification' content='${TAG_TOKEN}'>`]: TAG_TOKEN,
    [FILE_TOKEN]: FILE_TOKEN,
    [`/${FILE_TOKEN}`]: FILE_TOKEN,
    [`https://json.sjaman.dev/${FILE_TOKEN}`]: FILE_TOKEN,
  };
  for (const [written, expected] of Object.entries(pasted)) {
    assert.equal(normalizeToken(written).token, expected, `accepts ${JSON.stringify(written)}`);
  }
});

test("each method is recognised for what it is", () => {
  assert.equal(normalizeToken(TAG_TOKEN).method, "tag");
  assert.equal(normalizeToken(FILE_TOKEN).method, "file");
  assert.equal(isFileToken(FILE_TOKEN), true);
  assert.equal(isFileToken(TAG_TOKEN), false);
});

test("a value that is not a verification token is refused with a reason", () => {
  for (const written of ["", "   ", undefined, "hello", "short", "has spaces in it", "google.html"]) {
    const result = normalizeToken(written);
    assert.equal(result.token, undefined, `${JSON.stringify(written)} must be refused`);
    assert.match(result.error, /\w/, "and must say why");
  }
});

test("setting a token twice replaces it rather than stacking", () => {
  const once = applyToken(CONFIG, TAG_TOKEN);
  const twice = applyToken(once, "Zz9_yY8xX7wW6vV5uU4tT3sS2rR1qQ0pP9oO8nN7m");
  assert.equal(twice.match(/^GOOGLE_SITE_VERIFICATION/gm)?.length, 1);
  assert.doesNotMatch(twice, new RegExp(TAG_TOKEN));
  assert.equal(clearToken(clearToken(twice)), clearToken(twice), "and clearing is idempotent");
  assert.doesNotMatch(clearToken(twice), /^GOOGLE_SITE_VERIFICATION/m);
  // The payout address and bindings must survive both operations.
  for (const kept of ["[vars]", 'X402_PAY_TO = "0x3D98800c64C345950E1eAaa076D88C12d1BF5F37"']) {
    assert.ok(clearToken(twice).includes(kept), `must keep ${kept}`);
  }
});

test("the HTML tag method puts the meta in the page, and nothing when unset", async () => {
  const verified = await (await app.fetch(new Request("https://json.sjaman.dev/"), {
    GOOGLE_SITE_VERIFICATION: TAG_TOKEN,
  })).text();
  assert.match(verified, new RegExp(`<meta name="google-site-verification" content="${TAG_TOKEN}">`));

  for (const unset of [undefined, "", "   "]) {
    const plain = await (await app.fetch(new Request("https://json.sjaman.dev/"), {
      GOOGLE_SITE_VERIFICATION: unset,
    })).text();
    assert.doesNotMatch(plain, /google-site-verification/, `no stray meta for ${JSON.stringify(unset)}`);
  }
});

test("the file method is served at the issued name, echoing that name back", async () => {
  const env = { GOOGLE_SITE_VERIFICATION: FILE_TOKEN };
  const response = await app.fetch(new Request(`https://json.sjaman.dev/${FILE_TOKEN}`), env);
  assert.equal(response.status, 200);
  assert.equal((await response.text()).trim(), `google-site-verification: ${FILE_TOKEN}`);
});

test("only the issued filename is answered", async () => {
  const env = { GOOGLE_SITE_VERIFICATION: FILE_TOKEN };
  for (const other of ["google0000000000000000.html", "googleabc.html"]) {
    const response = await app.fetch(new Request(`https://json.sjaman.dev/${other}`), env);
    assert.equal(response.status, 404, `${other} must not be served`);
  }
  // And nothing is served at all when no file token is configured.
  const unset = await app.fetch(new Request(`https://json.sjaman.dev/${FILE_TOKEN}`), {});
  assert.equal(unset.status, 404);
  const tagOnly = await app.fetch(new Request(`https://json.sjaman.dev/${FILE_TOKEN}`), {
    GOOGLE_SITE_VERIFICATION: TAG_TOKEN,
  });
  assert.equal(tagOnly.status, 404, "a tag token must not serve a file");
});

test("a file token never leaks into the page as a meta tag", async () => {
  const page = await (await app.fetch(new Request("https://json.sjaman.dev/"), {
    GOOGLE_SITE_VERIFICATION: FILE_TOKEN,
  })).text();
  assert.doesNotMatch(page, /google-site-verification/, "the file method does not use a meta tag");
});

test("verification never disturbs the paid API or the tool itself", async () => {
  const env = { GOOGLE_SITE_VERIFICATION: TAG_TOKEN };
  const paid = await app.fetch(new Request("https://json.sjaman.dev/repair/json", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "{a:1,}" }),
  }), env);
  assert.equal(paid.status, 402, "paid routes still ask for payment");

  const page = await app.fetch(new Request("https://json.sjaman.dev/"), env);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /JSON Triage/);
});
