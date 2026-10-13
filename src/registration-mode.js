/*
 * ToggleLogic (Free Tier) — host registration-mode handling.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
export function shouldSkipRuntimeRegistration(registrationMode) {
  return registrationMode === "cli-metadata";
}
