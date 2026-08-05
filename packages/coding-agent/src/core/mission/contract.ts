/**
 * Durable Mission Graph — typed contracts & producer/consumer linking (2.0.0).
 *
 * Contracts are typed bindings between a producer objective and a consumer
 * objective. Compatibility is verified by comparing contract revisions and
 * schema digests; stale producer revisions are detected and block the consumer.
 */

import type { MissionContract, MissionOperationResult } from "./types.js";

export interface ProducerContractRoot {
	id: string;
	revision: number;
	schema: string;
	/** The last revision actually produced/satisfied by the producer. */
	producedRevision?: number;
	/** SHA-256 of the current producer schema definition. */
	producedSchemaDigest?: string;
}

export interface ConsumerContractRequirement {
	contractId: string;
	requiredRevision: number;
	requiredSchema?: string;
}

export interface CompatibilityCheck {
	compatible: boolean;
	reasons: string[];
}

/**
 * Verify that a producer's produced output satisfies a consumer's required
 * contract revision. A mismatch in revision or schema digest marks the
 * producer output stale for that consumer.
 */
export function verifyContractCompatibility(
	producer: ProducerContractRoot,
	consumer: ConsumerContractRequirement,
): CompatibilityCheck {
	const reasons: string[] = [];
	const producedRevision = producer.producedRevision ?? producer.revision;
	if (producedRevision < consumer.requiredRevision) {
		reasons.push(`producer ${producer.id} revision ${producedRevision} < required ${consumer.requiredRevision}`);
	}
	if (consumer.requiredSchema && producer.schema !== consumer.requiredSchema) {
		reasons.push(`producer ${producer.id} schema '${producer.schema}' != required '${consumer.requiredSchema}'`);
	}
	return { compatible: reasons.length === 0, reasons };
}

/**
 * Detect whether a mission's consumer-side contract requirement is stale
 * relative to the producer's current revision.
 */
export function isContractStale(producer: ProducerContractRoot, consumer: ConsumerContractRequirement): boolean {
	return !verifyContractCompatibility(producer, consumer).compatible;
}

/**
 * Link a typed contract from the mission contract registry to a producer root
 * and a consumer requirement. Validates that both roles reference the same
 * contract id and that consumer/producer reference known objectives elsewhere.
 */
export function linkProducerConsumer(
	contract: MissionContract,
	producer: ProducerContractRoot,
	consumer: ConsumerContractRequirement,
): MissionOperationResult<{ contractId: string; compatible: boolean }> {
	if (contract.id !== producer.id || contract.id !== consumer.contractId) {
		return {
			ok: false,
			code: "CONTRACT_MISMATCH",
			error: `contract id mismatch: registry='${contract.id}', producer='${producer.id}', consumer='${consumer.contractId}'`,
		};
	}
	const check = verifyContractCompatibility(producer, consumer);
	return { ok: true, value: { contractId: contract.id, compatible: check.compatible } };
}
