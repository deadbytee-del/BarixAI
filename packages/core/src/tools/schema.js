// Minimal JSON-Schema validator (type, required, enum, min/max, items, properties, additionalProperties:false).
// Errors are written for a model to read and self-correct from.
/** Remap well-known alias keys (schema property `aliases`) and wrap a lone object/value where an array is expected. */
function normalize(schema, value) {
  if (schema.type === "array" && value !== null && !Array.isArray(value) && typeof value === "object" && schema.items) return [normalize(schema.items, value)];
  if (schema.type === "array" && schema.items && Array.isArray(value)) return value.map((v) => normalize(schema.items, v));
  if (schema.type === "object" && schema.properties && value && typeof value === "object" && !Array.isArray(value)) {
    const out = { ...value };
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (!(k in out)) for (const a of sub.aliases ?? []) if (a in out) { out[k] = out[a]; delete out[a]; break; }
      if (k in out) out[k] = normalize(sub, out[k]);
    }
    return out;
  }
  return value;
}
export function validate(schema, value, path = "args") {
  if (path === "args") value = normalize(schema, value);
  const errs = [];
  const t = schema.type;
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (t && !(t === actual || (t === "integer" && Number.isInteger(value)) || (t === "number" && actual === "number"))) {
    // forgiving coercion for models that quote numbers/booleans
    if (t === "number" || t === "integer") { if (typeof value === "string" && value.trim() !== "" && !isNaN(+value)) return { ok: true, value: +value, errors: [] }; }
    if (t === "boolean" && (value === "true" || value === "false")) return { ok: true, value: value === "true", errors: [] };
    return { ok: false, errors: [`${path}: expected ${t}, got ${actual}`] };
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(", ")}`);
  if (typeof value === "number") { if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: must be >= ${schema.minimum}`); if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: must be <= ${schema.maximum}`); }
  if (typeof value === "string") { if (schema.minLength && value.length < schema.minLength) errs.push(`${path}: must not be empty`); if (schema.maxLength && value.length > schema.maxLength) errs.push(`${path}: too long (${value.length} > ${schema.maxLength})`); }
  let out = value;
  if (t === "array" && schema.items) { out = []; value.forEach((v, i) => { const r = validate(schema.items, v, `${path}[${i}]`); if (!r.ok) errs.push(...r.errors); out.push(r.ok ? r.value : v); }); }
  if (t === "object" && schema.properties) {
    out = { ...value };
    for (const k of schema.required ?? []) if (!(k in value) || value[k] === undefined) errs.push(`${path}.${k}: required`);
    for (const [k, sub] of Object.entries(schema.properties)) if (k in value && value[k] !== undefined) { const r = validate(sub, value[k], `${path}.${k}`); if (!r.ok) errs.push(...r.errors); else out[k] = r.value; }
    if (schema.additionalProperties === false) for (const k of Object.keys(value)) if (!(k in schema.properties)) errs.push(`${path}.${k}: unknown parameter (allowed: ${Object.keys(schema.properties).join(", ")})`);
  }
  return errs.length ? { ok: false, errors: errs } : { ok: true, value: out, errors: [] };
}
