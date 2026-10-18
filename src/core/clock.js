/*
 * ToggleLogic (Free Tier) — injectable clock.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */

/** Milliseconds since the epoch. Tests inject a fixed or stepping clock instead. */
export const systemClock = () => Date.now();
