#!/usr/bin/env node
// Points a custom domain at this Worker: `npm run domain json.mysite.dev`.
// Undo with `npm run domain clear`.
//
// Attaching a domain is two edits that have to agree. `routes` with
// custom_domain tells Cloudflare to serve the Worker there and issue the
// certificate on the next deploy; CANONICAL_HOST tells the page to name that
// domain as the real one, so it and the workers.dev host stop competing as
// duplicates in search. Doing one without the other is the common way this
// goes wrong, so this does both or neither.
//
// The workers.dev subdomain is kept alive on purpose: the paid API advertises
// it in its discovery documents and two directory listings already reference
// it, so it has to keep answering.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CONFIG = join(dirname(dirname(fileURLToPath(import.meta.url))), "wrangler.toml");

// Domains nobody can own. A placeholder that reaches the config is worse than
// a typo: the route fails, but CANONICAL_HOST still deploys, and the live page
// spends the next while telling search engines its real address is a domain
// that belongs to someone else.
const UNOWNABLE = [
  // Reserved by RFC 2606 and RFC 6761, at any depth: sub.example.com is no
  // more ownable than example.com.
  /(^|\.)example\.(com|net|org)$/,
  /\.(example|invalid|localhost|test|local)$/,
  // The words people leave in when they paste an instruction verbatim.
  /(^|\.)(your|my|the)[-.]?(domain|site|website)\.[a-z]{2,}$/,
  /(^|\.)(domain|mydomain|yourdomain|mysite|yoursite|website|sample|placeholder|foo|bar|test)\.(com|net|org)$/,
]

// Undo: takes the domain back out so a failed attempt can be cleaned up.
export const CLEAR_WORDS = new Set(["--clear", "-clear", "clear", "none", "remove", "reset"]);

// A hostname, not a URL: people reach for the address bar, so take what they
// paste from it and reduce it rather than rejecting it over a scheme.
export function normalizeHost(raw) {
  if (typeof raw !== "string") return { error: "pass a domain, e.g. npm run domain json.mysite.dev" };
  let host = raw.trim().toLowerCase();
  if (!host) return { error: "pass a domain, e.g. npm run domain json.mysite.dev" };

  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (host.includes("@")) return { error: `"${raw}" looks like an email address, not a domain` };
  if (host.includes(":")) return { error: `"${raw}" has a port in it; use just the domain` };
  if (host.endsWith(".workers.dev")) {
    return { error: "that is the workers.dev address, which already works — this is for a domain you own" };
  }
  if (/[<>{}]/.test(host)) {
    return { error: `"${raw}" still has placeholder brackets in it — put your own domain there` };
  }
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) {
    return { error: `"${raw}" is not a domain name. Expected something like jsontools.dev or json.mysite.dev` };
  }
  if (UNOWNABLE.some((pattern) => pattern.test(host))) {
    return { error: `"${raw}" is a placeholder, not a domain you own. Use one of your real domains.` };
  }
  return { host };
}

// Top-level TOML keys have to sit above the first [table], or they silently
// become part of whichever table precedes them.
function setTopLevel(toml, key, line) {
  const existing = new RegExp(`^${key}\\s*=.*$`, "m");
  if (existing.test(toml)) return toml.replace(existing, line);
  const firstTable = toml.search(/^\[/m);
  if (firstTable === -1) return `${toml.trimEnd()}\n${line}\n`;
  return `${toml.slice(0, firstTable)}${line}\n\n${toml.slice(firstTable)}`;
}

function setRoutes(toml, host) {
  const block = `routes = [\n  { pattern = "${host}", custom_domain = true }\n]`;
  const existing = /^routes\s*=\s*\[[\s\S]*?^\]/m;
  if (existing.test(toml)) return toml.replace(existing, block);
  const firstTable = toml.search(/^\[/m);
  if (firstTable === -1) return `${toml.trimEnd()}\n${block}\n`;
  return `${toml.slice(0, firstTable)}${block}\n\n${toml.slice(firstTable)}`;
}

function setCanonicalHost(toml, host) {
  const line = `CANONICAL_HOST = "${host}"`;
  const commented = /^#\s*CANONICAL_HOST\s*=.*$/m;
  const active = /^CANONICAL_HOST\s*=.*$/m;
  if (active.test(toml)) return toml.replace(active, line);
  if (commented.test(toml)) return toml.replace(commented, line);
  return toml.replace(/^\[vars\]\s*$/m, `[vars]\n${line}`);
}

// Puts the file back the way it was before a domain was set, so a failed
// attempt leaves nothing behind claiming to be the canonical address.
export function clearDomain(toml) {
  let next = toml.replace(/^routes\s*=\s*\[[\s\S]*?^\]\n*/m, "");
  next = next.replace(/^workers_dev\s*=.*\n*/m, "");
  next = next.replace(/^CANONICAL_HOST\s*=.*$/m,
    '# CANONICAL_HOST = "example.com"');
  return next;
}

export function applyDomain(toml, host) {
  let next = setRoutes(toml, host);
  // Routes alone can retire the workers.dev subdomain; the paid API is
  // advertised there, so say explicitly that it stays.
  next = setTopLevel(next, "workers_dev", "workers_dev = true");
  next = setCanonicalHost(next, host);
  return next;
}

function main(argv) {
  if (CLEAR_WORDS.has(String(argv[0] ?? "").trim().toLowerCase())) {
    const before = readFileSync(CONFIG, "utf8");
    const after = clearDomain(before);
    if (after === before) {
      console.log("\n  No custom domain was set. Nothing to undo.\n");
      return;
    }
    writeFileSync(CONFIG, after);
    console.log("\n  Removed the custom domain. The workers.dev address is the canonical one again."
      + "\n\n  Next:  npm run ship\n");
    return;
  }

  const { host, error } = normalizeHost(argv[0]);
  if (error) {
    console.error(`\n  ${error}\n`);
    process.exit(1);
  }

  const before = readFileSync(CONFIG, "utf8");
  const after = applyDomain(before, host);
  if (after === before) {
    console.log(`\n  ${host} is already configured. Run: npm run ship\n`);
    return;
  }
  writeFileSync(CONFIG, after);

  console.log(`
  Set up ${host}

    - the Worker will answer on it, with a certificate Cloudflare issues
    - the page will name it as its canonical address for search
    - the existing workers.dev address keeps working

  Next:  npm run ship

  If the deploy says the zone is not found, this domain is not in your
  Cloudflare account. Undo it with:  npm run domain clear
`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
