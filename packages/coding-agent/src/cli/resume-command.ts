/**
 * Parsing for the explicit `jensen resume <SESSION_ID>` command.
 *
 * Kept separate from `main.ts` so the parser can be tested without pulling in
 * the full CLI/agent runtime. Session IDs are treated as opaque strings; this
 * module only decides whether the command was requested and what ID was given.
 */

export type ResumeCommandParse =
	| { kind: "none" }
	| { kind: "help" }
	| { kind: "missing" }
	| { kind: "resume"; sessionId: string };

/**
 * Parse the explicit `resume <SESSION_ID>` command.
 *
 * Pure parsing only; the caller is responsible for emitting help/errors and for
 * stripping the subcommand from the generic argument stream.
 */
export function parseResumeCommand(args: string[]): ResumeCommandParse {
	if (args[0] !== "resume") {
		return { kind: "none" };
	}

	if (args[1] === "--help" || args[1] === "-h") {
		return { kind: "help" };
	}

	const sessionId = args[1];
	if (!sessionId || sessionId.startsWith("-")) {
		return { kind: "missing" };
	}

	return { kind: "resume", sessionId };
}
