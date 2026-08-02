import type {
	TemporalResolution,
	TemporalResolutionResult,
	TemporalSourceFacts,
	TemporalValueClass,
	WebEvidenceRecord,
} from "./types.js";

/**
 * Deterministic temporal source-resolution engine.
 *
 * Distinguishes `historical`, `current`, `superseded`, `contradiction` and
 * `uncertain_current` from dated, authoritative evidence. It never blindly
 * prefers the newest page: authority and explicit effective dates matter.
 *
 * Inputs used:
 * - publishedAt (official patch/rebalance/publication date)
 * - effectiveAt (date stated in the content)
 * - source authority rank
 * - explicit "changed from A to B" language (handled by the caller-provided facts)
 * - maintained/current source
 * - later corroboration count
 */

const AUTHORITY_LABEL = ["community", "community", "official"];

function normalizeDate(source: unknown): number | undefined {
	if (typeof source !== "string") return undefined;
	const match = source.match(/(20\d{2})[-/]?(\d{2})?[-/]?(\d{2})?/);
	if (!match) return undefined;
	const year = Number(match[1]);
	const month = match[2] ? Number(match[2]) : 1;
	const day = match[3] ? Number(match[3]) : 1;
	const value = Date.UTC(year, month - 1, day);
	return Number.isNaN(value) ? undefined : value;
}

interface ClassifiedObservation {
	facts: TemporalSourceFacts;
	date?: number;
}

export class TemporalResolver {
	/**
	 * Resolve a set of observations for one quantity into a temporal verdict.
	 */
	resolve(inputs: TemporalSourceFacts[]): TemporalResolutionResult {
		const observations: ClassifiedObservation[] = inputs.map((facts) => {
			const date =
				normalizeDate(facts.effectiveAt) ??
				normalizeDate(facts.publishedAt) ??
				(facts.isMaintained ? Number.MAX_SAFE_INTEGER : undefined);
			return { facts, date };
		});

		const reasoning: string[] = [];
		const resolutions: TemporalResolution[] = [];
		if (observations.length === 0) {
			reasoning.push("No observations provided; current value unknown.");
			return { resolutions, unresolved: true, reasoning };
		}

		// A maintained current source is the most direct evidence of the
		// *current* state, independent of simple recency.
		const maintained = observations.filter((o) => o.facts.isMaintained);
		// Dated observations, newest first.
		const dated = observations
			.filter((o) => o.date !== undefined)
			.sort((a, b) => (b.date as number) - (a.date as number));

		const bestCandidate =
			maintained.length > 0
				? maintained.reduce((best, cur) => (cur.facts.authority > best.facts.authority ? cur : best), maintained[0])
				: dated[0];

		if (!bestCandidate) {
			// No dating and no maintained source: cannot resolve temporally.
			const valueSet = new Set(observations.map((o) => String(o.facts.value)));
			if (valueSet.size <= 1) {
				// Single consistent value, but undated.
				const classed: TemporalValueClass = "uncertain_current";
				reasoning.push(
					"Only undated observations. Value is not temporally resolvable; classified as uncertain_current, not authoritative.",
				);
				for (const o of observations) {
					resolutions.push({
						sourceUrl: o.facts.sourceUrl ?? "",
						evidenceId: o.facts.evidenceId,
						class: classed,
						value: o.facts.value,
						reasoning: ["undated; authority and effective date unknown"],
					});
				}
				return { resolutions, unresolved: true, reasoning };
			}
			// Undated sources disagree: unresolved contradiction.
			reasoning.push(
				"Two or more undated community sources disagree; unresolved contradiction, current value unknown.",
			);
			for (const o of observations) {
				resolutions.push({
					sourceUrl: o.facts.sourceUrl ?? "",
					evidenceId: o.facts.evidenceId,
					class: "contradiction",
					value: o.facts.value,
					conflictingEvidenceIds: observations
						.filter((other) => String(other.facts.value) !== String(o.facts.value))
						.map((other) => other.facts.evidenceId),
					reasoning: ["undated conflicting community sources cannot be resolved temporally"],
				});
			}
			return { resolutions, unresolved: true, reasoning };
		}

		// Group values and pick the set matching the best candidate's value.
		const bestValue = String(bestCandidate.facts.value);
		const allValues = new Set(observations.map((o) => String(o.facts.value)));

		if (allValues.size === 1) {
			// Only one observed value across all sources.
			reasoning.push(`${bestValue} is the only observed value across ${observations.length} source(s).`);
			const theValue = observations[0].facts.value;
			for (const o of observations) {
				resolutions.push({
					sourceUrl: o.facts.sourceUrl ?? "",
					evidenceId: o.facts.evidenceId,
					class: o.facts.isMaintained || o.facts.authority >= 2 ? "current" : "uncertain_current",
					value: o.facts.value,
					reasoning: ["single consistent value; no contradictory evidence"],
				});
			}
			return {
				resolutions,
				currentValue: theValue,
				unresolved: false,
				reasoning,
			};
		}

		// Multiple distinct values: classify each against the best candidate.
		const current = bestValue;
		reasoning.push(
			`Newest maintained/dated authoritative source reports ${current}; earlier values are classified as historical/superseded.`,
		);
		for (const o of observations) {
			const isCurrent = String(o.facts.value) === current;
			const superseded =
				o.date !== undefined &&
				bestCandidate.date !== undefined &&
				(o.date as number) < (bestCandidate.date as number) &&
				// A value is only "superseded" when it is an earlier authoritative
				// observation replaced by a later one. A newer but lower-authority
				// claim that disagrees with the maintained current value is a
				// contradiction, not a superseded value.
				o.facts.authority >= bestCandidate.facts.authority;
			let classed: TemporalValueClass;
			let supersededBy: string | undefined;
			const localReasoning: string[] = [];
			if (isCurrent) {
				classed = "current";
				localReasoning.push("matches the current authoritative/maintained value");
			} else if (superseded) {
				classed = "superseded";
				supersededBy = current;
				localReasoning.push("older dated authoritative value superseded by later rebalance");
			} else {
				// Same/newer date but different value, newer lower-authority claim,
				// or undated lower authority: treat as unresolved contradiction.
				classed = "contradiction";
				localReasoning.push("conflicting or lower-authority value; not temporally resolvable");
			}
			resolutions.push({
				sourceUrl: o.facts.sourceUrl ?? "",
				evidenceId: o.facts.evidenceId,
				class: classed,
				value: o.facts.value,
				supersededBy,
				effectiveAt: o.facts.effectiveAt,
				reasoning: localReasoning,
			});
		}

		const hasCurrent = resolutions.some((r) => r.class === "current");
		const hasUncertainCurrent = resolutions.some((r) => r.class === "uncertain_current");
		// Unresolved only when no authoritative current value is established, or
		// the only current-class signal is uncertain. A low-authority outlier
		// contradiction alongside an authoritative current value is noted but
		// does not make the current value unknown.
		const unresolved = !hasCurrent || hasUncertainCurrent;
		const currentValue = currentResolvedValue(resolutions, bestCandidate.facts.value);
		return {
			resolutions,
			currentValue: unresolved ? undefined : currentValue,
			unresolved,
			reasoning,
		};
	}
}

function currentResolvedValue(
	resolutions: TemporalResolution[],
	fallback: string | number,
): string | number | undefined {
	const current = resolutions.find((r) => r.class === "current");
	return current ? current.value : fallback;
}

export function temporalFactsFromEvidence(
	record: Pick<WebEvidenceRecord, "evidenceId" | "canonicalUrl" | "publishedAt" | "title">,
): { evidenceId: string; sourceUrl: string; publishedAt?: string } {
	return {
		evidenceId: record.evidenceId,
		sourceUrl: record.canonicalUrl,
		publishedAt: record.publishedAt,
	};
}

export function authorityLabel(authority: number): string {
	return AUTHORITY_LABEL[authority] ?? "community";
}
