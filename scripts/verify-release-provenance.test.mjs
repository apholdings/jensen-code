import test from "node:test";
import assert from "node:assert/strict";
import { verifyReleaseProvenance } from "./verify-release-provenance.mjs";

test("release provenance passes when every surface uses one commit", () => {
  const result = verifyReleaseProvenance({
    releaseCommit: "abc",
    versionCommit: "abc",
    tagCommit: "abc",
    githubReleaseCommit: "abc",
    binaryManifestCommit: "abc",
    embeddedBinaryCommits: ["abc"],
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.mismatches, []);
});

test("release provenance fails on a post-tag binary commit", () => {
  const result = verifyReleaseProvenance({
    releaseCommit: "abc",
    versionCommit: "abc",
    tagCommit: "abc",
    githubReleaseCommit: "abc",
    binaryManifestCommit: "def",
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.mismatches, ["binaryManifestCommit"]);
});
