import { readFile } from "node:fs/promises";
import process from "node:process";
import { createHash } from "node:crypto";

export function verifyReleaseProvenance(input) {
  const releaseCommit = input.releaseCommit;
  const surfaces = {
    releaseCommit,
    versionCommit: input.versionCommit,
    tagCommit: input.tagCommit,
    githubReleaseCommit: input.githubReleaseCommit,
    binaryManifestCommit: input.binaryManifestCommit,
    ...(input.packageSourceCommit ? { packageSourceCommit: input.packageSourceCommit } : {}),
  };
  const mismatches = Object.entries(surfaces)
    .filter(([, value]) => value !== releaseCommit)
    .map(([name]) => name);
  for (const commit of input.embeddedBinaryCommits ?? []) {
    if (commit !== releaseCommit) mismatches.push("embeddedBinaryCommit");
  }
  const contentHash = createHash("sha256").update(JSON.stringify(surfaces)).digest("hex");
  return { valid: mismatches.length === 0, mismatches, contentHash };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("usage: node scripts/verify-release-provenance.mjs <provenance.json>");
  const result = verifyReleaseProvenance(JSON.parse(await readFile(inputPath, "utf8")));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
