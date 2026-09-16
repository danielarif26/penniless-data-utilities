#!/usr/bin/env node
// Points a custom domain at this Worker: `npm run domain json.example.com`.
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

// A hostname, not a URL: people reach for the address bar, so take what they
// paste from it and reduce it rather than rejecting it over a scheme.
export function normalizeHost(raw) {
  if (typeof raw !== "string") return { error: "pass a domain, e.g. npm run domain json.example.com" };
  let host = raw.trim().toLowerCase();
  if (!host) return { error: "pass a domain, e.g. npm run domain json.example.com" };

  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (host.includes("@")) return { error: `"${raw}" looks like an email address, not a domain` };
  if (host.includes(":")) return { error: `"${raw}" has a port in it; use just the domain` };
  if (host.endsWith(".workers.dev")) {
    return { error: "that is the workers.dev address, which already works — this is for a domain you own" };
  }
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) {
    return { error: `"${raw}" is not a domain name. Expected something like example.com or json.example.com` };
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

export function applyDomain(toml, host) {
  let next = setRoutes(toml, host);
  // Routes alone can retire the workers.dev subdomain; the paid API is
  // advertised there, so say explicitly that it stays.
  next = setTopLevel(next, "workers_dev", "workers_dev = true");
  next = setCanonicalHost(next, host);
  return next;
}

function main(argv) {
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

  If the deploy says the zone is not found, the domain is registered
  somewhere else and has not been added to this Cloudflare account yet.
`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
