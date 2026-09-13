// Dependency-free structured extraction from HTML or plain text.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripTags(html) {
  return decode(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}

export function extract(input, opts = {}) {
  const text = String(input);
  const looksHtml = /<[a-z!/?][^>]*>/i.test(text);
  const plain = looksHtml ? stripTags(text) : text;
  const out = { ok: true, source: looksHtml ? "html" : "text" };

  if (looksHtml) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    if (title) out.title = decode(title[1]).trim();
    out.headings = [...text.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)]
      .slice(0, 50)
      .map((m) => ({ level: Number(m[1]), text: decode(stripTags(m[2])).trim() }));
    out.links = [...text.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .slice(0, 200)
      .map((m) => ({ href: decode(m[1]), text: decode(stripTags(m[2])).trim() }));
  }

  const dedupe = (arr, cap) => [...new Set(arr)].slice(0, cap);
  out.urls = dedupe(plain.match(/https?:\/\/[^\s<>"')\]]+/g) || [], 200);
  out.emails = dedupe(plain.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [], 100);

  if (opts.numbers) {
    out.numbers = [...plain.matchAll(/-?\$?(\d[\d,]*(?:\.\d+)?%?)/g)].map((m) => m[1]).slice(0, 500);
  }
  if (opts.codeBlocks || looksHtml) {
    out.codeBlocks = [...text.matchAll(/```[\w+-]*\n([\s\S]*?)```/g)].map((m) => m[1]).slice(0, 50);
  }

  const trimmed = plain.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  out.textChars = trimmed.length;
  out.text = opts.fullText === false ? undefined : trimmed.slice(0, opts.maxText || 20000);
  return out;
}
