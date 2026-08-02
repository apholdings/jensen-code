import { chromium } from "playwright-core";
import { WebResearchError } from "./types.js";

export interface BrowserRenderer {
	readonly available: boolean;
	renderHtml(html: string, signal?: AbortSignal): Promise<string>;
}

export class PlaywrightBrowserRenderer implements BrowserRenderer {
	readonly available: boolean;

	constructor(
		private readonly executablePath: string | undefined,
		private readonly timeoutMs: number,
	) {
		this.available = executablePath !== undefined;
	}

	async renderHtml(html: string, signal?: AbortSignal): Promise<string> {
		if (!this.executablePath) {
			throw new WebResearchError(
				"BROWSER_UNAVAILABLE",
				"Rendered extraction requires JENSEN_PLAYWRIGHT_EXECUTABLE_PATH",
			);
		}
		if (signal?.aborted) throw new WebResearchError("ABORTED", "Rendered extraction was aborted");
		const browser = await chromium.launch({
			executablePath: this.executablePath,
			headless: true,
			args: ["--disable-dev-shm-usage", "--disable-extensions", "--disable-background-networking"],
		});
		try {
			const context = await browser.newContext({
				acceptDownloads: false,
				javaScriptEnabled: true,
				serviceWorkers: "block",
			});
			try {
				const page = await context.newPage();
				page.setDefaultTimeout(this.timeoutMs);
				page.on("dialog", (dialog) => void dialog.dismiss());
				await page.route("**/*", (route) => void route.abort("blockedbyclient"));
				const abort = () => void page.close().catch(() => undefined);
				signal?.addEventListener("abort", abort, { once: true });
				try {
					await page.setContent(html, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
					await page.waitForTimeout(50);
					if (signal?.aborted) throw new WebResearchError("ABORTED", "Rendered extraction was aborted");
					return await page.content();
				} finally {
					signal?.removeEventListener("abort", abort);
				}
			} finally {
				await context.close();
			}
		} finally {
			await browser.close();
		}
	}
}
