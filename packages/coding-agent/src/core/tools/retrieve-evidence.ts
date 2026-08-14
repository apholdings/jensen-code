import type { AgentTool } from "@apholdings/jensen-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { EvidenceArchive } from "../context-runtime/evidence-archive.js";
import { InMemoryEvidenceArchive } from "../context-runtime/evidence-archive.js";
import {
	DEFAULT_EVIDENCE_PAGE_CHARS,
	MAX_EVIDENCE_PAGE_CHARS,
	retrieveEvidencePage,
} from "../context-runtime/evidence-retrieval.js";

const retrieveEvidenceSchema = Type.Object({
	evidenceId: Type.String({
		description:
			'Evidence ID of the archived artifact to retrieve (as shown in an <evidence ref="..."/> or checkpoint evidence-refs entry)',
	}),
	offset: Type.Optional(
		Type.Number({
			minimum: 0,
			description: "0-based character offset to start reading from. Default 0.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			minimum: 1,
			description: `Maximum characters to return. Default ${DEFAULT_EVIDENCE_PAGE_CHARS}, hard cap ${MAX_EVIDENCE_PAGE_CHARS}.`,
		}),
	),
});

export type RetrieveEvidenceInput = Static<typeof retrieveEvidenceSchema>;

/**
 * Model-facing capability to page an archived cold-evidence artifact back into
 * hot context. The returned content is ordinary untrusted DATA (it was already
 * redacted at archive time), never privileged instructions, and never completion
 * authority.
 */
export function createRetrieveEvidenceTool(archive: EvidenceArchive): AgentTool<typeof retrieveEvidenceSchema> {
	return {
		name: "retrieve_evidence",
		label: "retrieve_evidence",
		description:
			"Retrieve a bounded, integrity-verified page of an archived evidence artifact by its evidence ID. " +
			'Use this when an <evidence ref="..."/> or checkpoint evidence reference contains a fact you need that is no longer in the working context. ' +
			"Returns exact archived content (secrets already redacted), a character range, and whether more content exists; use offset=end to page forward. " +
			"Retrieving evidence only reads data — it never certifies that a test passed or that work is complete.",
		parameters: retrieveEvidenceSchema,
		effects: {
			readsWorkspace: false,
			writesWorkspace: false,
			createsFiles: false,
			deletesFiles: false,
			executesProcesses: false,
			startsPersistentProcesses: false,
			accessesNetwork: false,
			mutatesGit: false,
			mutatesExternalState: false,
			handlesSecrets: false,
			potentiallyDestructive: false,
			requiresExclusiveWorkspaceLease: false,
			parallelSafe: true,
			scopes: [{ kind: "external", resource: "evidence-archive" }],
		},
		isConcurrencySafe: () => true,
		execute: async (_toolCallId: string, input: RetrieveEvidenceInput) => {
			const result = await retrieveEvidencePage(archive, input.evidenceId, {
				offset: input.offset,
				limit: input.limit,
			});

			if (!result.ok) {
				return {
					content: [{ type: "text", text: result.reason ?? `Retrieval failed (${result.status}).` }],
					details: {
						status: result.status,
						evidenceId: result.evidenceId,
						integrity: "unverified",
					},
				};
			}

			const meta = result.metadata!;
			const envelope = [
				`[evidence ${meta.integrity}] ${meta.evidenceId}`,
				`range: chars ${meta.start}-${meta.end} of ${meta.totalChars} (${meta.totalBytes} bytes)`,
				`${meta.hasMore ? `hasMore: true (next offset ${meta.end})` : "hasMore: false"}`,
				"",
				result.content!,
			].join("\n");

			return {
				content: [{ type: "text", text: envelope }],
				details: {
					status: result.status,
					integrity: meta.integrity,
					evidenceId: meta.evidenceId,
					kind: meta.kind,
					source: meta.source,
					contentHash: meta.contentHash,
					start: meta.start,
					end: meta.end,
					totalChars: meta.totalChars,
					totalBytes: meta.totalBytes,
					retrievedChars: meta.retrievedChars,
					hasMore: meta.hasMore,
					redaction: meta.redaction,
					// Marker used by the Context Governor to preserve archive identity
					// when this page is later virtualized again (no duplicate records).
					__evidenceSourceId: meta.evidenceId,
				},
			};
		},
	};
}

/** Static name-resolution instance (the session binds its own archive in AgentSession). */
export const retrieveEvidenceTool: AgentTool<typeof retrieveEvidenceSchema> = createRetrieveEvidenceTool(
	new InMemoryEvidenceArchive(),
);
