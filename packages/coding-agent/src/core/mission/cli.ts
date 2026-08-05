/**
 * Durable Mission Graph — Mission Control CLI (2.0.0).
 *
 * Exposes:
 *   jensen mission create <definition.json>
 *   jensen mission validate <id|file>
 *   jensen mission plan <id|file>
 *   jensen mission graph <id|file>
 *   jensen mission start <id>
 *   jensen mission status <id>
 *   jensen mission replay <id>
 *   jensen mission reconcile --preview <id>
 *   jensen doctor mission
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveReadiness, initializeRuntime, missionStatus, promoteMission, reconcileAfterReboot } from "./engine.js";
import {
	buildMissionDocument,
	computeCriticalPath,
	computeMissionGraphDigest,
	topologicallyOrdered,
	validateMissionGraph,
} from "./graph.js";
import { buildSchedulePlan } from "./scheduler.js";
import { MissionStore } from "./store.js";
import type { MissionContract, MissionGraphDocumentV1, MissionObjective, MissionScope } from "./types.js";

export interface MissionDefinitionInput {
	missionId: string;
	scope: MissionScope;
	objectives: MissionObjective[];
	contracts?: MissionContract[];
}

export function defaultMissionRoot(): string {
	const env = process.env.JENSEN_MISSION_STORE;
	if (env?.trim()) return env.trim();
	return path.join(os.homedir(), ".jensen", "missions");
}

export function missionDir(root: string, missionId: string): string {
	return path.join(root, missionId);
}

function storeFor(root: string, missionId: string): MissionStore {
	return new MissionStore({ root: missionDir(root, missionId) });
}

function loadDocumentFromFile(file: string): MissionGraphDocumentV1 {
	const raw = fs.readFileSync(path.resolve(file), "utf8");
	const def = JSON.parse(raw) as MissionDefinitionInput | MissionGraphDocumentV1;
	if ("schemaVersion" in def && (def as MissionGraphDocumentV1).schemaVersion === 1) {
		return def as MissionGraphDocumentV1;
	}
	const d = def as MissionDefinitionInput;
	return buildMissionDocument(
		d.missionId,
		{ ...d.scope, requireDeclaredRepositories: true },
		d.objectives,
		d.contracts ?? [],
		1,
		"DRAFT",
		Date.now(),
	);
}

async function loadDocument(root: string, idOrFile: string): Promise<MissionGraphDocumentV1 | undefined> {
	if (idOrFile.includes("/") || idOrFile.endsWith(".json")) {
		return loadDocumentFromFile(idOrFile);
	}
	const store = storeFor(root, idOrFile);
	await store.initialize();
	return store.loadGraph();
}

function usage(): string {
	return [
		"Mission Control (2.0.0)",
		"  mission create <definition.json>   create and store a mission graph",
		"  mission validate <id|file>         validate a mission graph",
		"  mission plan <id|file>             print the schedule plan (waves + critical path)",
		"  mission graph <id|file>            print objectives, dependencies and critical path",
		"  mission start <id>                 promote to ACTIVE",
		"  mission status <id>                print objective/mission status",
		"  mission replay <id>                replay the event log (zero effects)",
		"  mission reconcile --preview <id>   show post-reboot reconciliation actions (no mutation)",
		"  doctor mission                     health-check the mission store",
	].join("\n");
}

export async function handleMissionCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "mission" && !(args[0] === "doctor" && args[1] === "mission")) {
		return false;
	}

	if (args[0] === "doctor" && args[1] === "mission") {
		const root = defaultMissionRoot();
		const sysRoot = new MissionStore({ root: path.join(root, "__sys__") });
		await sysRoot.initialize();
		const json = args.includes("--json");
		const report = { name: "mission", status: "ok", store: root, message: "mission store reachable" };
		if (json) {
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		} else {
			process.stdout.write(`✓ mission: store reachable at ${root}\n`);
		}
		return true;
	}

	const sub = args[1];
	const json = args.includes("--json");
	const preview = args.includes("--preview");
	const root = defaultMissionRoot();
	const valueArgs = args.filter((a) => !a.startsWith("--"));

	switch (sub) {
		case "create": {
			const file = valueArgs[2];
			if (!file) {
				process.stderr.write(`missing definition file\n${usage()}\n`);
				process.exitCode = 1;
				return true;
			}
			const doc = loadDocumentFromFile(file);
			const validation = validateMissionGraph(doc);
			if (!validation.valid) {
				process.stderr.write(`mission '${doc.missionId}' invalid\n`);
				for (const e of validation.errors) process.stderr.write(`  ${e.severity}: ${e.message}\n`);
				process.exitCode = 1;
				return true;
			}
			const store = storeFor(root, doc.missionId);
			await store.initialize();
			await store.saveGraph(doc);
			const out = { missionId: doc.missionId, revision: doc.revision, digest: doc.digest, status: doc.status };
			if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
			else process.stdout.write(`created ${doc.missionId} rev ${doc.revision} ${doc.digest}\n`);
			return true;
		}

		case "validate": {
			const idOrFile = valueArgs[2];
			if (!idOrFile) {
				process.stderr.write("missing mission id or file\n");
				process.exitCode = 1;
				return true;
			}
			const doc = await loadDocument(root, idOrFile);
			if (!doc) {
				process.stderr.write("mission not found\n");
				process.exitCode = 1;
				return true;
			}
			const validation = validateMissionGraph(doc);
			const payload = {
				missionId: doc.missionId,
				valid: validation.valid,
				digest: validation.digest,
				revision: validation.revision,
				errors: validation.errors.map((e) => ({ severity: e.severity, message: e.message })),
				cycles: validation.cycles,
			};
			if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
			else if (validation.valid) process.stdout.write(`valid ${doc.missionId} ${validation.digest}\n`);
			else {
				process.stderr.write(`invalid ${doc.missionId}\n`);
				process.exitCode = 1;
			}
			return true;
		}

		case "plan":
		case "graph": {
			const idOrFile = valueArgs[2];
			if (!idOrFile) {
				process.stderr.write("missing mission id or file\n");
				process.exitCode = 1;
				return true;
			}
			const doc = await loadDocument(root, idOrFile);
			if (!doc) {
				process.stderr.write("mission not found\n");
				process.exitCode = 1;
				return true;
			}
			const runtime = initializeRuntime(doc);
			const readiness = deriveReadiness(doc, runtime);
			const plan = buildSchedulePlan(doc, {
				status: new Map(Object.entries(readiness.status)),
				parallelismBound: 4,
				enforceBudget: false,
			});
			const topo = topologicallyOrdered(doc);
			if (sub === "graph") {
				const payload = {
					missionId: doc.missionId,
					objectives: doc.objectives.map((o) => ({
						id: o.id,
						deps: o.dependencies,
						repos: o.declaredRepositories,
					})),
					topologicalOrder: topo,
					criticalPath: computeCriticalPath(doc),
					digest: computeMissionGraphDigest(doc.scope, doc.objectives, doc.contracts),
				};
				if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
				else {
					process.stdout.write(`objectives: ${doc.objectives.map((o) => o.id).join(", ")}\n`);
					process.stdout.write(`topo: ${topo.join(" -> ")}\n`);
					process.stdout.write(
						`critical path: ${payload.criticalPath.path.join(" -> ")} (${payload.criticalPath.weight})\n`,
					);
				}
			} else {
				const payload = {
					missionId: doc.missionId,
					waves: plan.waves,
					criticalPath: plan.criticalPath,
					serializedGroups: plan.serializedGroups,
					budgetExceeded: plan.budgetExceeded,
				};
				if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
				else {
					process.stdout.write(`waves:\n`);
					for (const [i, w] of plan.waves.entries()) {
						process.stdout.write(`  wave ${i + 1}: ${w.join(", ")}\n`);
					}
					process.stdout.write(`critical path: ${plan.criticalPath.join(" -> ")}\n`);
				}
			}
			return true;
		}

		case "start": {
			const id = valueArgs[2];
			if (!id) {
				process.stderr.write("missing mission id\n");
				process.exitCode = 1;
				return true;
			}
			const store = storeFor(root, id);
			await store.initialize();
			const doc = await store.loadGraph();
			if (!doc) {
				process.stderr.write("mission not found\n");
				process.exitCode = 1;
				return true;
			}
			const promoted = promoteMission(doc);
			if (!promoted.ok || !promoted.value) {
				process.stderr.write(`cannot start: ${promoted.error}\n`);
				process.exitCode = 1;
				return true;
			}
			await store.saveGraph(promoted.value);
			if (json)
				process.stdout.write(
					`${JSON.stringify({ missionId: id, status: promoted.value.status, revision: promoted.value.revision }, null, 2)}\n`,
				);
			else process.stdout.write(`${id} -> ${promoted.value.status} (rev ${promoted.value.revision})\n`);
			return true;
		}

		case "status": {
			const id = valueArgs[2];
			if (!id) {
				process.stderr.write("missing mission id\n");
				process.exitCode = 1;
				return true;
			}
			const doc = await loadDocument(root, id);
			if (!doc) {
				process.stderr.write("mission not found\n");
				process.exitCode = 1;
				return true;
			}
			const runtime = initializeRuntime(doc);
			const readiness = deriveReadiness(doc, runtime);
			const payload = {
				missionId: doc.missionId,
				status: missionStatus(doc, runtime),
				revision: doc.revision,
				objectives: Object.entries(readiness.status).map(([id, s]) => ({ id, status: s })),
			};
			if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
			else {
				process.stdout.write(`${payload.missionId} [${payload.status}]\n`);
				for (const o of payload.objectives) process.stdout.write(`  ${o.id}: ${o.status}\n`);
			}
			return true;
		}

		case "replay": {
			const id = valueArgs[2];
			if (!id) {
				process.stderr.write("missing mission id\n");
				process.exitCode = 1;
				return true;
			}
			const store = storeFor(root, id);
			await store.initialize();
			const events = await store.replayEvents(id);
			const payload = {
				missionId: id,
				replayedEvents: events.length,
				distinctEventIds: new Set(events.map((e) => e.id)).size,
				duplicatesSkipped: events.length - new Set(events.map((e) => e.id)).size,
				note: "replay is read-only; zero external effects",
			};
			if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
			else process.stdout.write(`replayed ${events.length} events (read-only)\n`);
			return true;
		}

		case "reconcile": {
			const id = valueArgs[2];
			if (!id) {
				process.stderr.write("missing mission id\n");
				process.exitCode = 1;
				return true;
			}
			const doc = await loadDocument(root, id);
			if (!doc) {
				process.stderr.write("mission not found\n");
				process.exitCode = 1;
				return true;
			}
			const runtime = initializeRuntime(doc);
			const actions = reconcileAfterReboot(doc, runtime, /*processStillExists*/ false);
			const payload = {
				missionId: id,
				preview,
				actions: actions.actions,
				processRecordedMissing: actions.processRecordedMissing,
			};
			if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
			else {
				process.stdout.write(`${preview ? "preview" : "reconcile"} ${id}:\n`);
				for (const a of actions.actions) process.stdout.write(`  ${a}\n`);
				if (preview) process.stdout.write("  (no changes applied)\n");
			}
			return true;
		}

		default:
			process.stdout.write(`${usage()}\n`);
			return true;
	}
}
