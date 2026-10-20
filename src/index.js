/*
 * ToggleLogic (Free Tier) — package entry point (the OpenClaw plugin).
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { createOpenClawPluginEntry } from "./adapters/openclaw/entry.js";

const PLUGIN_VERSION = "2.2.0";

export default createOpenClawPluginEntry({ version: PLUGIN_VERSION });
