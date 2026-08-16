/**
 * Unity MCP Vertical Slice — domain types (2.13.0).
 *
 * Thin, SDK-agnostic representation of a read-only Unity inspection through the
 * LOTG Unity Editor's MCP surface. This is NOT the future LOTG telemetry
 * platform and NOT a Unity abstraction layer: it only normalizes what the
 * enabled Unity MCP tools actually exposed, so a single invocation can be
 * summarized honestly and persisted as first-class Jensen Evidence.
 *
 * Every observation is classified so a missing capability is never confused
 * with a successful read:
 *
 *   OBSERVED        — a real Unity MCP tool returned the value.
 *   NOT_EXPOSED     — Unity MCP has no enabled tool that can surface this.
 *   NOT_ENABLED     — a known Unity tool exists but is disabled in this project.
 *   NOT_FOUND       — a required capability could not be discovered at all.
 *   ERROR           — a tool existed but the call failed.
 */

import type { McpProtocolEra } from "../mcp-foundation/mcp-types.js";

export type UnityObservationStatus = "OBSERVED" | "NOT_EXPOSED" | "NOT_ENABLED" | "NOT_FOUND" | "ERROR";

export type UnityInspectionConnectionStatus = "PASS" | "FAIL" | "WAITING_FOR_OPERATOR_APPROVAL";

/** One normalized, honestly-classified Unity observation. */
export interface UnityObservation {
	/** Stable category key, e.g. "console", "project-path", "scene", "player". */
	category: string;
	status: UnityObservationStatus;
	/** OBSERVED value (verbatim shape from the Unity tool), when present. */
	value?: unknown;
	/** Human/summary note; always present when the value is not simply observable. */
	note?: string;
	/** The exact Unity tool required when the capability is NOT_ENABLED/NOT_FOUND. */
	missingTool?: string;
}

/** A discovered Unity tool classified for least-privilege reasoning. */
export interface UnityToolObservation {
	name: string;
	/** True when the tool is documented as mutating Unity state. */
	mutating: boolean;
	description?: string;
}

export interface UnityInspectionResult {
	kind: "unity-inspection";
	version: 1;
	/** Logical server identity for this Unity endpoint. */
	serverId: string;
	/** Real machine target (e.g. "sparrow@blackpearl"). */
	machine: string;
	connection: UnityInspectionConnectionStatus;
	/** Present only when connection is FAIL/WAITING. */
	connectionReason?: string;
	/** Negotiated MCP protocol generation, observed (never assumed). */
	protocolEra?: McpProtocolEra;
	/** Negotiated MCP protocol version string, observed. */
	protocolVersion?: string;
	/** Unity MCP server identity reported during the handshake. */
	serverIdentity?: { name: string; version: string };
	sessionId?: string;
	/** Tools actually discovered and their least-privilege classification. */
	tools: UnityToolObservation[];
	observations: UnityObservation[];
	/** Evidence ids recorded for this inspection (tool-result evidence). */
	evidenceIds: string[];
	startedAtMs: number;
	completedAtMs: number;
}

/** Reusable, non-secret targeting for a Unity MCP endpoint reached over SSH stdio. */
export interface UnityServerTarget {
	/** Stable Jensen-scoped server id. */
	serverId: string;
	/** SSH user@host that owns the Unity Editor session (e.g. "sparrow@blackpearl"). */
	sshTarget: string;
	/** Absolute Windows project path on the remote host. */
	unityProjectPath: string;
	/** Remote relay executable (Windows). `%USERPROFILE%` is resolved by the remote shell. */
	relayWindowsPath?: string;
	/** Optional explicit editor pid (`--instance-id`) to disambiguate instances. */
	editorPid?: number;
	requestTimeoutMs?: number;
	startupTimeoutMs?: number;
}

/** Capability categories required by the vertical-slice verification rule. */
export const UNITY_INSPECTION_CATEGORIES = ["console", "project-path", "project-identity", "scene", "player"] as const;

export type UnityInspectionCategory = (typeof UNITY_INSPECTION_CATEGORIES)[number];

/**
 * Known Unity MCP tool surface (com.unity.ai.assistant 2.17.x). Used only to
 * classify discovered tools and to identify the exact missing tool when a
 * desired read-only capability is not enabled. Never used to fabricate results.
 */
export const UNITY_KNOWN_TOOLS: Readonly<Record<string, { mutating: boolean; provides?: string[] }>> = {
	Unity_AssetGeneration_GenerateAsset: { mutating: true },
	Unity_AssetGeneration_GetModels: { mutating: false },
	Unity_Camera_Capture: { mutating: false },
	Unity_GetConsoleLogs: { mutating: false, provides: ["console"] },
	Unity_RunCommand: { mutating: true },
	Unity_SceneView_Capture2DScene: { mutating: false },
	Unity_SceneView_CaptureMultiAngleSceneView: { mutating: false },
};
