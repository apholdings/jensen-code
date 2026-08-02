import { describe, expect, it } from "vitest";
import { PlaywrightBrowserRenderer } from "./browser.js";

const executable = process.env.JENSEN_PLAYWRIGHT_EXECUTABLE_PATH;
const browserIt = executable ? it : it.skip;

describe("isolated browser renderer", () => {
	browserIt("executes inline JavaScript while blocking page network and dismissing dialogs", async () => {
		const renderer = new PlaywrightBrowserRenderer(executable, 5000);
		const html = await renderer.renderHtml(`
      <html><body><main id="app">static</main>
      <script>
        document.querySelector('#app').textContent = 'rendered evidence';
        fetch('https://example.com/private').catch(() => {
          document.querySelector('#app').dataset.network = 'blocked';
        });
        alert('dismiss me');
      </script></body></html>
    `);
		expect(html).toContain("rendered evidence");
		expect(html).not.toContain("example domain");
	});

	browserIt("uses a fresh context for every render", async () => {
		const renderer = new PlaywrightBrowserRenderer(executable, 5000);
		await renderer.renderHtml("<script>globalThis.__jensenLeak = 'secret'</script>");
		const next = await renderer.renderHtml(
			"<main id='state'></main><script>document.querySelector('#state').textContent = String(globalThis.__jensenLeak)</script>",
		);
		expect(next).toContain(">undefined<");
		expect(next).not.toContain(">secret<");
	});

	it("honors cancellation before browser launch", async () => {
		const renderer = new PlaywrightBrowserRenderer(executable ?? "/missing", 1000);
		const controller = new AbortController();
		controller.abort();
		await expect(renderer.renderHtml("<p>unused</p>", controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
	});
});
