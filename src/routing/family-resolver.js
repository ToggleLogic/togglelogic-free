/*
 * ToggleLogic Free — opt-in family alias resolver for configured routes.
 *
 * This is not a benchmark or prompt classifier. It resolves only an explicit
 * `family:<alias>` route against deployment-approved providers that are also
 * present in OpenClaw's provider configuration. Missing, stale, unpriced, or
 * ambiguous data returns null so routing safely passes through.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function expandTilde(value) {
  if (value === "~") return os.homedir();
  if (typeof value === "string" && value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizedProviderSet(values) {
  if (!Array.isArray(values)) return new Set();
  return new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean));
}

function matchesFamily(modelId, info, family) {
  const declared = String(info?.family || "").trim().toLowerCase();
  const id = String(modelId).trim().toLowerCase();
  return declared === family || id === family || id.startsWith(`${family}-`) || id.includes(`-${family}-`);
}

export class FamilyResolver {
  constructor(config = {}, logger = null) {
    this.enabled = config.enabled === true;
    this.catalogPath = expandTilde(config.catalogPath || "");
    this.maxAgeHours = Number.isFinite(config.maxAgeHours) ? config.maxAgeHours : 48;
    this.aliases = config.aliases && typeof config.aliases === "object" ? config.aliases : {};
    this.logger = logger;
  }

  resolve(alias, configuredProviders = []) {
    if (!this.enabled || !this.catalogPath) return null;
    const policy = this.aliases[alias];
    if (!policy || typeof policy !== "object") return null;
    const family = String(policy.family || "").trim().toLowerCase();
    if (!family) return null;

    const approved = normalizedProviderSet(policy.providers);
    const configured = normalizedProviderSet(configuredProviders);
    if (approved.size === 0 || configured.size === 0) return null;

    let parsed;
    try {
      const stats = fs.statSync(this.catalogPath);
      if (!stats.isFile() || Date.now() - stats.mtimeMs > this.maxAgeHours * 3600 * 1000) return null;
      parsed = JSON.parse(fs.readFileSync(this.catalogPath, "utf8"));
    } catch (error) {
      try { this.logger?.warn?.(`togglelogic: family catalog unavailable: ${error.message}`); } catch { /* ignore */ }
      return null;
    }

    const providers = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
    if (!providers || typeof providers !== "object") return null;
    const candidates = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      const providerKey = providerId.toLowerCase();
      if (!approved.has(providerKey) || !configured.has(providerKey)) continue;
      const models = provider?.models;
      if (!models || typeof models !== "object") continue;
      for (const [modelId, info] of Object.entries(models)) {
        if (!matchesFamily(modelId, info, family)) continue;
        const inputPerM = finitePositive(info?.cost?.input);
        const outputPerM = finitePositive(info?.cost?.output);
        if (inputPerM == null || outputPerM == null) continue;
        if (Number.isFinite(policy.maxInputPerM) && inputPerM > policy.maxInputPerM) continue;
        if (Number.isFinite(policy.maxOutputPerM) && outputPerM > policy.maxOutputPerM) continue;
        candidates.push({
          provider: providerId,
          modelId,
          inputPerM,
          outputPerM,
          blendedCost: inputPerM + outputPerM,
          releaseDate: String(info?.release_date || info?.releaseDate || "0000-00-00"),
        });
      }
    }
    if (candidates.length === 0) return null;

    if (policy.strategy === "newest") {
      candidates.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || a.blendedCost - b.blendedCost || a.modelId.localeCompare(b.modelId));
    } else {
      candidates.sort((a, b) => a.blendedCost - b.blendedCost || b.releaseDate.localeCompare(a.releaseDate) || a.modelId.localeCompare(b.modelId));
    }
    return candidates[0];
  }
}
