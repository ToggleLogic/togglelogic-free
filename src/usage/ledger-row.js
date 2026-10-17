/*
 * ToggleLogic (Free Tier) — portable ledger identity and billing semantics.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */

export { deriveLineage } from "../routing/lineage.js";

// Free 2.1.6 (TL-7): a deployment owner may opt in (costVisibility.attribution.
// invoiceEstimates: true) to treat priced, usage-complete, billable rows as
// invoice-eligible at public rates. The reason stays "public-rate-estimate" so
// every consumer sees the basis; provider-invoice reconciliation can still
// replace it later. Default off: rows stay ineligible as in 2.1.5.
export function billingFields({ priced, usageMissing, billableDeployment = true, invoiceEstimates = false }) {
  const billable = priced && !usageMissing && billableDeployment;
  return {
    billable: Boolean(billable), invoiceEligible: Boolean(billable && invoiceEstimates === true),
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
