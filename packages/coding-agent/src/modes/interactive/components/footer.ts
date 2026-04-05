import * as os from "node:os";
import {
	type Api,
	calculateCost,
	getModel,
	getProviders,
	type KnownProvider,
	type Model,
	type ToolResultMessage,
} from "@apholdings/jensen-ai";
import { type Component, truncateToWidth, visibleWidth } from "@apholdings/jensen-tui";
import type { AgentSession } from "../../../core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

const KNOWN_PROVIDERS = new Set<string>(getProviders());

type CostSummary = {
	total: number;
	hasUsage: boolean;
	hasUnknown: boolean;
};

function summarizeAssistantCosts(
	messages: AgentSession["state"]["messages"],
	currentModel: Model<Api> | null | undefined,
): CostSummary {
	let total = 0;
	let hasUsage = false;
	let hasUnknown = false;

	for (const message of messages) {
		if (message.role !== "assistant") continue;
		hasUsage = true;

		const pricingModel = resolvePricingModel(message.provider, message.model, currentModel);
		if (!pricingModel) {
			hasUnknown = true;
			continue;
		}

		const cost = calculateCost(pricingModel, buildUsageSnapshot(message.usage));
		total += cost.total;
	}

	return { total, hasUsage, hasUnknown };
}

function findCurrentTurnStartIndex(messages: AgentSession["state"]["messages"]): number | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "bashExecution") {
			return i;
		}
	}

	return null;
}

function sumDelegatedCosts(messages: AgentSession["state"]["messages"]): number {
	let total = 0;
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const toolResult = message as ToolResultMessage;
		if (toolResult.toolName !== "subagent") continue;
		const details = toolResult.details as { results?: Array<{ usage?: { cost?: number } }> } | undefined;
		if (!details || !Array.isArray(details.results)) continue;
		for (const result of details.results) {
			if (typeof result?.usage?.cost === "number") {
				total += result.usage.cost;
			}
		}
	}
	return total;
}

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokenCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function formatCost(value: number): string {
	if (value >= 100) return `$${value.toFixed(2)}`;
	if (value >= 1) return `$${value.toFixed(3)}`;
	if (value >= 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(6)}`;
}

function resolvePricingModel(
	provider: string,
	modelId: string,
	currentModel: Model<Api> | null | undefined,
): Model<Api> | undefined {
	if (currentModel && currentModel.provider === provider && currentModel.id === modelId) {
		return currentModel;
	}

	if (!KNOWN_PROVIDERS.has(provider)) {
		return undefined;
	}

	return getModel(provider as KnownProvider, modelId as never) as Model<Api> | undefined;
}

function buildUsageSnapshot(messageUsage: {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
}) {
	return {
		input: typeof messageUsage.input === "number" ? messageUsage.input : 0,
		output: typeof messageUsage.output === "number" ? messageUsage.output : 0,
		cacheRead: typeof messageUsage.cacheRead === "number" ? messageUsage.cacheRead : 0,
		cacheWrite: typeof messageUsage.cacheWrite === "number" ? messageUsage.cacheWrite : 0,
		totalTokens: typeof messageUsage.totalTokens === "number" ? messageUsage.totalTokens : 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

export class FooterComponent implements Component {
	private autoCompactEnabled = true;

	constructor(
		private session: AgentSession,
		private footerData: ReadonlyFooterDataProvider,
	) {}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	invalidate(): void {}

	dispose(): void {}

	private getContextTokens(): string {
		const usage = this.session.getContextUsage();
		if (!usage || usage.tokens == null) return "--";

		const contextWindow =
			typeof usage.contextWindow === "number"
				? usage.contextWindow
				: (this.session.state.model?.contextWindow ?? null);

		if (contextWindow == null) {
			return formatTokenCount(usage.tokens);
		}

		return `${formatTokenCount(usage.tokens)}/${formatTokenCount(contextWindow)}`;
	}

	private getContextPercentValue(): number | null {
		const usage = this.session.getContextUsage();
		if (!usage || usage.percent == null) return null;
		return usage.percent;
	}

	private getContextPercentDisplay(): string {
		const percent = this.getContextPercentValue();
		if (percent == null) return "--";
		return `${percent.toFixed(1)}%${this.autoCompactEnabled ? " (auto)" : ""}`;
	}

	private getContextPercentColor(): "success" | "warning" | "error" {
		const percent = this.getContextPercentValue();
		if (percent == null) return "success";
		if (percent > 90) return "error";
		if (percent > 70) return "warning";
		return "success";
	}

	private getSessionCostSummary(): CostSummary {
		const summary = summarizeAssistantCosts(this.session.state.messages, this.session.state.model);
		const delegated = sumDelegatedCosts(this.session.state.messages);
		return {
			total: summary.total + delegated,
			hasUsage: summary.hasUsage || delegated > 0,
			hasUnknown: summary.hasUnknown,
		};
	}

	private getCurrentTurnCostSummary(): CostSummary | null {
		const turnStartIndex = findCurrentTurnStartIndex(this.session.state.messages);
		if (turnStartIndex == null) {
			return null;
		}

		const slice = this.session.state.messages.slice(turnStartIndex);
		const summary = summarizeAssistantCosts(slice, this.session.state.model);
		const delegated = sumDelegatedCosts(slice);
		return {
			total: summary.total + delegated,
			hasUsage: summary.hasUsage || delegated > 0,
			hasUnknown: summary.hasUnknown,
		};
	}

	private formatCostSummary(summary: CostSummary): string {
		if (!summary.hasUsage) return "--";
		if (summary.hasUnknown && summary.total <= 0) return "?";
		return `${formatCost(summary.total)}${summary.hasUnknown ? "+" : ""}`;
	}

	private getCostDisplay(): string {
		const sessionSummary = this.getSessionCostSummary();
		const currentTurnSummary = this.getCurrentTurnCostSummary();

		if (!sessionSummary.hasUsage) {
			return "session --";
		}

		if (!currentTurnSummary || !currentTurnSummary.hasUsage) {
			return `session ${this.formatCostSummary(sessionSummary)}`;
		}

		return `turn ${this.formatCostSummary(currentTurnSummary)} · session ${this.formatCostSummary(sessionSummary)}`;
	}

	private compactPath(input: string, maxWidth = 44): string {
		const home = os.homedir();
		let normalized = input;
		if (normalized.startsWith(home)) {
			normalized = `~${normalized.slice(home.length)}`;
		}
		normalized = normalized.replaceAll("/", process.platform === "win32" ? "\\" : "/");
		if (normalized.length <= maxWidth) return normalized;

		const separator = normalized.includes("\\") ? "\\" : "/";
		const parts = normalized.split(separator).filter(Boolean);
		if (parts.length <= 2) return normalized;

		const first = normalized.startsWith(separator) ? separator : "";
		const isHome = parts[0] === "~";
		const driveMatch = parts[0]?.match(/^[A-Za-z]:$/);

		const head = isHome ? "~" : driveMatch ? `${parts[0]}${separator}` : first + parts[0];
		const tail = parts.slice(-2).join(separator);

		return `${head}${separator}…${separator}${tail}`;
	}

	private getLeftContentParts(): string[] {
		const cwd = process.cwd();
		const repo = this.footerData.getGitRepoName();
		const branch = this.footerData.getGitBranch();

		const parts: string[] = [];
		parts.push(`${theme.fg("accent", "cwd")} ${theme.fg("text", this.compactPath(cwd))}`);
		if (repo) {
			parts.push(`${theme.fg("accent", "repo")} ${theme.fg("text", repo)}`);
		}
		if (branch) {
			parts.push(`${theme.fg("accent", "branch")} ${theme.fg("text", branch)}`);
		}
		return parts;
	}

	/**
	 * Progressive truncation of left content parts to fit within available width.
	 * Parts are removed from right to left (least important first), preserving
	 * the most important content like cwd and path components.
	 */
	private truncateLeftContent(parts: string[], availableWidth: number, separator: string, ellipsis: string): string {
		if (parts.length === 0) return "";

		// Start with all parts
		const currentParts = [...parts];
		let result = currentParts.join(separator);
		let currentWidth = visibleWidth(result);

		// If everything fits, return as-is
		if (currentWidth <= availableWidth) {
			return truncateToWidth(result, availableWidth, ellipsis);
		}

		// Progressive truncation: remove parts from right to left
		while (currentParts.length > 1 && currentWidth > availableWidth) {
			// Remove the last part (least important)
			currentParts.pop();

			// Reconstruct with separator
			result = currentParts.join(separator);
			currentWidth = visibleWidth(result);
		}

		// Now we have at most one part (the cwd), truncate it to fit
		return truncateToWidth(result, availableWidth, ellipsis);
	}

	render(width: number): string[] {
		if (width <= 0) return [""];

		const separator = theme.fg("dim", " · ");
		const ellipsis = theme.fg("dim", "...");

		const leftParts = this.getLeftContentParts();
		const right = [
			theme.fg("accent", "tok ") + theme.fg("text", this.getContextTokens()),
			theme.fg("accent", "ctx ") + theme.fg(this.getContextPercentColor(), this.getContextPercentDisplay()),
			theme.fg("accent", "cost ") + theme.fg("text", this.getCostDisplay()),
		].join(separator);

		const rightWidth = visibleWidth(right);

		// Calculate space needed for left content (all parts joined)
		const fullLeftWidth = visibleWidth(leftParts.join(separator));
		const gap = width - fullLeftWidth - rightWidth;

		let footerLine: string;
		if (gap >= 0) {
			// Enough space: left aligned, right aligned
			footerLine = leftParts.join(separator) + " ".repeat(gap) + right;
		} else {
			// Not enough space, progressively truncate left parts
			const availableForLeft = width - rightWidth - 1; // -1 for space between
			const truncatedLeft = this.truncateLeftContent(leftParts, availableForLeft, separator, ellipsis);
			footerLine = `${truncatedLeft} ${right}`;
		}

		// Ensure we don't exceed width due to rounding errors
		footerLine = truncateToWidth(footerLine, width, ellipsis);
		const lines = [footerLine];

		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));

			const statusLine = sortedStatuses.join(" ");
			lines.push(truncateToWidth(statusLine, width, ellipsis));
		}

		return lines;
	}
}
