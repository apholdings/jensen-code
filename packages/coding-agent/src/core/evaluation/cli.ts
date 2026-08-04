import { join } from "node:path";
import chalk from "chalk";
import { checkReleaseGate } from "./gates.js";
import {
	compareArtifacts,
	createBaseline,
	discoverEvaluationPacks,
	listBaselines,
	readArtifact,
	runEvaluation,
	verifyArtifact,
	verifyBaseline,
	writeArtifact,
} from "./index.js";
import type { EvaluationArtifact, EvaluationReleaseGate } from "./types.js";

const evaluationRoot = () => join(process.cwd(), ".jensen", "evaluations");
const artifactRoot = () => join(evaluationRoot(), "artifacts");
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
			`${chalk.bold("Usage:")} jensen eval <packs|scenarios|validate|run|compare|replay|rescore|baseline|gate|doctor>`,
		);
		return true;
	}
	if (command === "doctor") {
		const discovered = await discoverEvaluationPacks();
		const result = {
			name: "evaluation",
			status: discovered.errors.length ? "fail" : "pass",
			packs: discovered.packs.length,
			scenarios: discovered.scenarios.length,
			errors: discovered.errors,
		};
		print(result, json);
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
		const artifacts: EvaluationArtifact[] = [];
		for (const scenario of scenarios) {
			const artifact = await runEvaluation(scenario, {
				mode,
				live: args.includes("--live"),
				budget: {
					maximumCostUsd: option(args, "--max-cost-usd") ? Number(option(args, "--max-cost-usd")) : undefined,
				},
			});
			await writeArtifact(artifactRoot(), artifact);
			artifacts.push(artifact);
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
		const baseline = await readArtifact(artifactRoot(), args[2] ?? "");
		const candidate = await readArtifact(artifactRoot(), args[3] ?? "");
		print(compareArtifacts(baseline, candidate), json);
		return true;
	}
	if (command === "replay" || command === "rescore") {
		const artifact = await readArtifact(artifactRoot(), args[2] ?? "");
		print(
			{ ...artifact, replay: true, rescore: command === "rescore", originalArtifactId: artifact.artifactHash },
			json,
		);
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
		const artifacts = await Promise.all(artifactIds.map((id) => readArtifact(artifactRoot(), id)));
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
	const artifacts = await Promise.all(artifactIds.map((id) => readArtifact(artifactRoot(), id)));
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
