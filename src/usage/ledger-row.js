/*
 * ToggleLogic (Free Tier) — portable ledger identity and billing semantics.
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
  // Only terminal numeric version/date components: never infer a vendor family
  // or rewrite an internal number (for example model-2-fast stays unchanged).
  let base = model;
  for (;;) {
    const stripped = base.replace(/[-_.@:](?:v?\d+)(?:[-_.:]\d+)*$/i, "");
    if (stripped === base) break;
    base = stripped;
  }
  if (!/[a-z]/i.test(base) || /^v?\d+(?:[._:]\d+)*$/i.test(base) || base.endsWith("/")) {
    return { lineage: null, lineageReason: "no-model-stem" };
  }
  return { lineage: `${provider}/${base}`, lineageReason: null };
}

export function billingFields({ priced, usageMissing, billableDeployment = true }) {
  const billable = priced && !usageMissing && billableDeployment;
  return {
    billable: Boolean(billable), invoiceEligible: false,
    invoiceEligibleReason: !priced ? "unpriced" : usageMissing ? "usage-missing" :
      !billableDeployment ? "not-billable-deployment" : "public-rate-estimate",
  };
}

export function classifyLedgerCall(row) {
  const usageMissing = row.usageMissing === true || row.reason === "priced-but-usage-missing";
  const priced = !usageMissing && row.unpriced !== true &&
    typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd >= 0;
  return { priced, usageMissing, unpriced: !priced && !usageMissing };
}

export function dollarsToMicros(value) { return Math.round(value * 1e6); }
export function microsToDollars(value) { return value / 1e6; }
