/**
 * Remote Execution — public API (2.14.0).
 *
 * The durable control plane (Bucephalus) can execute a mission's tool/process
 * work on a separate physical machine while inference remains on its own host.
 * This module exposes the target model, transport, protocol, and the
 * RemoteMissionExecutor; Capability Routing and Shared Inference Scheduling are
 * explicitly out of scope.
 */

export * from "./file-remote-target-registry.js";
export * from "./remote-execution-error.js";
export * from "./remote-mission-executor.js";
export * from "./remote-protocol.js";
export * from "./remote-resume.js";
export * from "./remote-runtime-sync.js";
export * from "./remote-target-registry.js";
export * from "./remote-target-types.js";
export * from "./remote-transport.js";
export * from "./remote-verification.js";
export * from "./runtime-bundle.js";
export * from "./ssh-transport.js";
