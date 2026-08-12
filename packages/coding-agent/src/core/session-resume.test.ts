import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@apholdings/jensen-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthStorage } from "./auth-storage.js";
import { SESSION_MEMORY_CUSTOM_TYPE } from "./memory.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager, validateSessionFile } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

let root: string;
let cwd: string;
let agentDir: string;
let sessionsDir: string;
const originalAgentDir = process.env.JENSEN_CODING_AGENT_DIR;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "jensen-session-resume-"));
	cwd = join(root, "repo");
	agentDir = join(root, "agent");
	sessionsDir = join(agentDir, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });
	// Isolate SessionManager.listAll() from the real user agent directory.
	process.env.JENSEN_CODING_AGENT_DIR = agentDir;
});

afterAll(() => {
	if (originalAgentDir === undefined) {
		delete process.env.JENSEN_CODING_AGENT_DIR;
	} else {
		process.env.JENSEN_CODING_AGENT_DIR = originalAgentDir;
	}
	rmSync(root, { recursive: true, force: true });
});

function user(text: string, timestamp = Date.now()) {
	return { role: "user" as const, content: text, timestamp };
}

function assistant(text: string, timestamp = Date.now()) {
	return {
		role: "assistant" as const,
		api: "openai-chat",
		provider: "test-provider",
		model: "test-model",
		stopReason: "stop",
		content: [{ type: "text" as const, text }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	} as unknown as Parameters<SessionManager["appendMessage"]>[0];
}

function textOf(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
			.map((block) => block.text)
			.join(" ");
	}
	return "";
}

function createPersistedSession(id: string, messages: Parameters<SessionManager["appendMessage"]>[0][]): string {
	const session = SessionManager.create(cwd, sessionsDir);
	session.newSession({ id });
	for (const message of messages) {
		session.appendMessage(message);
	}
	const file = session.getSessionFile();
	if (!file) throw new Error("Expected persisted session file");
	return file;
}

describe("SessionManager.findById", () => {
	it("resolves a session by exact ID", async () => {
		const file = createPersistedSession("session-A", [user("hello A"), assistant("reply A")]);
		const found = await SessionManager.findById("session-A", sessionsDir);

		expect(found).not.toBeNull();
		expect(found?.id).toBe("session-A");
		expect(found?.path).toBe(file);
	});

	it("selects the requested session when multiple sessions exist", async () => {
		createPersistedSession("session-A", [user("a"), assistant("reply a")]);
		createPersistedSession("session-B", [user("b"), assistant("reply b")]);
		createPersistedSession("session-C", [user("c"), assistant("reply c")]);

		const found = await SessionManager.findById("session-B", sessionsDir);
		expect(found?.id).toBe("session-B");
		expect(textOf(readPersistedMessages(found!.path)[0])).toContain("b");
	});

	it("does exact matching, not prefix matching", async () => {
		createPersistedSession("abc123", [user("short"), assistant("reply short")]);
		createPersistedSession("abc1234", [user("long"), assistant("reply long")]);

		expect((await SessionManager.findById("abc123", sessionsDir))?.id).toBe("abc123");
		expect(await SessionManager.findById("abc", sessionsDir)).toBeNull();
	});

	it("returns null for an unknown ID", async () => {
		createPersistedSession("session-A", [user("hello"), assistant("reply")]);
		expect(await SessionManager.findById("does-not-exist", sessionsDir)).toBeNull();
	});

	it("rejects path-like IDs without escaping session storage", async () => {
		createPersistedSession("session-A", [user("hello"), assistant("reply")]);
		expect(await SessionManager.findById("../../etc/passwd", sessionsDir)).toBeNull();
		expect(await SessionManager.findById("..\\..\\something", sessionsDir)).toBeNull();
		expect(await SessionManager.findById("/absolute/path", sessionsDir)).toBeNull();
		expect(await SessionManager.findById("", sessionsDir)).toBeNull();
	});
});

describe("validateSessionFile", () => {
	it("accepts a well-formed session file", () => {
		const file = createPersistedSession("valid-session", [user("hello"), assistant("reply")]);
		expect(validateSessionFile(file)).toEqual({ ok: true });
	});

	it("rejects a missing file", () => {
		expect(validateSessionFile(join(sessionsDir, "missing.jsonl"))).toEqual({
			ok: false,
			reason: "session file does not exist",
		});
	});

	it("rejects an empty file", () => {
		const file = join(sessionsDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(validateSessionFile(file)).toMatchObject({ ok: false, reason: "session file is empty" });
	});

	it("rejects a malformed JSON line", () => {
		const file = join(sessionsDir, "malformed.jsonl");
		writeFileSync(
			file,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "malformed-id",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd,
				}),
				'{"type":"message","id":"broken",',
			].join("\n"),
		);
		expect(validateSessionFile(file)).toMatchObject({ ok: false, reason: "malformed JSON on line 2" });
	});

	it("rejects an invalid session header", () => {
		const file = join(sessionsDir, "bad-header.jsonl");
		writeFileSync(file, JSON.stringify({ type: "not_session", id: "x", timestamp: "2026-01-01T00:00:00.000Z" }));
		expect(validateSessionFile(file)).toMatchObject({ ok: false, reason: "invalid session header" });
	});

	it("distinguishes a valid-header session with corrupt later entries without mutating it", async () => {
		const file = join(sessionsDir, "corrupt-later.jsonl");
		const corruptBytes = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "corrupt-later-id",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd,
			}),
			JSON.stringify({
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: user("still readable"),
			}),
			'{"type":"message","id":"entry-2","parentId":"entry-1","timestamp":"2026-01-01T00:00:02.000Z"',
		].join("\n");
		writeFileSync(file, corruptBytes);

		// findById discovers it via the readable header; validation flags corruption.
		const found = await SessionManager.findById("corrupt-later-id", sessionsDir);
		expect(found?.id).toBe("corrupt-later-id");
		expect(validateSessionFile(file)).toMatchObject({ ok: false, reason: "malformed JSON on line 3" });

		// The original persisted bytes remain intact.
		expect(readFileSync(file, "utf8")).toBe(corruptBytes);
	});
});

describe("explicit resume session lifecycle", () => {
	it("continues the same session across create/resume/continue/resume cycles", async () => {
		// Create + persist initial state.
		const original = SessionManager.create(cwd, sessionsDir);
		original.newSession({ id: "resume-e2e" });
		original.appendMessage(user("first turn"));
		original.appendMessage(assistant("first reply"));
		const file = original.getSessionFile();
		expect(file).toBeTruthy();
		expect(existsSync(file!)).toBe(true);

		// First resume by ID.
		const firstInfo = await SessionManager.findById("resume-e2e", sessionsDir);
		expect(firstInfo?.id).toBe("resume-e2e");
		expect(validateSessionFile(firstInfo!.path)).toEqual({ ok: true });

		const resumed = SessionManager.open(firstInfo!.path, sessionsDir);
		expect(resumed.getSessionId()).toBe("resume-e2e");
		expect(resumed.buildSessionContext().messages.map(textOf)).toContain("first turn");

		// Continue the same session.
		resumed.appendMessage(user("second turn"));
		resumed.appendMessage(assistant("second reply"));

		// Second resume by ID sees both turns and the same identity.
		const secondInfo = await SessionManager.findById("resume-e2e", sessionsDir);
		expect(secondInfo?.id).toBe("resume-e2e");
		expect(secondInfo?.path).toBe(file);

		const resumedAgain = SessionManager.open(secondInfo!.path, sessionsDir);
		expect(resumedAgain.getSessionId()).toBe("resume-e2e");
		const texts = resumedAgain.buildSessionContext().messages.map(textOf);
		expect(texts).toContain("first turn");
		expect(texts).toContain("second turn");
	});

	it("resumes a compacted session preserving its summary and retained turns", async () => {
		const session = SessionManager.create(cwd, sessionsDir);
		session.newSession({ id: "compacted-e2e" });
		session.appendMessage(user("old turn one"));
		session.appendMessage(assistant("old reply one"));
		const keptUserId = session.appendMessage(user("recent turn"));
		session.appendMessage(assistant("recent reply"));
		session.appendCompaction("Summary of earlier work", keptUserId, 120);

		const info = await SessionManager.findById("compacted-e2e", sessionsDir);
		expect(info?.id).toBe("compacted-e2e");

		const resumed = SessionManager.open(info!.path, sessionsDir);
		const messages = resumed.buildSessionContext().messages;
		const roles = messages.map((m) => (m as { role: string }).role);

		expect(roles).toEqual(["compactionSummary", "user", "assistant"]);
		expect((messages[0] as { summary: string }).summary).toBe("Summary of earlier work");
		const texts = messages.map(textOf);
		expect(texts).toContain("recent turn");
		expect(texts).toContain("recent reply");
		expect(texts).not.toContain("old turn one");
		expect(texts).not.toContain("old reply one");
	});

	it("hydrates a resumed session through createAgentSession with the same ID and history", async () => {
		const restoredModel = createTestModel();
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setDefaultThinkingLevel("high");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage);
		modelRegistry.registerProvider(restoredModel.provider, {
			api: restoredModel.api,
			apiKey: "test-api-key",
			baseUrl: restoredModel.baseUrl,
			models: [
				{
					id: restoredModel.id,
					name: restoredModel.name,
					api: restoredModel.api,
					reasoning: restoredModel.reasoning,
					input: restoredModel.input,
					cost: restoredModel.cost,
					contextWindow: restoredModel.contextWindow,
					maxTokens: restoredModel.maxTokens,
				},
			],
		});

		const persisted = SessionManager.create(cwd, sessionsDir);
		persisted.newSession({ id: "sdk-resume-e2e" });
		persisted.appendModelChange(restoredModel.provider, restoredModel.id);
		persisted.appendThinkingLevelChange("low");
		persisted.appendCustomEntry(SESSION_MEMORY_CUSTOM_TYPE, [
			{ key: "validation.token", value: "ORION-4821", timestamp: "2026-01-01T00:00:00.000Z" },
		]);
		persisted.appendMessage(user("what is the token?"));
		persisted.appendMessage({
			role: "assistant",
			api: restoredModel.api,
			provider: restoredModel.provider,
			model: restoredModel.id,
			stopReason: "stop",
			content: [{ type: "text", text: "The token is ORION-4821" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as unknown as Parameters<SessionManager["appendMessage"]>[0]);

		// Resolve the same way `jensen resume <id>` does, then hydrate.
		const info = await SessionManager.findById("sdk-resume-e2e", sessionsDir);
		expect(info?.id).toBe("sdk-resume-e2e");
		expect(validateSessionFile(info!.path)).toEqual({ ok: true });

		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();

		const opened = SessionManager.open(info!.path, sessionsDir);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			authStorage,
			modelRegistry,
			resourceLoader,
			sessionManager: opened,
		});

		expect(session.sessionId).toBe("sdk-resume-e2e");
		expect(session.model?.provider).toBe(restoredModel.provider);
		expect(session.model?.id).toBe(restoredModel.id);
		expect(session.thinkingLevel).toBe("low");
		expect(session.getMemoryItems()).toEqual([
			{ key: "validation.token", value: "ORION-4821", timestamp: "2026-01-01T00:00:00.000Z" },
		]);
		expect(session.messages.some((m) => textOf(m).includes("what is the token?"))).toBe(true);
	});
});

function readPersistedMessages(path: string): unknown[] {
	const entries = readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	return entries.filter((e) => e.type === "message").map((e) => e.message);
}

function createTestModel(): Model<"openai-chat"> {
	return {
		id: "sdk-resume-model",
		name: "SDK Resume Model",
		provider: "sdk-resume-provider",
		api: "openai-chat",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
	};
}
