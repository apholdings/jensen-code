/**
 * CLI surface for workspace indexing and retrieval.
 *
 * Commands: `jensen index ...`, `jensen search ...`, `jensen retrieval ...`,
 * and `jensen doctor index|embeddings|retrieval`. All default commands are
 * bounded; `--json` produces machine-readable output.
 */

import { embeddingSummary, resolveIndexConfig } from "./workspace/config.js";
import { type EmbeddingConfig, resolveEmbeddingBackend } from "./workspace/embedding.js";
import { WorkspaceIndex } from "./workspace/index.js";

export function workspaceCliUsage(): string {
	return [
		"Usage: jensen <index|search|retrieval> ...",
		"  index status|build|refresh|rebuild|verify|generations|inspect <gen>|files|symbols|stats|prune [--preview|--execute] [--json] [--root <dir>]",
		"  search [lexical|semantic|symbol|hybrid] <query> [--limit N] [--root <dir>] [--json]",
		"  retrieval plan <query> | retrieval explain <result-id> [--root <dir>] [--json]",
		"  doctor index|embeddings|retrieval [--root <dir>] [--json]",
	].join("\n");
}

function flagOr(options: string[], long: string, fallback?: string): string | undefined {
	const idx = options.indexOf(long);
	if (idx !== -1 && options[idx + 1] && !options[idx + 1].startsWith("--")) return options[idx + 1];
	return fallback;
}

function json(args: string[]): boolean {
	return args.includes("--json");
}

async function makeIndex(args: string[]): Promise<{ index: WorkspaceIndex; root: string }> {
	const root = flagOr(args, "--root", process.cwd()) ?? process.cwd();
	const index = new WorkspaceIndex(root, resolveIndexConfig());
	return { index, root };
}

function print(value: unknown, isJson: boolean): void {
	if (isJson) console.log(JSON.stringify(value, null, 2));
	else console.log(formatHuman(value));
}

function formatHuman(value: unknown): string {
	if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n");
	if (value && typeof value === "object") return JSON.stringify(value, null, 2);
	return String(value);
}

async function doctorReport(args: string[], isJson: boolean): Promise<number> {
	const { index } = await makeIndex(args);
	const sub = args[1];
	const checks: Array<{ name: string; status: string; message: string }> = [];
	const status = index.status();

	if (!sub || sub === "index") {
		const v = index.verify();
		checks.push({
			name: "index.storage",
			status: v.valid ? "pass" : "fail",
			message: v.valid ? "index readable and consistent" : v.issues.join("; ") || "corrupt",
		});
		checks.push({
			name: "index.ready_generation",
			status: status.hasReadyGeneration ? "pass" : "fail",
			message: status.hasReadyGeneration
				? `generation ${status.currentGeneration}`
				: "no ready generation — run `jensen index build`",
		});
		checks.push({
			name: "index.schema",
			status: status.schemaVersion === 1 ? "pass" : "warn",
			message: `schemaVersion ${status.schemaVersion}`,
		});
		checks.push({
			name: "index.freshness",
			status:
				status.freshnessCheck === "current"
					? "pass"
					: status.freshnessCheck === "possibly_stale"
						? "warn"
						: "unavailable",
			message: `freshness ${status.freshnessCheck ?? "unknown"}`,
		});
		checks.push({
			name: "index.disk",
			status: "pass",
			message: `storage ${status.storageDir}`,
		});
	}
	if (!sub || sub === "embeddings") {
		const cfg = resolveIndexConfig();
		const summary = embeddingSummary(cfg);
		const mode = summary.mode;
		checks.push({
			name: "embeddings.mode",
			status: mode === "disabled" ? "disabled" : mode === "fixture" ? "pass" : mode === "local" ? "pass" : "warn",
			message: `mode=${mode} local=${summary.local} model=${summary.modelId ?? "n/a"} dims=${summary.dimensions ?? "n/a"}`,
		});
		if (mode === "remote") {
			checks.push({
				name: "embeddings.remote",
				status: "warn",
				message: "remote embedding enabled (policy authorized)",
			});
		}
		checks.push({
			name: "embeddings.backend",
			status: mode === "disabled" ? "disabled" : "pass",
			message: resolveEmbeddingBackend(cfg.embedding).backendId,
		});
	}
	if (!sub || sub === "retrieval") {
		checks.push({
			name: "retrieval.lexical",
			status: "pass",
			message: "portable postings + BM25 backend",
		});
		checks.push({
			name: "retrieval.generations",
			status: status.hasReadyGeneration ? "pass" : "unavailable",
			message: `${index.generations().length} generation(s)`,
		});
	}
	print(
		{
			checks,
			summary: `read-only workspace index diagnostics for ${status.root}`,
			exitCode: checks.some((c) => c.status === "fail") ? 2 : checks.some((c) => c.status === "warn") ? 1 : 0,
		},
		isJson,
	);
	return checks.some((c) => c.status === "fail") ? 2 : checks.some((c) => c.status === "warn") ? 1 : 0;
}

export async function handleWorkspaceRetrievalCommand(args: string[]): Promise<boolean> {
	const namespace = args[0];

	if (namespace === "doctor" && (args[1] === "index" || args[1] === "embeddings" || args[1] === "retrieval")) {
		await doctorReport(args, json(args));
		return true;
	}

	if (!["index", "search", "retrieval"].includes(namespace ?? "")) return false;
	const isJson = json(args);
	try {
		if (namespace === "index") {
			await handleIndex(args.slice(1), isJson);
			return true;
		}
		if (namespace === "search") {
			await handleSearch(args.slice(1), isJson);
			return true;
		}
		await handleRetrieval(args.slice(1), isJson);
		return true;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
		return true;
	}
}

async function handleIndex(args: string[], isJson: boolean): Promise<void> {
	const cmd = args[0];
	const { index } = await makeIndex(args);
	switch (cmd) {
		case "status": {
			print(index.status(), isJson);
			break;
		}
		case "build": {
			const report = await index.build();
			print(report, isJson);
			break;
		}
		case "refresh": {
			const report = await index.refresh();
			print(report, isJson);
			break;
		}
		case "rebuild": {
			const report = await index.rebuild();
			print(report, isJson);
			break;
		}
		case "verify": {
			print(index.verify(true), isJson);
			break;
		}
		case "generations": {
			print(index.generations(), isJson);
			break;
		}
		case "inspect": {
			const genArg = args[1];
			const gen = genArg && !genArg.startsWith("--") ? genArg : (index.status().currentGeneration ?? "");
			const detail = index.inspectGeneration(gen);
			if (!detail) throw new Error(`Unknown generation: ${gen}`);
			print(detail, isJson);
			break;
		}
		case "files": {
			print(index.files(), isJson);
			break;
		}
		case "symbols": {
			print(index.symbols(), isJson);
			break;
		}
		case "stats": {
			print(index.stats(), isJson);
			break;
		}
		case "prune": {
			const preview = !args.includes("--execute");
			const result = index.prune({ preview });
			print(result, isJson);
			break;
		}
		default:
			throw new Error(`Unknown index subcommand: ${cmd}\n${workspaceCliUsage()}`);
	}
	index.close();
}

async function handleSearch(args: string[], isJson: boolean): Promise<void> {
	// search [mode] <query> [--limit N] [--root dir]
	let mode = "hybrid";
	let queryArgs: string[] = [];
	const first = args[0];
	if (first && ["lexical", "semantic", "symbol", "hybrid", "path"].includes(first)) {
		mode = first;
		queryArgs = args.slice(1);
	} else {
		queryArgs = args;
	}
	const query = queryArgs.find((a) => !a.startsWith("--")) ?? "";
	if (!query) throw new Error("search requires a query");
	const limitRaw = flagOr(args, "--limit", undefined) ?? undefined;
	const limit = limitRaw ? Number(limitRaw) : undefined;
	const { index } = await makeIndex(args);
	const { plan, results } = index.search({ query, mode: mode as never, limit });
	print({ plan: { mode: plan.mode, normalizedQuery: plan.normalizedQuery }, results }, isJson);
	index.close();
}

async function handleRetrieval(args: string[], isJson: boolean): Promise<void> {
	const cmd = args[0];
	const { index } = await makeIndex(args);
	if (cmd === "plan") {
		const query = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
		if (!query) throw new Error("retrieval plan requires a query");
		const { plan } = index.search({ query });
		print(plan, isJson);
	} else if (cmd === "explain") {
		const resultId = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
		if (!resultId) throw new Error("retrieval explain requires a result-id");
		// Result ids are stable: generation + chunk. Look up the chunk.
		const status = index.status();
		const gen = status.currentGeneration ?? "";
		const chunkId = resultId.replace(`${gen}_`, "");
		const db = openRaw(index);
		const chunk = db.chunkById(gen, chunkId);
		const file = chunk ? db.getFile(gen, chunk.fileId) : undefined;
		print(
			{
				resultId,
				generation: gen,
				path: file?.workspaceRelativePath,
				startLine: chunk?.startLine,
				endLine: chunk?.endLine,
				snippet: chunk?.text?.slice(0, 400),
				note: "score signals and reason codes are available in search output for each result",
			},
			isJson,
		);
		closeRaw(db);
	} else {
		throw new Error(`Unknown retrieval subcommand: ${cmd}\n${workspaceCliUsage()}`);
	}
	index.close();
}

// Raw DB access for explain lookups (avoids re-opening workspace id mismatch).
import { WorkspaceDb } from "./workspace/storage.js";

function openRaw(index: WorkspaceIndex): WorkspaceDb {
	const status = index.status();
	return WorkspaceDb.open(status.storageDir, status.workspaceId);
}
function closeRaw(db: WorkspaceDb): void {
	db.close();
}

export type { EmbeddingConfig };
