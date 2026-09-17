import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DELIVERY_MANIFEST_BEGIN = "<togglelogic_delivery_manifest_v1>";
export const DELIVERY_MANIFEST_END = "</togglelogic_delivery_manifest_v1>";

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARTIFACTS = 16;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function promptedPowerpointDirectories(prompt) {
  const text = String(prompt || "");
  const directories = new Set();
  // A path embedded in prose commonly ends with sentence punctuation, as in
  // deck.pptx. followed by another sentence. Accept only whitespace, end of
  // input, or ordinary sentence-closing punctuation after the extension.
  // Deliberately do not accept slash, so a path-like suffix cannot broaden
  // the authorized directory.
  const matches = text.matchAll(/\/(?:\\.|[^\r\n])+?\.pptx(?=\s|$|[.,;:!?'"’”)\]}])/gi);
  for (const match of matches) {
    const unescaped = match[0].replace(/\\(.)/g, "$1");
    directories.add(path.dirname(path.resolve(unescaped)));
  }
  return directories;
}

function promptAuthorizesPath(prompt, destination, allowBesidePromptedPptx) {
  const text = String(prompt || "");
  if (text.includes(destination) || text.includes(destination.replaceAll(" ", "\\ "))) return true;
  if (!allowBesidePromptedPptx) return false;
  // PowerPoint's owner-approved default is "new artifacts beside the explicitly
  // named source deck." Only that exact parent directory is authorized: no
  // descendants and no sibling directory. Existing files are still refused.
  return promptedPowerpointDirectories(text).has(path.dirname(destination));
}

export function isArtifactDestinationAuthorized(prompt, destination, { allowBesidePromptedPptx = false } = {}) {
  if (typeof destination !== "string" || !path.isAbsolute(destination)) return false;
  return promptAuthorizesPath(prompt, path.resolve(destination), allowBesidePromptedPptx);
}

export function artifactDeliveryInstructions(stagingDir) {
  return [
    "VERIFIED ARTIFACT DELIVERY CONTRACT (mandatory):",
    `1. Create new artifacts only in this run's staging directory: ${stagingDir}`,
    "2. Do not attempt to copy, move, or write an artifact to the requested final destination. The trusted parent performs that step after verification.",
    "3. Reopen and verify every staged artifact. Compute its SHA-256 from the final staged bytes.",
    `4. End the response with exactly one ${DELIVERY_MANIFEST_BEGIN} JSON ${DELIVERY_MANIFEST_END} block. JSON schema: {\"schema_version\":1,\"child_verification\":\"passed\",\"artifacts\":[{\"source\":\"absolute staged path\",\"destination\":\"absolute owner-requested final path\",\"sha256\":\"64 lowercase hex\",\"verified\":true}]}.`,
    "5. Include only an exact destination named by the owner, or (for this PowerPoint workflow) new output filenames directly beside an absolute source .pptx named in the owner task. Never use a descendant/sibling directory, claim a destination write, or speculate about destination permissions.",
  ].join("\n");
}

export function deliverArtifactManifest({ text, ownerPrompt, stagingDir, allowBesidePromptedPptx = false }) {
  const raw = String(text || "");
  const begin = raw.indexOf(DELIVERY_MANIFEST_BEGIN);
  const end = raw.indexOf(DELIVERY_MANIFEST_END);
  const second = begin >= 0 ? raw.indexOf(DELIVERY_MANIFEST_BEGIN, begin + DELIVERY_MANIFEST_BEGIN.length) : -1;
  const secondEnd = end >= 0 ? raw.indexOf(DELIVERY_MANIFEST_END, end + DELIVERY_MANIFEST_END.length) : -1;
  const trailing = end >= 0 ? raw.slice(end + DELIVERY_MANIFEST_END.length) : "";
  if (begin < 0 || end < begin || second >= 0 || secondEnd >= 0 || trailing.trim()) {
    return { status: "failed", cleanText: raw, entries: [], error: "missing or ambiguous delivery manifest" };
  }
  const jsonText = raw.slice(begin + DELIVERY_MANIFEST_BEGIN.length, end).trim();
  const cleanText = `${raw.slice(0, begin)}${raw.slice(end + DELIVERY_MANIFEST_END.length)}`.trim();
  if (Buffer.byteLength(jsonText) > MAX_MANIFEST_BYTES) {
    return { status: "failed", cleanText, entries: [], error: "delivery manifest exceeds size limit" };
  }
  let manifest;
  try { manifest = JSON.parse(jsonText); } catch {
    return { status: "failed", cleanText, entries: [], error: "delivery manifest is not valid JSON" };
  }
  if (manifest?.schema_version !== 1 || manifest?.child_verification !== "passed" || !Array.isArray(manifest?.artifacts) || manifest.artifacts.length < 1 || manifest.artifacts.length > MAX_ARTIFACTS) {
    return { status: "failed", cleanText, entries: [], error: "delivery manifest failed schema or child-verification validation" };
  }

  let realStaging;
  try { realStaging = fs.realpathSync(stagingDir); } catch {
    return { status: "failed", cleanText, entries: [], error: "artifact staging directory is unavailable" };
  }
  const results = [];
  const prepared = [];
  const seenDestinations = new Set();
  for (const item of manifest.artifacts) {
    const source = typeof item?.source === "string" ? path.resolve(item.source) : "";
    const destination = typeof item?.destination === "string" ? path.resolve(item.destination) : "";
    const declaredHash = typeof item?.sha256 === "string" ? item.sha256.toLowerCase() : "";
    let result = { source, destination, sha256: declaredHash, status: "failed" };
    try {
      if (item?.verified !== true || !HASH_RE.test(declaredHash)) throw new Error("artifact was not child-verified with a valid SHA-256");
      if (!path.isAbsolute(item.source) || !path.isAbsolute(item.destination)) throw new Error("source and destination must be absolute paths");
      const sourceStat = fs.lstatSync(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("staged source must be a regular non-symlink file");
      if (sourceStat.size > MAX_ARTIFACT_BYTES) throw new Error("staged artifact exceeds size limit");
      const realSource = fs.realpathSync(source);
      if (!within(realStaging, realSource)) throw new Error("staged source is outside this run's staging directory");
      if (!promptAuthorizesPath(ownerPrompt, destination, allowBesidePromptedPptx)) throw new Error("destination was not authorized by the owner prompt");
      if (source === destination || realSource === destination) throw new Error("source and destination must differ");
      if (seenDestinations.has(destination)) throw new Error("duplicate destination in delivery manifest");
      seenDestinations.add(destination);
      if (fs.existsSync(destination)) throw new Error("destination already exists; overwrite refused");
      const parent = path.dirname(destination);
      const parentStat = fs.statSync(parent);
      if (!parentStat.isDirectory()) throw new Error("destination parent is not a directory");
      const sourceHash = sha256File(realSource);
      if (sourceHash !== declaredHash) throw new Error("staged source SHA-256 does not match the child manifest");
      prepared.push({ realSource, destination, declaredHash, resultIndex: results.length });
      result = { ...result, status: "validated" };
    } catch (error) {
      result = { ...result, error: String(error?.message || error).slice(0, 512) };
    }
    results.push(result);
  }

  // Validate the ENTIRE manifest before the first external copy. One malicious,
  // stale, or unauthorized entry aborts the set without delivering the others.
  if (results.some((item) => item.status !== "validated")) {
    for (const item of results) {
      if (item.status === "validated") {
        item.status = "failed";
        item.error = "delivery aborted because another manifest entry failed validation";
      }
    }
    return { status: "failed", cleanText, entries: results, delivered: 0, total: results.length };
  }

  const created = [];
  try {
    for (const item of prepared) {
      fs.copyFileSync(item.realSource, item.destination, fs.constants.COPYFILE_EXCL);
      created.push(item.destination);
      const destinationHash = sha256File(item.destination);
      if (destinationHash !== item.declaredHash) throw new Error(`destination SHA-256 verification failed: ${item.destination}`);
      results[item.resultIndex] = { ...results[item.resultIndex], status: "delivered", verified_sha256: destinationHash };
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const destination of created.reverse()) {
      try { fs.unlinkSync(destination); } catch { rollbackFailures.push(destination); }
    }
    for (const item of results) {
      item.status = rollbackFailures.includes(item.destination) ? "rollback_failed" : "failed";
      item.error = `atomic delivery aborted: ${String(error?.message || error).slice(0, 384)}`;
    }
    return {
      status: rollbackFailures.length > 0 ? "partial" : "failed",
      cleanText, entries: results, delivered: 0, total: results.length,
      ...(rollbackFailures.length > 0 ? { rollback_failures: rollbackFailures } : {}),
    };
  }
  const delivered = results.length;
  return {
    status: "complete",
    cleanText,
    entries: results,
    delivered,
    total: results.length,
  };
}
