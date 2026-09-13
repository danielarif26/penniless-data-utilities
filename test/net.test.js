import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDomain, parseRdap, whois, dnsLookup, githubRepoStats, validateEmailSyntax, validateEmail } from "../src/net.js";

function jsonRes(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function fakeFetch(handlers) {
  return async (url) => {
    for (const [match, res] of handlers) {
      if (url.includes(match)) return typeof res === "function" ? res(url) : res;
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

// --- domain normalization ---
test("normalizeDomain accepts plain, URL, and trailing-dot forms", () => {
  for (const form of ["Example.COM", "https://Example.com/path", "example.com."]) {
    const r = normalizeDomain(form);
    assert.equal(r.ok, true, form);
    assert.equal(r.domain, "example.com", form);
  }
});

test("normalizeDomain rejects invalid and empty input", () => {
  for (const bad of ["", "not a domain", "-bad.com", "example", "http://"]) {
    assert.equal(normalizeDomain(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(normalizeDomain(undefined).ok, false);
  assert.equal(normalizeDomain(123).ok, false);
});

// --- RDAP parsing ---
const RDAP = {
  ldhName: "EXAMPLE.COM",
  handle: "2336799_DOMAIN_COM-VRSN",
  status: ["client transfer prohibited", "server delete prohibited"],
  events: [
    { eventAction: "registration", eventDate: "1995-08-14T04:00:00Z" },
    { eventAction: "expiration", eventDate: "2027-08-14T04:00:00Z" },
  ],
  entities: [{
    roles: ["registrar"],
    vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Example Registrar, Inc."]]],
    publicIds: [{ type: "IANA", identifier: "IANA ID", value: "381" }],
  }],
  nameservers: [{ ldhName: "A.IANA-SERVERS.NET" }, { ldhName: "B.IANA-SERVERS.NET" }, { junk: true }],
  secureDNS: { zoneSigned: true, maxSubjectPublicKeyAlgorithm: 13 },
};

test("parseRdap extracts registrar, dates, nameservers, dnssec", () => {
  const r = parseRdap("example.com", RDAP);
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.equal(r.registrar, "Example Registrar, Inc.");
  assert.equal(r.ianaId, "381");
  assert.equal(r.events.expiration, "2027-08-14T04:00:00Z");
  assert.equal(r.events.registration, "1995-08-14T04:00:00Z");
  assert.deepEqual(r.nameservers, ["a.iana-servers.net", "b.iana-servers.net"]);
  assert.equal(r.dnssec.signed, true);
  assert.equal(r.status.length, 2);
});

test("parseRdap tolerates a minimal RDAP document", () => {
  const r = parseRdap("x.io", {});
  assert.equal(r.ok, true);
  assert.equal(r.registrar, null);
  assert.deepEqual(r.nameservers, []);
  assert.deepEqual(r.status, []);
});

test("whois 404 reports found:false without error", async () => {
  const r = await whois("unregistered-xyz.example", fakeFetch([["rdap.org", jsonRes({}, 404)]]));
  assert.equal(r.ok, true);
  assert.equal(r.found, false);
});

test("whois resolves a real domain through the injected fetch", async () => {
  const r = await whois("example.com", fakeFetch([["rdap.org", jsonRes(RDAP)]]));
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.equal(r.registrar, "Example Registrar, Inc.");
});

test("whois rejects an invalid domain before any fetch", async () => {
  let called = false;
  const r = await whois("!!!", async () => { called = true; return jsonRes({}); });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

// --- DNS ---
const DOH_MX = {
  Status: 0,
  Question: [{ name: "example.com.", type: 15 }],
  Answer: [{ name: "example.com.", type: 15, TTL: 180, data: "10 mail.example.com." }],
};

test("dnsLookup returns typed answers", async () => {
  const r = await dnsLookup("example.com", "MX", fakeFetch([["dns-query", jsonRes(DOH_MX)]]));
  assert.equal(r.ok, true);
  assert.equal(r.status, "NOERROR");
  assert.equal(r.answers[0].type, "MX");
  assert.equal(r.answers[0].ttl, 180);
  assert.equal(r.answers[0].data, "10 mail.example.com.");
});

test("dnsLookup reports NXDOMAIN", async () => {
  const r = await dnsLookup("missing.test", "A", fakeFetch([["dns-query", jsonRes({ Status: 3 })]]));
  assert.equal(r.ok, true);
  assert.equal(r.status, "NXDOMAIN");
  assert.deepEqual(r.answers, []);
});

test("dnsLookup rejects unsupported record types", async () => {
  const r = await dnsLookup("example.com", "FQDN", fakeFetch([]));
  assert.equal(r.ok, false);
  assert.match(r.error, /unsupported record type/);
  assert.ok(r.supported.includes("TXT"));
});

// --- GitHub ---
const GH = {
  full_name: "CopperheadHQ/Copperhead", stargazers_count: 254, forks_count: 62, open_issues_count: 184,
  language: "TypeScript", license: { spdx_id: "Apache-2.0" }, default_branch: "main", archived: false,
  fork: false, created_at: "2026-07-18T08:58:46Z", pushed_at: "2026-09-13T20:41:25Z", updated_at: "2026-09-13T20:41:29Z",
  description: "Hardware as fast as software.", homepage: "", topics: ["kicad"],
};

test("githubRepoStats normalizes slug and returns metrics", async () => {
  const r = await githubRepoStats("https://github.com/CopperheadHQ/Copperhead.git", fakeFetch([["api.github.com", jsonRes(GH)]]));
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.equal(r.repo, "copperheadhq/copperhead");
  assert.equal(r.stars, 254);
  assert.equal(r.license, "Apache-2.0");
  assert.equal(r.pushedAt, "2026-09-13T20:41:25Z");
});

test("githubRepoStats 404 reports found:false", async () => {
  const r = await githubRepoStats("nope/nope", fakeFetch([["api.github.com", jsonRes({}, 404)]]));
  assert.equal(r.ok, true);
  assert.equal(r.found, false);
});

test("githubRepoStats rejects malformed slugs", async () => {
  for (const bad of ["", "only-owner", "a/b/c", 42]) {
    const r = await githubRepoStats(bad, fakeFetch([]));
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test("githubRepoStats surfaces rate limiting as a retryable error", async () => {
  const r = await githubRepoStats("a/b", fakeFetch([["api.github.com", jsonRes({ message: "rate limit" }, 403)]]));
  assert.equal(r.ok, false);
  assert.match(r.error, /rate limit/);
});

// --- email ---
test("validateEmailSyntax accepts and splits valid addresses", () => {
  const r = validateEmailSyntax("  Foo.Bar+tag@Example.com  ");
  assert.equal(r.ok, true);
  assert.equal(r.formatValid, true);
  assert.equal(r.local, "Foo.Bar+tag");
  assert.equal(r.domain, "example.com");
});

test("validateEmailSyntax rejects malformed addresses", () => {
  for (const bad of ["plainaddress", "@example.com", "a@b", "a b@example.com", "a@b..com", ""]) {
    assert.equal(validateEmailSyntax(bad).formatValid, false, JSON.stringify(bad));
  }
  assert.equal(validateEmailSyntax(123).ok, false);
});

test("validateEmail format-invalid short-circuits without a DNS call", async () => {
  let called = false;
  const r = await validateEmail("nope", async () => { called = true; return jsonRes({}); });
  assert.equal(called, false);
  assert.equal(r.valid, false);
  assert.equal(r.reason, "invalid format");
});

test("validateEmail confirms deliverable domain via MX", async () => {
  const r = await validateEmail("hi@example.com", fakeFetch([["dns-query", jsonRes({
    Status: 0, Answer: [{ name: "example.com.", type: 15, TTL: 300, data: "20 mail2.example.com." }, { name: "example.com.", type: 15, TTL: 300, data: "10 mail1.example.com." }],
  })]]));
  assert.equal(r.ok, true);
  assert.equal(r.valid, true);
  assert.equal(r.domainHasMx, true);
  assert.equal(r.mx[0].preference, 10, "sorted by preference");
  assert.equal(r.mx[0].host, "mail1.example.com");
});

test("validateEmail reports a domain with no MX", async () => {
  const r = await validateEmail("hi@empty.test", fakeFetch([["dns-query", jsonRes({ Status: 0 })]]));
  assert.equal(r.ok, true);
  assert.equal(r.valid, false);
  assert.equal(r.domainHasMx, false);
  assert.equal(r.reason, "domain has no MX records");
});

test("validateEmail treats RFC 7505 null MX as undeliverable", async () => {
  const r = await validateEmail("hi@example.com", fakeFetch([["dns-query", jsonRes({
    Status: 0, Answer: [{ name: "example.com.", type: 15, TTL: 180, data: "0 ." }],
  })]]));
  assert.equal(r.ok, true);
  assert.equal(r.valid, false, "'0 .' means the domain accepts no mail");
  assert.match(r.reason, /null MX/);
});
