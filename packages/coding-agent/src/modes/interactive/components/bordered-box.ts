import { type Component, visibleWidth } from "@apholdings/jensen-tui";

type RenderCache = {
	childLines: string[];
	width: number;
	borderColorSample: string | undefined;
	lines: string[];
};

/**
 * BorderedBox component - a container that applies a rounded border and padding to all children
 */
export class BorderedBox implements Component {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private borderColorFn: (text: string) => string;

	// Cache for rendered output
	private cache?: RenderCache;

	constructor(paddingX = 1, paddingY = 0, borderColorFn: (text: string) => string = (str) => str) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.borderColorFn = borderColorFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.invalidateCache();
		}
	}

	clear(): void {
		this.children = [];
		this.invalidateCache();
	}

	setBorderColorFn(borderColorFn: (text: string) => string): void {
		this.borderColorFn = borderColorFn;
		// Don't invalidate here - we'll detect changes by sampling output
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	private matchCache(width: number, childLines: string[], borderColorSample: string | undefined): boolean {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.borderColorSample === borderColorSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		// Calculate available width for content
		// Border takes 1 char on each side + paddingX
		const contentWidth = Math.max(1, width - 2 - this.paddingX * 2);

		// Render all children
		const childLines: string[] = [];
		for (const child of this.children) {
			childLines.push(...child.render(contentWidth));
		}

		if (childLines.length === 0) {
			return [];
		}

		// Check if borderColorFn output changed by sampling
		const borderColorSample = this.borderColorFn("test");

		// Check cache validity
		if (this.matchCache(width, childLines, borderColorSample)) {
			return this.cache!.lines;
		}

		const result: string[] = [];
		const c = this.borderColorFn;

		// Top border: ╭─...─╮
		const horizontalBorder = "─".repeat(Math.max(0, width - 2));
		result.push(c(`╭${horizontalBorder}╮`));

		// Top padding
		const emptyMiddle = " ".repeat(Math.max(0, width - 2));
		for (let i = 0; i < this.paddingY; i++) {
			result.push(c("│") + emptyMiddle + c("│"));
		}

		// Content
		const leftPad = " ".repeat(this.paddingX);
		const rightPad = " ".repeat(this.paddingX);
		for (const line of childLines) {
			const visLen = visibleWidth(line);
			const extraPad = Math.max(0, contentWidth - visLen);
			result.push(c("│") + leftPad + line + " ".repeat(extraPad) + rightPad + c("│"));
		}

		// Bottom padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(c("│") + emptyMiddle + c("│"));
		}

		// Bottom border: ╰─...─╯
		result.push(c(`╰${horizontalBorder}╯`));

		// Update cache
		this.cache = { childLines, width, borderColorSample, lines: result };

		return result;
	}
}
