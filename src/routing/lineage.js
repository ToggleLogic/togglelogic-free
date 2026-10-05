/*
 * ToggleLogic (Free Tier) — generic configured-model lineage resolution.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */

export function deriveLineage(resolvedRef) {
  if (typeof resolvedRef !== "string" || resolvedRef.length > 512 ||
      !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/@:+-]*$/i.test(resolvedRef)) {
    return { lineage: null, lineageReason: "invalid-qualified-reference" };
  }
  const split = resolvedRef.indexOf("/");
  const provider = resolvedRef.slice(0, split);
  const model = resolvedRef.slice(split + 1);
  // Remove explicitly delimited numeric/version/date components anywhere in
  // the model name. Dots belong to the numeric group, never delimit it:
  // attached qwen2.5 and size labels such as 7b remain literal.
  const base = model.replace(/[-_@:](?:v?\d+(?:\.\d+)*)(?=$|[-_@:])/gi, "");
  if (!/[a-z]/i.test(base) || /^v?\d+(?:[._:]\d+)*$/i.test(base) || base.endsWith("/")) {
    return { lineage: null, lineageReason: "no-model-stem" };
  }
  return { lineage: `${provider}/${base}`, lineageReason: null };
}

