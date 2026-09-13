// Network/data lookups backed by free, keyless public upstreams (RDAP, DNS over
// HTTPS, GitHub public REST). Deterministic normalization; upstream fetch is
// injectable so tests run without network.

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const GH_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const RECORD_TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, CAA: 257 };
const TYPE_NAMES = Object.fromEntries(Object.entries(RECORD_TYPES).map(([k, v]) => [v, k]));

export function normalizeDomain(input) {
  if (typeof input !== "string") return { ok: false, error: "field 'domain' must be a string" };
  let d = input.trim().toLowerCase().replace(/\.$/, "");
  try { d = new URL(d.includes("://") ? d : `https://${d}`).hostname; } catch { /* keep raw for regex rejection */ }
  d = d.replace(/\.$/, "");
  if (!DOMAIN_RE.test(d)) return { ok: false, error: "invalid domain" };
  return { ok: true, domain: d };
}

function vcardFn(vcardArray) {
  if (!Array.isArray(vcardArray) || vcardArray[0] !== "vcard") return null;
  const props = vcardArray[1];
  if (!Array.isArray(props)) return null;
  for (const item of props) {
    if (Array.isArray(item) && String(item[0]).toLowerCase() === "fn" && typeof item[3] === "string") return item[3];
  }
  return null;
}

export function parseRdap(domain, rdap) {
  const events = {};
  for (const e of rdap.events || []) {
    if (e && e.eventAction && e.eventDate) events[e.eventAction] = e.eventDate;
  }
  const nameservers = (rdap.nameservers || [])
    .map((n) => (n && (n.ldhName || n.ptrName || n.handle) ? String(n.ldhName || n.ptrName || n.handle).toLowerCase() : null))
    .filter(Boolean);
  let registrar = null, ianaId = null;
  for (const ent of rdap.entities || []) {
    const roles = ent.roles || [];
    if (roles.includes("registrar")) {
      registrar = registrar || vcardFn(ent.vcardArray) || null;
      for (const pid of ent.publicIds || []) if (pid.identifier === "IANA ID") ianaId = pid.value;
    }
  }
  const secure = (rdap.secureDNS && rdap.secureDNS.zoneSigned !== undefined)
    ? { signed: !!rdap.secureDNS.zoneSigned, maxTLA: rdap.secureDNS.maxSubjectPublicKeyAlgorithm, maxFRL: rdap.secureDNS.maxValidUntil }
    : undefined;
  return {
    ok: true, found: true, domain,
    handle: rdap.handle || null,
    status: rdap.status || [],
    registrar: registrar || null,
    ianaId: ianaId || null,
    nameservers,
    events,
    dnssec: secure,
    ldhName: rdap.ldhName || null,
    unicodeName: rdap.unicodeName || null,
  };
}

export async function whois(domain, fetchImpl = fetch) {
  const v = normalizeDomain(domain);
  if (!v.ok) return v;
  let res;
  try {
    res = await fetchImpl(`https://rdap.org/domain/${v.domain}`, { headers: { Accept: "application/rdap+json", "User-Agent": "penniless-x402/1.0" }, redirect: "follow" });
  } catch {
    return { ok: false, error: "upstream RDAP lookup failed" };
  }
  if (res.status === 404) return { ok: true, found: false, domain: v.domain };
  if (!res.ok) return { ok: false, error: `upstream RDAP status ${res.status}`, domain: v.domain };
  let data;
  try { data = await res.json(); } catch { return { ok: false, error: "upstream RDAP returned non-JSON" }; }
  return parseRdap(v.domain, data);
}

export async function dnsLookup(domain, type = "A", fetchImpl = fetch) {
  const v = normalizeDomain(domain);
  if (!v.ok) return v;
  const t = String(type || "A").toUpperCase();
  const code = RECORD_TYPES[t];
  if (!code) return { ok: false, error: `unsupported record type '${t}'`, supported: Object.keys(RECORD_TYPES) };
  let res;
  try {
    res = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(v.domain)}&type=${code}`, { headers: { Accept: "application/dns-json" } });
  } catch {
    return { ok: false, error: "upstream DoH lookup failed" };
  }
  if (!res.ok) return { ok: false, error: `upstream DoH status ${res.status}`, domain: v.domain };
  let data;
  try { data = await res.json(); } catch { return { ok: false, error: "upstream DoH returned non-JSON" }; }
  const answers = (data.Answer || []).map((a) => ({
    name: (a.name || "").replace(/\.$/, "").toLowerCase(),
    type: TYPE_NAMES[a.type] || String(a.type),
    ttl: a.TTL,
    data: a.data,
  }));
  const statusName = ["NOERROR", "FORMERR", "SERVFAIL", "NXDOMAIN", "NOTIMP", "REFUSED"][data.Status] || String(data.Status);
  return { ok: true, domain: v.domain, type: t, status: statusName, answers };
}

export async function githubRepoStats(repo, fetchImpl = fetch) {
  let slug = repo;
  if (typeof slug === "string" && slug.trim()) {
    slug = slug.trim().replace(/\.git$/, "").replace(/^https?:\/\/github\.com\//, "");
  }
  if (typeof slug !== "string" || !GH_RE.test(slug)) return { ok: false, error: "field 'repo' must be 'owner/name'" };
  const [owner, name] = slug.split("/");
  const norm = `${owner.toLowerCase()}/${name.toLowerCase()}`;
  let res;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "penniless-x402" } });
  } catch {
    return { ok: false, error: "upstream GitHub API request failed" };
  }
  if (res.status === 404) return { ok: true, found: false, repo: norm };
  if (res.status === 403 || res.status === 429) return { ok: false, error: "GitHub API rate limit reached; retry later", repo: norm };
  if (!res.ok) return { ok: false, error: `upstream GitHub status ${res.status}`, repo: norm };
  let d;
  try { d = await res.json(); } catch { return { ok: false, error: "upstream GitHub returned non-JSON" }; }
  return {
    ok: true, found: true, repo: norm,
    stars: d.stargazers_count || 0, forks: d.forks_count || 0,
    openIssues: d.open_issues_count || 0, watchers: d.subscribers_count ?? d.watchers_count ?? 0,
    language: d.language || null, license: d.license && d.license.spdx_id ? d.license.spdx_id : null,
    defaultBranch: d.default_branch || null, archived: !!d.archived, fork: !!d.fork,
    createdAt: d.created_at || null, pushedAt: d.pushed_at || null, updatedAt: d.updated_at || null,
    description: d.description || null, homepage: d.homepage || null, topics: d.topics || [],
  };
}

export function validateEmailSyntax(email) {
  if (typeof email !== "string") return { ok: false, error: "field 'email' must be a string" };
  const e = email.trim();
  if (e.length > 320) return { ok: false, error: "email too long" };
  const formatValid = EMAIL_RE.test(e);
  const at = e.lastIndexOf("@");
  const domain = at >= 0 ? e.slice(at + 1).toLowerCase().replace(/\.$/, "") : "";
  return { ok: true, email: e, formatValid, local: at >= 0 ? e.slice(0, at) : e, domain };
}

export async function validateEmail(email, fetchImpl = fetch) {
  const s = validateEmailSyntax(email);
  if (!s.ok) return s;
  if (!s.formatValid) return { ...s, valid: false, mx: [], domainHasMx: false, reason: "invalid format" };
  const dns = await dnsLookup(s.domain, "MX", fetchImpl);
  if (!dns.ok) return { ok: false, error: dns.error, email: s.email, formatValid: true, domain: s.domain };
  const mx = dns.answers.map((a) => {
    const m = /^(\d+)\s+(\S+?)\.?$/.exec(String(a.data).trim());
    return m ? { preference: Number(m[1]), host: m[2].toLowerCase() } : { preference: null, host: String(a.data).toLowerCase() };
  }).sort((a, b) => (a.preference ?? 0) - (b.preference ?? 0));
  const domainHasMx = mx.length > 0;
  // RFC 7505: a single MX of "0 ." means the domain deliberately accepts no mail.
  const nullMx = mx.length === 1 && mx[0].host === ".";
  let reason = null;
  if (nullMx) reason = "domain publishes a null MX record (accepts no mail)";
  else if (!domainHasMx && dns.status === "NOERROR") reason = "domain has no MX records";
  else if (!domainHasMx && dns.status === "NXDOMAIN") reason = "domain does not exist";
  const valid = domainHasMx && !nullMx;
  return { ok: true, email: s.email, local: s.local, domain: s.domain, formatValid: true, domainHasMx, valid, mx, status: dns.status, ...(reason ? { reason } : {}) };
}
