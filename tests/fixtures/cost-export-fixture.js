/*
 * ToggleLogic (Free Tier) — synthetic monthly ledger export fixture.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
const call = (extra) => ({ kind: "call", ts: "2026-09-01T00:00:00Z", deploymentId: "deployment-a",
  costCenter: "team", provider: "example", model: "model-v1", resolvedRef: "example/model-v1",
  inputTok: 10, outputTok: 5, cacheReadTok: 2, cacheWriteTok: 0,
  costUsd: 0.25, priceSource: "models.dev", priceVersion: 12345, requestId: "request-a", ...extra });
export const rotated = [
  call({ ts: "2026-08-31T23:59:59.999Z", costUsd: 999 }),
  call({}),
  call({ ts: "2026-09-02T00:00:00Z", usageMissing: true, costUsd: null, requestId: "request-b" }),
  call({ ts: "2026-09-03T00:00:00Z", deploymentId: "deployment-b", provider: "remote", model: "model",
    resolvedRef: "remote/model", unpriced: true, costUsd: null, priceSource: null, priceVersion: null, requestId: null }),
];
export const current = [
  call({ ts: "2026-09-04T00:00:00Z", billable: false, costUsd: 0.5, costCenter: "team-west", requestId: "request-c" }),
  call({ ts: "2026-09-05T00:00:00Z", invoiceEligible: true, costUsd: 0.1, requestId: "request-d" }),
  call({ ts: "2026-10-01T00:30:00+01:00", model: "model-v2", resolvedRef: "example/model-v2", costUsd: 0.2, requestId: "request-e" }),
  call({ ts: "2026-10-01T00:00:00Z", costUsd: 999 }),
  { kind: "summary", ts: "2026-09-20T00:00:00Z", pricedUsd: 1000 },
];
