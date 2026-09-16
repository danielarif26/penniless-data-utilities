import { parseDocument } from "yaml";

// Parse YAML 1.2 core syntax with duplicate-key checks and bounded alias expansion.
// The HTTP/MCP schema already caps input at 200 KiB; maxAliasCount prevents
// anchor/alias expansion from turning a small document into excessive work.
export function yamlToValue(input) {
  if (typeof input !== "string") return { ok: false, error: "input must be a string" };

  let doc;
  try {
    doc = parseDocument(input, {
      schema: "core",
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
  } catch (error) {
    return { ok: false, error: `invalid YAML: ${error.message}`, value: null, warnings: [] };
  }

  const warnings = (doc.warnings || []).map((warning) => warning.message);
  if (doc.errors?.length) {
    return {
      ok: false,
      error: `invalid YAML: ${doc.errors.map((error) => error.message).join("; ")}`,
      value: null,
      warnings,
    };
  }

  try {
    return { ok: true, value: doc.toJS({ maxAliasCount: 50 }), warnings };
  } catch (error) {
    return { ok: false, error: `invalid YAML: ${error.message}`, value: null, warnings };
  }
}
