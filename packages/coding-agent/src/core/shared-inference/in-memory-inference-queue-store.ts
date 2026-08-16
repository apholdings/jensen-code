/**
 * In-memory inference queue store (3.0.0 foundation).
 *
 * Deterministic, single-process implementation of the InferenceQueueStore port
 * for unit tests and the synthetic benchmark harness. Same ledger semantics as
 * the file store but without cross-process locking; mutations are synchronous
 * read-validate-write over an in-process map.
 */

import {
	type InferenceLedgerCreateResult,
	type InferenceLedgerLoadResult,
	type InferenceLedgerMutateResult,
	type InferenceLedgerMutation,
	type InferenceQueueStore,
	type InferenceResourceLedger,
	parseInferenceResourceLedger,
} from "./inference-queue.js";

export class InMemoryInferenceQueueStore implements InferenceQueueStore {
	readonly storeId = "memory";
	private readonly ledgers = new Map<string, InferenceResourceLedger>();

	async create(resourceId: string, ledger: InferenceResourceLedger): Promise<InferenceLedgerCreateResult> {
		if (this.ledgers.has(resourceId)) return { status: "idempotent", ledger: this.ledgers.get(resourceId)! };
		this.ledgers.set(resourceId, structuredClone(ledger));
		return { status: "created" };
	}

	async load(resourceId: string): Promise<InferenceLedgerLoadResult> {
		const ledger = this.ledgers.get(resourceId);
		if (!ledger) return { status: "missing" };
		return { status: "ok", ledger: structuredClone(ledger) };
	}

	async mutate<T>(
		resourceId: string,
		mutation: (current: InferenceResourceLedger) => InferenceLedgerMutation<T>,
	): Promise<InferenceLedgerMutateResult<T>> {
		const current = this.ledgers.get(resourceId);
		if (!current) return { status: "missing" };
		const output = mutation(structuredClone(current));
		if (output.kind === "noop") return { status: "ok", value: output.value };
		const nextValidation = parseInferenceResourceLedger(output.next);
		if (!nextValidation.ok) {
			throw new Error(
				`Inference mutation produced an invalid ledger for ${resourceId}: ${nextValidation.diagnostic}`,
			);
		}
		this.ledgers.set(resourceId, structuredClone(output.next));
		return { status: "ok", value: output.value };
	}

	async listResources(): Promise<string[]> {
		return [...this.ledgers.keys()].sort();
	}

	/** Test helper: read the raw ledger (not a clone). */
	peek(resourceId: string): InferenceResourceLedger | undefined {
		return this.ledgers.get(resourceId);
	}
}

export function createInMemoryInferenceQueueStore(): InMemoryInferenceQueueStore {
	return new InMemoryInferenceQueueStore();
}
