import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

export interface EvaluationDashboardRun {
	runId: string;
	scenarioId: string;
	status: string;
	verdict: string;
	stale: boolean;
}

export interface EvaluationDashboardData {
	scenarioPacks: string[];
	recentRuns: EvaluationDashboardRun[];
	activeRuns: Array<{ runId: string; scenarioId: string; status: string }>;
	assertionFailures: number;
	safetyFailures: number;
	semanticResults: Array<{ status: string; rubricId: string; rationale: string }>;
	retrievalMetrics: Array<{ metricId: string; value: number | undefined }>;
	costAndLatency: { costUsd: number; wallTimeMs: number };
	flakyRuns: number;
	failureClusters: string[];
	comparisons: Array<{
		comparisonId: string;
		deterministicWinner: string;
		correctnessDelta: number;
		safetyDelta: number;
	}>;
	releaseGate?: { finalVerdict: string; releaseCommit: string };
	retention: { policyVersion?: number; diskBytes?: number };
	artifactStoreHealth: "healthy" | "degraded" | "failed";
	pagination: { offset: number; limit: number; total: number; hasMore: boolean };
}

@customElement("jensen-evaluation-dashboard")
export class EvaluationDashboard extends LitElement {
	@property({ attribute: false }) projection?: EvaluationDashboardData;
	@property({ type: Boolean }) loading = false;
	@property({ type: Boolean }) degraded = false;

	protected createRenderRoot() {
		return this;
	}

	private card(label: string, value: string | number): TemplateResult {
		return html`<article class="rounded border border-border p-3" aria-label=${label}><div class="text-xs text-muted-foreground">${label}</div><div class="text-lg font-semibold">${value}</div></article>`;
	}

	override render(): TemplateResult {
		if (this.loading)
			return html`<section aria-busy="true" aria-label="Loading evaluation dashboard">Loading evaluation dashboard…</section>`;
		if (!this.projection)
			return html`<section aria-label="Evaluation dashboard empty state">No evaluation data available.</section>`;
		const data = this.projection;
		return html`
			<section class="flex flex-col gap-4" aria-label="Evaluation dashboard">
				${
					this.degraded || data.artifactStoreHealth === "degraded"
						? html`<div role="status" class="rounded border border-yellow-500 p-2">Evaluation data is degraded or stale.</div>`
						: ""
				}
				<header class="flex flex-wrap items-center justify-between gap-2">
					<h1 class="text-xl font-semibold">Evaluation overview</h1>
					<span role="status">Store: ${data.artifactStoreHealth}</span>
				</header>
				<div class="grid grid-cols-2 gap-2 md:grid-cols-4">
					${this.card("Assertion failures", data.assertionFailures)}
					${this.card("Safety failures", data.safetyFailures)}
					${this.card("Flaky runs", data.flakyRuns)}
					${this.card("Active runs", data.activeRuns.length)}
					${this.card("Cost (USD)", data.costAndLatency.costUsd.toFixed(4))}
					${this.card("Wall time (ms)", data.costAndLatency.wallTimeMs)}
					${this.card("Retention policy", data.retention.policyVersion ?? "unknown")}
					${this.card("Disk bytes", data.retention.diskBytes ?? "unknown")}
				</div>
				<div class="grid gap-4 md:grid-cols-2">
					<section aria-label="Scenario packs"><h2 class="font-semibold">Scenario packs</h2><ul>${data.scenarioPacks.map((pack) => html`<li>${pack}</li>`)}</ul></section>
					<section aria-label="Release gate status"><h2 class="font-semibold">Release gate status</h2><p>${data.releaseGate?.finalVerdict ?? "pending"}</p><p class="text-xs">${data.releaseGate?.releaseCommit ?? "No release commit"}</p></section>
				</div>
				<section aria-label="Active runs"><h2 class="font-semibold">Active runs</h2><ul>${data.activeRuns.map((run) => html`<li tabindex="0">${run.scenarioId}: ${run.status}</li>`)}</ul></section>
				<section aria-label="Recent completed runs"><h2 class="font-semibold">Recent completed runs</h2><div role="table" class="overflow-auto"><table><thead><tr><th scope="col">Scenario</th><th scope="col">Status</th><th scope="col">Verdict</th><th scope="col">Freshness</th></tr></thead><tbody>${data.recentRuns.map((run) => html`<tr><td>${run.scenarioId}</td><td>${run.status}</td><td>${run.verdict}</td><td>${run.stale ? "stale" : "current"}</td></tr>`)}</tbody></table></div></section>
				<section aria-label="Candidate comparisons"><h2 class="font-semibold">Single-agent versus Cavecrew</h2><ul>${data.comparisons.map((comparison) => html`<li>${comparison.comparisonId}: ${comparison.deterministicWinner} (correctness ${comparison.correctnessDelta}, safety ${comparison.safetyDelta})</li>`)}</ul></section>
				<section aria-label="Deterministic failures"><h2 class="font-semibold">Failure clusters</h2><ul>${data.failureClusters.map((failure) => html`<li>${failure}</li>`)}</ul></section>
				<section aria-label="Semantic reviewer results"><h2 class="font-semibold">Semantic reviewer results</h2><ul>${data.semanticResults.map((result) => html`<li>${result.rubricId}: ${result.status}</li>`)}</ul></section>
				<nav aria-label="Evaluation pagination">Showing ${data.pagination.offset + 1}–${Math.min(data.pagination.offset + data.pagination.limit, data.pagination.total)} of ${data.pagination.total}</nav>
			</section>
		`;
	}
}
