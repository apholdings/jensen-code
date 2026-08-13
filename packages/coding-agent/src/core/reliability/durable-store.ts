/**
 * Durable Mission Store — atomic JSON persistence for a MissionRuntime document.
 *
 * Write-temp-then-rename so a process exit never leaves a partially written
 * document. This is a small, provider-independent store used by the Reliability
 * Kernel and its tests; the live agent session embeds the serialized document
 * into session state for session-associated durability.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { MissionRuntimeDocumentV1 } from "./mission-runtime.js";

const SUFFIX = ".tmp";

export class MissionFileStore {
	private readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	private resolve(missionId: string): string {
		return path.join(this.root, `${missionId}.mission.json`);
	}

	async initialize(): Promise<void> {
		await fsp.mkdir(this.root, { recursive: true });
	}

	async save(document: MissionRuntimeDocumentV1): Promise<void> {
		await this.initialize();
		const target = this.resolve(document.missionId);
		const tmp = `${target}${SUFFIX}`;
		await fsp.writeFile(tmp, JSON.stringify(document, null, 2), "utf8");
		const fh = await fsp.open(tmp, "r");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
		await fsp.rename(tmp, target);
	}

	async load(missionId: string): Promise<MissionRuntimeDocumentV1 | undefined> {
		try {
			const data = await fsp.readFile(this.resolve(missionId), "utf8");
			return JSON.parse(data) as MissionRuntimeDocumentV1;
		} catch {
			return undefined;
		}
	}

	exists(missionId: string): boolean {
		return fs.existsSync(this.resolve(missionId));
	}
}
