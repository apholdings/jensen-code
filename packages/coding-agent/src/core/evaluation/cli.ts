import { join } from "node:path";
import chalk from "chalk";
import { checkReleaseGate } from "./gates.js";
import {
	aggregateStability,
	clusterFailure,
	compareArtifacts,
	createArtifact,
	createBaseline,
	discoverEvaluationPacks,
	inspectArtifactStore,
	listArtifacts,
	listBaselines,
	mergeFailureClusters,
	pruneEvaluationStore,
	readArtifact,
	replayArtifact,
	rescoreArtifact,
	runEvaluation,
	verifyArtifact,
	verifyBaseline,
	writeArtifact,
} from "./index.js";
import type { EvaluationArtifact, EvaluationReleaseGate } from "./types.js";

const evaluationRoot = () => join(process.cwd(), ".jensen", "evaluations");
const baselineRoot = () => join(evaluationRoot(), "baselines");

function jsonOutput(args: string[]): boolean {
	return args.includes("--json");
}

function print(value: unknown, json: boolean): void {
	console.log(
		json ? JSON.stringify(value, null, 2) : typeof value === "string" ? value : JSON.stringify(value, null, 2),
	);
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

export async function handleEvaluationCommand(args: string[]): Promise<boolean> {
	const isDoctor = args[0] === "doctor" && args[1] === "eval";
	if (args[0] !== "eval" && !isDoctor) return false;
	const command = isDoctor ? "doctor" : (args[1] ?? "help");
	const json = jsonOutput(args);
	if (command === "help") {
		console.log(
			`${chalk.bold("Usage:")} jensen eval <packs|scenarios|validate|run|compare|replay|rescore|stability|failures|prune|baseline|gate|doctor>`,
		);
		return true;
	}
	if (command === "doctor") {
		const discovered = await discoverEvaluationPacks();
		const store = await inspectArtifactStore(evaluationRoot());
		const errors = [...discovered.errors, ...store.errors];
		const warnings = [...store.warnings];
		const status = errors.length ? "fail" : warnings.length ? "warn" : "pass";
		const result = {
			name: "evaluation",
			status,
			packs: discovered.packs.length,
			scenarios: discovered.scenarios.length,
			store,
			errors,
			warnings,
			exitCode: errors.length ? 2 : warnings.length ? 1 : 0,
		};
		print(result, json);
		process.exitCode = result.exitCode;
		return true;
	}
	const discovered = await discoverEvaluationPacks();
	if (command === "packs") {
		print(discovered.packs, json);
		return true;
	}
	if (command === "scenarios") {
		print(discovered.scenarios, json);
		return true;
	}
	if (command === "validate") {
		print({ valid: discovered.errors.length === 0, errors: discovered.errors }, json);
		if (discovered.errors.length) process.exitCode = 1;
		return true;
	}
	if (command === "stability") {
		const artifact = await readArtifact(evaluationRoot(), args[2] ?? "");
		print(artifact.stability ?? aggregateStability([artifact]), json);
		return true;
	}
	if (command === "failures") {
		const clusters = mergeFailureClusters(
			(await listArtifacts(evaluationRoot())).flatMap((artifact) => {
				const cluster = clusterFailure(artifact);
				return cluster ? [cluster] : [];
			}),
		);
		print(clusters, json);
		if (clusters.length > 0) process.exitCode = 1;
		return true;
	}
	if (command === "prune") {
		const execute = args.includes("--execute");
		if (!execute && !args.includes("--preview")) throw new Error("eval prune requires --preview or --execute");
		print(await pruneEvaluationStore(evaluationRoot(), execute), json);
		return true;
	}
	if (command === "run") {
		const target = args[2];
		const mode = (option(args, "--mode") ?? "fixture") as "offline" | "fixture" | "sandbox" | "live";
		const scenarios =
			target && discovered.packs.some((pack) => pack.packId === target)
				? discovered.scenarios.filter((scenario) =>
						discovered.packs.find((pack) => pack.packId === target)?.scenarios.includes(scenario.scenarioId),
					)
				: target
					? discovered.scenarios.filter((scenario) => scenario.scenarioId === target)
					: [];
		if (!scenarios.length) throw new Error(`unknown evaluation scenario or pack: ${target ?? ""}`);
		if (mode === "live" && !args.includes("--confirm-live"))
			throw new Error("live evaluation requires --confirm-live");
		const requestedRepeat = option(args, "--repeat");
		const repeat = requestedRepeat === undefined ? 1 : Number(requestedRepeat);
		if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a positive integer");
		const artifacts: EvaluationArtifact[] = [];
		for (const scenario of scenarios) {
			const repetitions: EvaluationArtifact[] = [];
			for (let repetition = 0; repetition < repeat; repetition += 1) {
				const artifact = await runEvaluation(scenario, {
					mode,
					candidate: {
						providerProfile: option(args, "--provider-profile") ?? "fixture",
						provider: option(args, "--provider") ?? "fixture",
						configuredModel: option(args, "--model") ?? "deterministic-fixture",
						seed: repetition,
					},
					live: args.includes("--live"),
					budget: {
						maximumCostUsd: option(args, "--max-cost-usd") ? Number(option(args, "--max-cost-usd")) : undefined,
						maximumModelCalls: option(args, "--max-model-calls")
							? Number(option(args, "--max-model-calls"))
							: undefined,
						maximumWallTimeMs: option(args, "--max-wall-time-ms")
							? Number(option(args, "--max-wall-time-ms"))
							: undefined,
					},
				});
				await writeArtifact(evaluationRoot(), artifact);
				repetitions.push(artifact);
				artifacts.push(artifact);
			}
			if (repeat > 1) {
				const first = repetitions[0]!;
				const stability = aggregateStability(repetitions);
				const { artifactHash: _artifactHash, ...unsigned } = first;
				const grouped = createArtifact({
					...unsigned,
					stability,
					provenance: {
						...first.provenance,
						sourceRunIds: repetitions.map((artifact) => artifact.run.evaluationRunId),
					},
				});
				await writeArtifact(evaluationRoot(), grouped);
				artifacts.push(grouped);
			}
		}
		print(
			{
				artifacts: artifacts.map((artifact) => ({
					artifactId: artifact.artifactHash,
					scenarioId: artifact.scenario.scenarioId,
					verdict: artifact.verdict,
				})),
			},
			json,
		);
		return true;
	}
	if (command === "compare") {
		const baseline = await readArtifact(evaluationRoot(), args[2] ?? "");
		const candidate = await readArtifact(evaluationRoot(), args[3] ?? "");
		print(compareArtifacts(baseline, candidate), json);
		return true;
	}
	if (command === "replay" || command === "rescore") {
		const artifact = await readArtifact(evaluationRoot(), args[2] ?? "");
		const replayed = command === "replay" ? replayArtifact(artifact) : rescoreArtifact(artifact);
		await writeArtifact(evaluationRoot(), replayed);
		print({ artifactId: replayed.artifactHash, originalArtifactId: artifact.artifactHash, artifact: replayed }, json);
		return true;
	}
	if (command === "baseline") return handleBaselineCommand(args.slice(2), json);
	if (command === "gate") return handleGateCommand(args.slice(2), json);
	throw new Error(`unknown eval command: ${command}`);
}

async function handleBaselineCommand(args: string[], json: boolean): Promise<boolean> {
	const subcommand = args[0] ?? "list";
	if (subcommand === "list") {
		print(await listBaselines(baselineRoot()), json);
		return true;
	}
	if (subcommand === "verify") {
		const baselineId = args[1] ?? "";
		print({ baselineId, valid: await verifyBaseline(baselineRoot(), baselineId) }, json);
		return true;
	}
	if (subcommand === "create") {
		const artifactIds = args.slice(1).filter((arg) => !arg.startsWith("--"));
		const artifacts = await Promise.all(artifactIds.map((id) => readArtifact(evaluationRoot(), id)));
		const first = artifacts[0];
		if (!first) throw new Error("baseline create requires artifact ids");
		const baseline = await createBaseline(
			baselineRoot(),
			{
				artifactIds,
				createdAt: new Date().toISOString(),
				candidate: first.candidate,
				packId: option(args, "--pack") ?? "custom",
				packVersion: option(args, "--pack-version") ?? "1",
			},
			artifacts,
		);
		print(baseline, json);
		return true;
	}
	throw new Error(`unknown baseline command: ${subcommand}`);
}

async function handleGateCommand(args: string[], json: boolean): Promise<boolean> {
	if (args[0] !== "check") throw new Error(`unknown gate command: ${args[0] ?? ""}`);
	const artifactIds = args.slice(1).filter((arg) => !arg.startsWith("--"));
	const artifacts = await Promise.all(artifactIds.map((id) => readArtifact(evaluationRoot(), id)));
	if (artifacts.some((artifact) => !verifyArtifact(artifact))) throw new Error("invalid evaluation artifact");
	const gate: EvaluationReleaseGate = {
		gateId: "default",
		scenarioPack: option(args, "--pack") ?? "custom",
		baselineId: option(args, "--baseline") ?? "required",
		requiredScenarioPasses: artifacts.map((artifact) => artifact.scenario.scenarioId),
		forbiddenRegressions: [],
		maximumCriticalSafetyFailures: 0,
		maximumHighSafetyFailures: 0,
		flakinessPolicy: { rejectNewFlakiness: true, minimumRepetitions: 1 },
	};
	const result = checkReleaseGate(gate, artifacts, []);
	print(result, json);
	if (!result.passed) process.exitCode = 1;
	return true;
}
