/**
 * CLI handler for "jensen benchmark" commands.
 */

import chalk from "chalk";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { handleLongHorizonCommand } from "../long-horizon/cli.js";
import { evaluate } from "./evaluator.js";
import { generateJsonReport, generateTextReport } from "./report.js";
import type { LongHorizonBenchmarkManifest, LongHorizonRunReport } from "./types.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export function parseBenchmarkArgs(args: string[]): BenchmarkCommandOptions | undefined {
	if (args[0] !== "benchmark") return undefined;

	const options: BenchmarkCommandOptions = {};
	let i = 1;

	while (i < args.length) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			i++;
		} else if (arg === "--manifest" && i + 1 < args.length) {
			options.manifest = args[++i];
			i++;
		} else if (arg === "--run-report" && i + 1 < args.length) {
			options.runReport = args[++i];
			i++;
		} else if (arg === "--format" && i + 1 < args.length) {
			const fmt = args[++i];
			if (fmt === "text" || fmt === "json") {
				options.format = fmt;
			} else {
				console.error(chalk.red(`Unknown format: ${fmt}. Valid: text, json`));
				process.exitCode = 1;
			}
			i++;
		} else if (arg === "--output" && i + 1 < args.length) {
			options.output = args[++i];
			i++;
		} else if (arg === "long-horizon" || arg === "evaluate") {
			// Positional subcommands - skip
			i++;
		} else if (!arg.startsWith("-")) {
			// Unknown positional arg - ignore (for future commands)
			i++;
		} else {
			console.error(chalk.red(`Unknown option: ${arg}`));
			options.help = true;
			i++;
		}
	}

	return options;
}

export interface BenchmarkCommandOptions {
	help?: boolean;
	manifest?: string;
	runReport?: string;
	format?: "text" | "json";
	output?: string;
}

export function printBenchmarkHelp(): void {
	console.log(`${chalk.bold("Usage:")} jensen benchmark long-horizon evaluate [options]

${chalk.bold("Evaluate a long-horizon benchmark run report against a task manifest.")}

${chalk.bold("Options:")}
  --manifest <path>        Path to benchmark task manifest JSON
  --run-report <path>      Path to run report JSON
  --format <text|json>     Output format (default: text)
  --output <path>          Write output to file instead of stdout
  --help, -h               Show this help

${chalk.bold("Examples:")}
  jensen benchmark long-horizon evaluate --manifest manifest.json --run-report run.json
  jensen benchmark long-horizon evaluate --manifest manifest.json --run-report run.json --format json
  jensen benchmark long-horizon evaluate --manifest manifest.json --run-report run.json --output result.txt

${chalk.bold("Exit Codes:")}
  0   Evaluation completed (benchmark pass/fail in output)
  1   Invalid input or evaluation error
`);
}

export async function handleBenchmarkCommand(args: string[]): Promise<boolean> {
	// Try long-horizon mission/ledger commands first
	const lhResult = await handleLongHorizonCommand(args);
	if (lhResult) return true;

	const options = parseBenchmarkArgs(args);
	if (!options) return false;

	if (options.help) {
		printBenchmarkHelp();
		return true;
	}

	// Validate required args
	if (!options.manifest) {
		console.error(chalk.red("Error: --manifest is required"));
		printBenchmarkHelp();
		process.exitCode = 1;
		return true;
	}
	if (!options.runReport) {
		console.error(chalk.red("Error: --run-report is required"));
		printBenchmarkHelp();
		process.exitCode = 1;
		return true;
	}

	const format = options.format ?? "text";

	// Read and parse manifest
	let manifest: LongHorizonBenchmarkManifest;
	try {
		const raw = readFileSync(options.manifest, "utf-8");
		if (Buffer.byteLength(raw, "utf-8") > MAX_FILE_SIZE) {
			console.error(chalk.red("Error: manifest file exceeds 10MB limit"));
			process.exitCode = 1;
			return true;
		}
		manifest = JSON.parse(raw);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Unknown error";
		console.error(chalk.red(`Error reading manifest: ${message}`));
		process.exitCode = 1;
		return true;
	}

	// Read and parse run report
	let runReport: LongHorizonRunReport;
	try {
		const raw = readFileSync(options.runReport, "utf-8");
		if (Buffer.byteLength(raw, "utf-8") > MAX_FILE_SIZE) {
			console.error(chalk.red("Error: run report file exceeds 10MB limit"));
			process.exitCode = 1;
			return true;
		}
		runReport = JSON.parse(raw);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Unknown error";
		console.error(chalk.red(`Error reading run report: ${message}`));
		process.exitCode = 1;
		return true;
	}

	// Evaluate
	const result = evaluate(manifest, runReport);

	// Schema validation failure: evaluation could not validly execute.
	// The structured report is still emitted, but the process must exit 1.
	if (!result.schemaValidation.valid) {
		process.exitCode = 1;
	}

	// Generate output
	let output: string;
	if (format === "json") {
		output = generateJsonReport(result);
	} else {
		output = generateTextReport(result);
	}

	// Write output
	if (options.output) {
		const outputPath = resolve(options.output);
		// Path traversal check
		if (outputPath.includes("..")) {
			console.error(chalk.red("Error: --output path must not contain '..'"));
			process.exitCode = 1;
			return true;
		}
		try {
			writeFileSync(outputPath, output, "utf-8");
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "Unknown error";
			console.error(chalk.red(`Error writing output: ${message}`));
			process.exitCode = 1;
			return true;
		}
	} else {
		console.log(output);
	}

	// Exit code: 0 for successful evaluation (pass or fail), 1 for errors
	// Benchmark pass/fail is in the output text
	return true;
}
