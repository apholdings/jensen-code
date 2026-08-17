import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.js";
import { loadOperatorRoster, OPERATOR_ROSTER_NAMES } from "../operator-roster.js";
import type { OrchestrationPlanDocument, OrchestrationStore } from "./types.js";
import { validateOrchestrationPlan } from "./validation.js";

const SUFFIX = ".orchestration.json";
const TMP_SUFFIX = ".tmp";

function safeId(id: string): boolean {
	return /^[A-Za-z0-9._-]+$/u.test(id) && id !== "." && id !== "..";
}

function equal(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export interface FileOrchestrationStoreOptions {
	root: string;
	storeId?: string;
}

export function defaultOrchestrationRoot(): string {
	return process.env.JENSEN_ORCHESTRATION_DIR?.trim() || path.join(os.homedir(), ".jensen", "orchestrations");
}

export class FileOrchestrationStore implements OrchestrationStore {
	readonly storeId: string;
	private readonly root: string;
	constructor(options: FileOrchestrationStoreOptions) {
		this.root = path.resolve(options.root);
		this.storeId = options.storeId ?? "file";
	}
	private file(id: string): string {
		if (!safeId(id)) throw new Error(`Unsafe orchestration id: ${id}`);
		return path.join(this.root, `${id}${SUFFIX}`);
	}
	/**
	 * Explicit operator set for this file-backed store's plan validation.
	 * The canonical subagent registry remains the primary authority; this
	 * only extends it with the operator roster names loaded from
	 * `getAgentDir()/agents/*.md`, so a roster-based plan created through the
	 * automatic path stays readable (status/join) after the fact. A roster
	 * that cannot be read must not break store reads: in that case the
	 * canonical operator roles — which the roster guarantees to exist —
	 * remain the accepted fallback.
	 */
	private operatorAgents(): readonly string[] {
		try {
			return loadOperatorRoster({ agentDir: getAgentDir() }).agents.map((agent) => agent.name);
		} catch {
			return [...OPERATOR_ROSTER_NAMES];
		}
	}
	private async read(id: string): Promise<OrchestrationPlanDocument | undefined> {
		try {
			return JSON.parse(await fsp.readFile(this.file(id), "utf8")) as OrchestrationPlanDocument;
		} catch {
			return undefined;
		}
	}
	private async write(id: string, document: OrchestrationPlanDocument): Promise<void> {
		await fsp.mkdir(this.root, { recursive: true });
		const target = this.file(id);
		const tmp = `${target}.${randomUUID()}${TMP_SUFFIX}`;
		const fh = await fsp.open(tmp, "w", 0o600);
		try {
			await fh.writeFile(JSON.stringify(document, null, 2), "utf8");
			await fh.sync();
		} finally {
			await fh.close();
		}
		await fsp.rename(tmp, target);
	}
	private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
		await fsp.mkdir(this.root, { recursive: true });
		const target = this.file(id);
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(target, {
				realpath: false,
				stale: 30_000,
				retries: { retries: 8, factor: 2, minTimeout: 20, maxTimeout: 250, randomize: true },
			});
		} catch (error) {
			throw new Error(`ORCHESTRATION_LOCK_FAILED: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			return await fn();
		} finally {
			try {
				await release?.();
			} catch {
				/* best effort */
			}
		}
	}
	async create(document: OrchestrationPlanDocument) {
		return this.locked(document.plan.orchestrationId, async () => {
			const existing = await this.read(document.plan.orchestrationId);
			if (existing)
				return equal(existing.plan, document.plan)
					? { status: "idempotent" as const, document: existing }
					: { status: "conflict" as const, error: "orchestration already exists with different plan" };
			await this.write(document.plan.orchestrationId, document);
			return { status: "created" as const };
		});
	}
	async load(orchestrationId: string) {
		const document = await this.read(orchestrationId);
		if (!document) {
			try {
				await fsp.access(this.file(orchestrationId));
				return { status: "corrupt" as const, diagnostic: "invalid orchestration JSON" };
			} catch {
				return { status: "missing" as const };
			}
		}
		if (
			document.schemaVersion !== 1 ||
			document.plan.schemaVersion !== 1 ||
			document.plan.orchestrationId !== orchestrationId
		)
			return { status: "corrupt" as const, diagnostic: "invalid orchestration schema or identity" };
		const validation = validateOrchestrationPlan(document.plan, {
			operatorAgents: this.operatorAgents(),
		});
		if (!validation.valid)
			return {
				status: "corrupt" as const,
				diagnostic: validation.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "),
			};
		return { status: "ok" as const, document };
	}
	async save(document: OrchestrationPlanDocument, options: { expectedRevision?: number } = {}) {
		return this.locked(document.plan.orchestrationId, async () => {
			const current = await this.read(document.plan.orchestrationId);
			if (!current) return { status: "stale" as const, expectedRevision: options.expectedRevision ?? 0 };
			if (options.expectedRevision !== undefined && current.plan.revision !== options.expectedRevision)
				return {
					status: "stale" as const,
					expectedRevision: options.expectedRevision,
					actualRevision: current.plan.revision,
				};
			await this.write(document.plan.orchestrationId, document);
			return { status: "saved" as const, document };
		});
	}
	async mutate<T>(
		orchestrationId: string,
		mutation: (
			document: OrchestrationPlanDocument,
		) => { kind: "write"; document: OrchestrationPlanDocument; value: T } | { kind: "noop"; value: T },
	): Promise<{ status: "ok"; value: T } | { status: "missing" } | { status: "corrupt"; diagnostic: string }> {
		return this.locked(orchestrationId, async () => {
			const document = await this.read(orchestrationId);
			if (!document) return { status: "missing" as const };
			const result = mutation(document);
			if (result.kind === "write") await this.write(orchestrationId, result.document);
			return { status: "ok" as const, value: result.value };
		});
	}
	async list(): Promise<string[]> {
		try {
			return (await fsp.readdir(this.root))
				.filter((entry) => entry.endsWith(SUFFIX))
				.map((entry) => entry.slice(0, -SUFFIX.length))
				.sort();
		} catch {
			return [];
		}
	}
	async withExclusive<T>(
		orchestrationId: string,
		fn: (
			document: OrchestrationPlanDocument,
			save: (document: OrchestrationPlanDocument) => Promise<void>,
		) => Promise<T>,
	): Promise<T> {
		return this.locked(orchestrationId, async () => {
			const current = await this.read(orchestrationId);
			if (!current) throw new Error(`ORCHESTRATION_NOT_FOUND: ${orchestrationId}`);
			let next = current;
			const save = async (document: OrchestrationPlanDocument): Promise<void> => {
				next = document;
			};
			const value = await fn(current, save);
			if (next !== current) await this.write(orchestrationId, next);
			return value;
		});
	}
}

export function createFileOrchestrationStore(root: string = defaultOrchestrationRoot()): FileOrchestrationStore {
	return new FileOrchestrationStore({ root });
}
