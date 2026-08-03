import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { LspClient, toFileUri } from "./client.js";
import { evaluateDiagnosticGate, getDiagnosticRows, summarizeDiagnostics } from "./diagnostics.js";
import { detectLanguage, resolveServer } from "./discovery.js";
import { JsonRpcClient } from "./jsonrpc.js";
import { computeLineIndex, offsetToPosition, positionToOffset } from "./position.js";
import { applyTextEdits, extractEditsByPath } from "./rename.js";
import { LspDiagnosticSeverity } from "./types.js";

const FAKE_SERVER = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
let buf = '';
rl.on('line', (line) => {
  const m = line.match(/^Content-Length: (\\d+)$/i);
  if (m) { pending = Number(m[1]); }
});
let pending = null;
process.stdin.on('data', (d) => {
  buf += d.toString('latin1');
  while (true) {
    const h = buf.indexOf('\\r\\n\\r\\n');
    if (h === -1) break;
    const header = buf.slice(0, h);
    const m = header.match(/Content-Length: (\\d+)/i);
    if (!m) { buf = buf.slice(h + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < h + 4 + len) break;
    const body = buf.slice(h + 4, h + 4 + len);
    buf = buf.slice(h + 4 + len);
    const msg = JSON.parse(body);
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: { capabilities: { positionEncoding: 'utf-16', definitionProvider: true, referencesProvider: true, hoverProvider: true, renameProvider: { prepareProvider: true }, textDocumentSync: { openClose: true, change: 1 } } } });
    } else if (msg.method === 'shutdown') {
      send({ id: msg.id, result: null });
    } else if (msg.method === 'textDocument/definition') {
      send({ id: msg.id, result: [{ uri: msg.params.textDocument.uri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 12 } } }] });
    } else if (msg.method === 'textDocument/rename') {
      send({ id: msg.id, result: { changes: { [msg.params.textDocument.uri]: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, newText: msg.params.newName }] } } });
    } else if (msg.method === 'textDocument/prepareRename') {
      send({ id: msg.id, result: { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } } });
    } else if (msg.method === 'textDocument/hover') {
      send({ id: msg.id, result: { contents: { kind: 'markdown', value: '**Doc**' } } });
    } else if (msg.method === 'exit') {
      process.exit(0);
    } else if (msg.id !== undefined) {
      send({ id: msg.id, result: null });
    }
    if (msg.method === 'textDocument/didOpen') {
      send({ method: 'textDocument/publishDiagnostics', params: { uri: msg.params.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'boom' }] } });
    }
  }
});
function send(msg) {
  const body = JSON.stringify(msg);
  const header = 'Content-Length: ' + Buffer.byteLength(body, 'utf-8') + '\\r\\n\\r\\n';
  process.stdout.write(header + body);
}
`;

function startFakeServer(): ChildProcessWithoutNullStreams {
	return spawn(process.execPath, ["-e", FAKE_SERVER], { stdio: ["pipe", "pipe", "pipe"] });
}

let liveProcs: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
	for (const p of liveProcs) {
		try {
			p.kill("SIGKILL");
		} catch {
			/* noop */
		}
	}
	liveProcs = [];
});

describe("position conversion", () => {
	it("converts UTF-16 offsets and positions", () => {
		// Contains a supplementary-plane char (2 UTF-16 code units).
		const text = "ab😀cd\nsecond line";
		const index = computeLineIndex(text);
		// 'c' sits after the surrogate pair; its UTF-16 character index is 4
		// (a,b,high,low → 0,1,2,3) and its string offset is also 4.
		const pos = offsetToPosition(text, index, 4);
		expect(pos.line).toBe(0);
		expect(pos.character).toBe(4);
		const back = positionToOffset(text, index, { line: 0, character: 4 });
		expect(back).toBe(4);
	});

	it("handles CRLF line endings", () => {
		const text = "line1\r\nline2\r\nline3";
		const index = computeLineIndex(text);
		const pos = offsetToPosition(text, index, text.indexOf("line2"));
		expect(pos.line).toBe(1);
	});
});

describe("rename preview / apply text edits", () => {
	it("applies edits later-to-earlier preserving offsets", () => {
		const content = "aaa\nbbb\nccc";
		const edits = [
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "AAA" },
			{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: "BBB" },
		];
		const r = applyTextEdits(content, edits);
		expect(r.newContent).toBe("AAA\nBBB\nccc");
		expect(r.conflicts).toEqual([]);
	});

	it("treats overlapping edits as conflicts", () => {
		const content = "abcdef";
		const edits = [
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "X" },
			{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, newText: "Y" },
		];
		const r = applyTextEdits(content, edits);
		expect(r.conflicts.length).toBeGreaterThanOrEqual(1);
	});

	it("preserves a BOM", () => {
		const content = "\ufeffhello";
		const edits = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "world" }];
		const r = applyTextEdits(content, edits);
		expect(r.newContent.charCodeAt(0)).toBe(0xfeff);
		expect(r.newContent).toBe("\ufeffworld");
	});

	it("rejects edits targeting external paths", () => {
		const edit = {
			changes: {
				"file:///etc/passwd": [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" },
				],
			},
		};
		const { conflicts } = extractEditsByPath(edit as never, "/workspace");
		expect(conflicts.length).toBeGreaterThan(0);
	});
});

describe("LSP discovery", () => {
	it("detects language from extension", () => {
		expect(detectLanguage("a.ts").languageId).toBe("typescript");
		expect(detectLanguage("a.py").languageId).toBe("python");
		expect(detectLanguage("a.weird").languageId).toBeNull();
	});

	it("reports server not installed deterministically (no server on CI)", async () => {
		const res = await resolveServer("typescript");
		// Either resolves on PATH or reports unavailable — must be deterministic
		// and typed, never throws.
		expect(res.languageId).toBe("typescript");
	});
});

describe("LSP diagnostics", () => {
	it("dedupes, caps and summarises diagnostics", () => {
		const rows = getDiagnosticRows(
			{
				uri: "file:///workspace/a.ts",
				diagnostics: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
						severity: LspDiagnosticSeverity.Error,
						message: "e1",
					},
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
						severity: LspDiagnosticSeverity.Error,
						message: "e1",
					},
					{
						range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
						severity: LspDiagnosticSeverity.Warning,
						message: "w1",
					},
				],
			},
			"/workspace",
			"s1",
			10,
		);
		expect(rows.length).toBe(2);
		expect(rows[0].workspaceRelativePath).toBe("a.ts");
		const summary = summarizeDiagnostics(rows);
		expect(summary.errors).toBe(1);
		expect(summary.warnings).toBe(1);
	});

	it("diagnostics gate fails on new errors, allows baseline", () => {
		const base = [
			{
				workspaceRelativePath: "a.ts",
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				severity: LspDiagnosticSeverity.Error,
				message: "base",
			},
		];
		const after = [
			...base,
			{
				workspaceRelativePath: "a.ts",
				range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
				severity: LspDiagnosticSeverity.Error,
				message: "new",
			},
		];
		const result = evaluateDiagnosticGate(base, after, { allowExistingBaselineErrors: true });
		expect(result.passed).toBe(false);
		expect(result.comparison.errorsIntroduced).toBe(1);
	});
});

describe("LSP lifecycle over fake server", () => {
	it("initializes, serves definition, and shuts down cleanly (no leak)", async () => {
		const child = startFakeServer();
		liveProcs.push(child);
		const rpc = new JsonRpcClient({ child });
		const client = new LspClient({ rpc, rootUri: toFileUri("/workspace"), workspaceRoot: "/workspace" });
		const caps = await client.initialize();
		expect(caps.definitionProvider).toBe(true);
		const locations = await client.definition({ uri: toFileUri("/workspace/a.ts"), line: 1, character: 2 });
		expect(locations.length).toBe(1);
		expect(locations[0].range.start.line).toBe(1);
		await client.shutdown();
		client.dispose();
		// afterAll kills child (afterEach)
	});

	it("gathers published diagnostics after didOpen", async () => {
		const child = startFakeServer();
		liveProcs.push(child);
		const received: unknown[] = [];
		const rpc = new JsonRpcClient({ child });
		const client = new LspClient({
			rpc,
			rootUri: toFileUri("/workspace"),
			workspaceRoot: "/workspace",
			onDiagnostics: (params) => received.push(params),
		});
		await client.initialize();
		await client.openDocument(toFileUri("/workspace/a.ts"), "const x = 1;\n");
		// Give the fake server a tick to flush the publishDiagnostics.
		await new Promise((r) => setTimeout(r, 150));
		expect(received.length).toBeGreaterThan(0);
		await client.shutdown();
		client.dispose();
	});
});
