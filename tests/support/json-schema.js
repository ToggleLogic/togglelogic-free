/*
 * ToggleLogic (Free Tier) — minimal JSON Schema checker for the Decision API v1 tests.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */

// Supports exactly the keywords the v1 schemas use: type, const, enum,
// properties, additionalProperties, required, maxLength, pattern, minimum,
// items, maxItems, uniqueItems, if/then and local $ref. Unknown keywords fail
// loudly so a schema change cannot be silently unchecked. Test-only; not shipped.
const KNOWN = new Set(["$schema", "$id", "title", "description", "$defs", "type", "const", "enum", "properties",
  "additionalProperties", "required", "maxLength", "pattern", "minimum", "items", "maxItems", "uniqueItems", "if", "then", "$ref"]);

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

export function validate(schema, value, root = schema, at = "$") {
  const errors = [];
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`schema keyword not supported by the test checker: ${key} at ${at}`);
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], root);
    if (!target) throw new Error(`unresolved $ref ${schema.$ref}`);
    return validate(target, value, root, at);
  }
  const t = typeOf(value);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [`${at}: expected ${types.join("|")}, got ${t}`];
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === "string") {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${at}: items not unique`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, root, `${at}[${i}]`)));
  }
  if (t === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}: missing ${key}`);
    for (const [key, v] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validate(schema.properties[key], v, root, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${key}`);
    }
  }
  if (schema.if && validate(schema.if, value, root, at).length === 0 && schema.then) errors.push(...validate(schema.then, value, root, at));
  return errors;
}
