/**
 * Capability Routing — public API (2.15.0).
 *
 * Deterministic execution-location routing. Feasibility only; the Scheduler
 * remains the sole authority that selects an eligible route and creates the
 * durable Assignment. Inference routing and shared-Qwen scheduling are out of
 * scope (next roadmap phase).
 */

export * from "./capability-router.js";
export * from "./route-types.js";
