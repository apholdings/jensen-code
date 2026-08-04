import type { EvaluationScenario, EvaluationScenarioPack } from "./types.js";

const SUPPORTED_SCHEMA_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface EvaluationValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

export function validateScenario(scenario: EvaluationScenario): EvaluationValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!scenario || typeof scenario !== "object")
		return { valid: false, errors: ["scenario must be an object"], warnings };
	if (!ID_PATTERN.test(scenario.scenarioId))
		errors.push("scenarioId must contain only letters, numbers, dot, underscore, or hyphen");
	if (!Number.isInteger(scenario.scenarioVersion) || scenario.scenarioVersion < 1)
		errors.push("scenarioVersion must be a positive integer");
	if (!scenario.title.trim()) errors.push("title is required");
	if (!scenario.task?.prompt?.trim()) errors.push("task.prompt is required");
	if (!Number.isInteger(scenario.repetitions) || scenario.repetitions < 1 || scenario.repetitions > 100)
		errors.push("repetitions must be between 1 and 100");
	if (!Number.isInteger(scenario.timeoutMs) || scenario.timeoutMs < 1) errors.push("timeoutMs must be positive");
	if (scenario.fixture.kind === "local" && !scenario.fixture.root) errors.push("local fixtures require fixture.root");
	if (scenario.fixture.kind === "inline" && !scenario.fixture.files)
		errors.push("inline fixtures require fixture.files");
	if (scenario.fixture.allowExternalSymlinks !== undefined) errors.push("external symlinks are not permitted");
	const assertionIds = new Set<string>();
	for (const assertion of scenario.assertions) {
		if (assertionIds.has(assertion.assertionId)) errors.push(`duplicate assertion id: ${assertion.assertionId}`);
		assertionIds.add(assertion.assertionId);
		if (!ID_PATTERN.test(assertion.assertionId)) errors.push(`invalid assertion id: ${assertion.assertionId}`);
		if (assertion.kind === "command" && !assertion.command)
			errors.push(`command assertion ${assertion.assertionId} requires command`);
	}
	const metricIds = new Set<string>();
	for (const metric of scenario.metrics) {
		if (metricIds.has(metric.metricId)) errors.push(`duplicate metric id: ${metric.metricId}`);
		metricIds.add(metric.metricId);
		if (!ID_PATTERN.test(metric.metricId)) errors.push(`invalid metric id: ${metric.metricId}`);
	}
	if (!scenario.candidatePolicy.allowedModes.length) errors.push("candidatePolicy.allowedModes must not be empty");
	if (scenario.candidatePolicy.allowNetwork && scenario.provenance.classification !== "public")
		warnings.push("network-enabled scenarios should be explicitly classified as public");
	return { valid: errors.length === 0, errors, warnings };
}

export function validatePack(
	pack: EvaluationScenarioPack,
	scenarios: EvaluationScenario[],
): EvaluationValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!pack || typeof pack !== "object") return { valid: false, errors: ["pack must be an object"], warnings: [] };
	if (pack.schemaVersion !== SUPPORTED_SCHEMA_VERSION)
		errors.push(`unsupported pack schema version: ${pack.schemaVersion}`);
	if (!ID_PATTERN.test(pack.packId)) errors.push(`invalid pack id: ${pack.packId}`);
	const seen = new Set<string>();
	for (const scenarioId of pack.scenarios) {
		if (seen.has(scenarioId)) errors.push(`duplicate scenario id in pack: ${scenarioId}`);
		seen.add(scenarioId);
		const scenario = scenarios.find((candidate) => candidate.scenarioId === scenarioId);
		if (!scenario) errors.push(`missing scenario: ${scenarioId}`);
		else {
			const result = validateScenario(scenario);
			errors.push(...result.errors.map((error) => `${scenarioId}: ${error}`));
			warnings.push(...result.warnings.map((warning) => `${scenarioId}: ${warning}`));
		}
	}
	return { valid: errors.length === 0, errors, warnings };
}
