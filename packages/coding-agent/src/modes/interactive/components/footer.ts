import { type Component, truncateToWidth, visibleWidth } from "@apholdings/jensen-tui";
import type { AgentSession } from "../../../core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

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

	private compactPath(input: string, maxWidth = 44): string {
		const normalized = input.replaceAll("/", process.platform === "win32" ? "\\" : "/");
		if (normalized.length <= maxWidth) return normalized;

		const separator = normalized.includes("\\") ? "\\" : "/";
		const parts = normalized.split(separator).filter(Boolean);
		if (parts.length <= 2) return normalized;

		const first = normalized.startsWith(separator) ? separator : "";
		const driveMatch = parts[0]?.match(/^[A-Za-z]:$/);
		const head = driveMatch ? `${parts[0]}${separator}` : first;
		const tail = parts.slice(-2).join(separator);
		return `${head}…${separator}${tail}`;
	}

	private getLeftContent(): string {
		const cwd = process.cwd();
		const repo = this.footerData.getGitRepoName();
		const branch = this.footerData.getGitBranch();

		const parts: string[] = [];
		parts.push(`${theme.fg("dim", "cwd")} ${this.compactPath(cwd)}`);
		if (repo) {
			parts.push(`${theme.fg("dim", "repo")} ${repo}`);
		}
		if (branch) {
			parts.push(`${theme.fg("dim", "branch")} ${branch}`);
		}
		const separator = theme.fg("dim", " · ");
		return parts.join(separator);
	}

	render(width: number): string[] {
		if (width <= 0) return [""];

		const separator = theme.fg("dim", " · ");
		const ellipsis = theme.fg("dim", "...");

		const left = this.getLeftContent();
		const right = [
			theme.fg("dim", "tok ") + theme.fg("success", this.getContextTokens()),
			theme.fg("dim", "ctx ") + theme.fg(this.getContextPercentColor(), this.getContextPercentDisplay()),
		].join(separator);

		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		const gap = width - leftWidth - rightWidth;

		let footerLine: string;
		if (gap >= 0) {
			// Enough space: left aligned, right aligned
			footerLine = left + " ".repeat(gap) + right;
		} else {
			// Not enough space, truncate left
			const truncatedLeft = truncateToWidth(left, width - rightWidth - 1, ellipsis);
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
