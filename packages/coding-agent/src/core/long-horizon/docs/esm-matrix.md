# Mission Execution State Machine v1 — Tracked ESM Matrix

## Overview

The Execution State Machine (ESM) governs the lifecycle of a Mission Contract execution.
It is deterministic, replayable, and fail-closed. Every transition is caller-supplied
and the destination state is derived by the state machine.

Completion must pass through: EXECUTION → VERIFICATION → COMPLETION_REVIEW → COMPLETED.

## ESM Scenario Matrix

| ID | Scenario | Status |
|----|----------|--------|
| ESM-01 | Deterministic initialization | PASSED |
| ESM-02 | Valid PLANNING → EXECUTION | PASSED |
| ESM-03 | Valid EXECUTION → VERIFICATION | PASSED |
| ESM-04 | Valid VERIFICATION → COMPLETION_REVIEW | PASSED |
| ESM-05 | Trusted COMPLETION_REVIEW → COMPLETED | PASSED |
| ESM-06 | Direct EXECUTION → COMPLETED rejected | PASSED |
| ESM-07 | Direct PLANNING → COMPLETED rejected | PASSED |
| ESM-08 | Terminal COMPLETED mutation rejected | PASSED |
| ESM-09 | Terminal FAILED mutation rejected | PASSED |
| ESM-10 | Terminal CANCELLED mutation rejected | PASSED |
| ESM-11 | BLOCK records exact prior state | PASSED |
| ESM-12 | RESUME returns to exact prior state | PASSED |
| ESM-13 | Arbitrary blocked resume rejected | PASSED |
| ESM-14 | Nested/double BLOCK rejected | PASSED |
| ESM-15 | Stale revision rejected | PASSED |
| ESM-15a | Strict CLI expectedRevision parser (unit) | PASSED |
| ESM-15b | Malformed CLI --expected-revision matrix (real CLI) | PASSED |
| ESM-15c | Parser ordering — malformed revision before ENOENT | PASSED |
| ESM-16 | Duplicate transition ID rejected | PASSED |
| ESM-17 | History revision discontinuity rejected | PASSED |
| ESM-18 | History fromState tampering rejected | PASSED |
| ESM-19 | History toState tampering rejected | PASSED |
| ESM-20 | Transition-kind tampering rejected | PASSED |
| ESM-21 | Contract digest tampering rejected | PASSED |
| ESM-22 | Same IDs/different contract digest rejected | PASSED |
| ESM-23 | Forged trusted context rejected | PASSED |
| ESM-24 | Missing completion capability rejected | PASSED |
| ESM-25 | Generic CLI completion rejected atomically | PASSED |
| ESM-26 | Generic non-privileged transition succeeds | PASSED |
| ESM-27 | CLI stale transition leaves output unchanged | PASSED |
| ESM-27a | CLI valid --expected-revision 0 at PLANNING | PASSED |
| ESM-27b | CLI valid --expected-revision 1 at EXECUTION | PASSED |
| ESM-27c | CLI malformed revision: byte-identical, SHA-256, no temp sibling, no provider init | PASSED |
| ESM-28 | Deterministic output across child processes | PASSED |
| ESM-29 | Replay reconstructs exact final state | PASSED |
| ESM-30 | Caller mutation cannot alter accepted record | PASSED |

## Test File Mapping

| Test File | ESM Coverage |
|-----------|-------------|
| execution-state-machine.test.ts | ESM-01 through ESM-24, ESM-29, ESM-30, ESM-15a |
| execution-cli.test.ts | ESM-25 through ESM-28 |
| execution-cli-revision.test.ts | ESM-15b, ESM-15c, ESM-27a, ESM-27b, ESM-27c |