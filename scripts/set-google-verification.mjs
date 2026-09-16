#!/usr/bin/env node
// Proves to Google Search Console that this site is yours:
//   npm run verify-google <token>
// Undo with `npm run verify-google clear`.
//
// Search Console offers several ways to prove ownership. Two of them are just
// strings it expects the site to return, which is something this Worker can do
// without anyone editing DNS or uploading files:
//
//   HTML tag   a <meta name="google-site-verification"> in the page head
//   HTML file  a googleXXXX.html file served at the site root
//
// Whichever one Search Console happens to show, paste the value it gives and
// this works out which is which — the file method names a .html file, the tag
// method is a bare token.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CONFIG = join(dirname(dirname(fileURLToPath(import.meta.url))), "wrangler.toml");
const CLEAR_WORDS = new Set(["--clear", "-clear", "clear", "none", "remove", "reset"]);

// The file method names a file; the tag method is a bare token. Telling them
// apart is what lets one command accept whichever Search Console offered.
export function isFileToken(token) {
  return /^google[a-z0-9_-]+\.html$/i.test(token);
}

// Search Console shows the tag as a whole <meta> element and the file method as
// a filename or a link to it, so accept the surrounding markup people copy
// along with the value rather than making them trim it by hand.
export function normalizeToken(raw) {
  if (typeof raw !== "string") return { error: "pass the value Search Console gave you, e.g. npm run verify-google abc123..." };
  let token = raw.trim();
  if (!token) return { error: "pass the value Search Console gave you, e.g. npm run verify-google abc123..." };

  const meta = token.match(/content\s*=\s*["']([^"']+)["']/i);
  if (meta) token = meta[1].trim();
  else if (/^https?:\/\//i.test(token)) token = token.replace(/^https?:\/\/[^/]+\//i, "").replace(/\?.*$/, "").trim();

  token = token.replace(/^\/+/, "");

  if (isFileToken(token)) return { token, method: "file" };
  if (/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { token, method: "tag" };

  return {
    error: `"${raw}" is not a Search Console verification value.\n`
      + `  Expected either a token like Xy3_aB... (HTML tag method)\n`
      + `  or a filename like google1a2b3c4d.html (HTML file method).`,
  };
}

export function applyToken(toml, token) {
  const line = `GOOGLE_SITE_VERIFICATION = "${token}"`;
  const active = /^GOOGLE_SITE_VERIFICATION\s*=.*$/m;
  const commented = /^#\s*GOOGLE_SITE_VERIFICATION\s*=.*$/m;
  if (active.test(toml)) return toml.replace(active, line);
  if (commented.test(toml)) return toml.replace(commented, line);
  return toml.replace(/^\[vars\]\s*$/m, `[vars]\n${line}`);
}

export function clearToken(toml) {
  return toml.replace(/^GOOGLE_SITE_VERIFICATION\s*=.*\n/m, "");
}

function main(argv) {
  const raw = String(argv[0] ?? "").trim();

  if (CLEAR_WORDS.has(raw.toLowerCase())) {
    const before = readFileSync(CONFIG, "utf8");
    const after = clearToken(before);
    if (after === before) {
      console.log("\n  No verification token was set. Nothing to undo.\n");
      return;
    }
    writeFileSync(CONFIG, after);
    console.log("\n  Removed the verification token.\n\n  Next:  npm run ship\n");
    return;
  }

  const { token, method, error } = normalizeToken(raw);
  if (error) {
    console.error(`\n  ${error}\n`);
    process.exit(1);
  }

  const before = readFileSync(CONFIG, "utf8");
  const after = applyToken(before, token);
  if (after !== before) writeFileSync(CONFIG, after);

  const how = method === "file"
    ? `the site will serve /${token}`
    : "the page will carry the verification meta tag";

  console.log(`
  Verification set up — ${how}

  Next:
    1. npm run ship
    2. back in Search Console, click Verify
    3. then submit  sitemap.xml  under Sitemaps

  The token can come out again afterwards with:  npm run verify-google clear
  Leaving it in place is fine too, and means re-verification never fails.
`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
