import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MANIFEST_BEGIN = "<togglelogic_artifact_manifest_v1>";
export const MANIFEST_END = "</togglelogic_artifact_manifest_v1>";
const HASH = /^[a-f0-9]{64}$/;

function sha256(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let read; while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read)); }
  finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

function within(root, child) {
  const relative = path.relative(root, child);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function deliverAuthorizedArtifacts({ text, stagingDirectory, authorizedDestinations = [] }) {
  const raw = String(text || "");
  const begin = raw.indexOf(MANIFEST_BEGIN); const end = raw.indexOf(MANIFEST_END);
  if (begin < 0 || end < begin || raw.indexOf(MANIFEST_BEGIN, begin + 1) >= 0 || raw.slice(end + MANIFEST_END.length).trim()) {
    return { status: "failed", cleanText: raw, entries: [], error: "missing or ambiguous artifact manifest" };
  }
  const cleanText = `${raw.slice(0, begin)}${raw.slice(end + MANIFEST_END.length)}`.trim();
  let manifest;
  try { manifest = JSON.parse(raw.slice(begin + MANIFEST_BEGIN.length, end)); } catch { return { status: "failed", cleanText, entries: [], error: "invalid artifact manifest JSON" }; }
  if (manifest?.schema_version !== 1 || manifest?.child_verification !== "passed" || !Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1 || manifest.artifacts.length > 16) {
    return { status: "failed", cleanText, entries: [], error: "artifact manifest schema rejected" };
  }
  const allowed = new Set(authorizedDestinations.filter(path.isAbsolute).map((item) => path.resolve(item)));
  const root = fs.realpathSync(stagingDirectory);
  const prepared = []; const entries = []; const destinations = new Set();
  for (const item of manifest.artifacts) {
    const source = path.resolve(String(item?.source || "")); const destination = path.resolve(String(item?.destination || ""));
    try {
      if (!path.isAbsolute(item.source) || !path.isAbsolute(item.destination) || !allowed.has(destination)) throw new Error("destination is not explicitly authorized");
      if (destinations.has(destination) || fs.existsSync(destination)) throw new Error("duplicate or existing destination refused");
      destinations.add(destination);
      const stat = fs.lstatSync(source); const realSource = fs.realpathSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 * 1024 || !within(root, realSource)) throw new Error("staged source rejected");
      if (item.verified !== true || !HASH.test(item.sha256) || sha256(realSource) !== item.sha256) throw new Error("source verification failed");
      if (!fs.statSync(path.dirname(destination)).isDirectory()) throw new Error("destination parent unavailable");
      prepared.push({ realSource, destination, hash: item.sha256, index: entries.length });
      entries.push({ source, destination, status: "validated" });
    } catch (error) { entries.push({ source, destination, status: "failed", error: String(error?.message || error) }); }
  }
  if (entries.some((item) => item.status !== "validated")) return { status: "failed", cleanText, entries, delivered: 0 };
  const created = [];
  try {
    for (const item of prepared) {
      fs.copyFileSync(item.realSource, item.destination, fs.constants.COPYFILE_EXCL); created.push(item.destination);
      if (sha256(item.destination) !== item.hash) throw new Error("destination verification failed");
      entries[item.index].status = "delivered";
    }
  } catch (error) {
    for (const file of created.reverse()) { try { fs.unlinkSync(file); } catch {} }
    return { status: "failed", cleanText, entries: entries.map((item) => ({ ...item, status: "failed", error: String(error?.message || error) })), delivered: 0 };
  }
  return { status: "complete", cleanText, entries, delivered: entries.length };
}
