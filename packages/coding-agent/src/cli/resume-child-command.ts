/**
 * Parsing for the explicit `resume-child <MISSION_ID>` command.
 *
 * Resumes an INTERRUPTED durable child mission as the same mission + same
 * durable child AgentSession with a NEW execution attempt. Purely parsing;
 * the caller performs store/session resolution and drives the coordinator.
 */

export type ResumeChildCommandParse =
	| { kind: "none" }
	| { kind: "help" }
	| { kind: "missing" }
	| { kind: "resume"; missionId: string };

export function parseResumeChildCommand(args: string[]): ResumeChildCommandParse {
	if (args[0] !== "resume-child") {
		return { kind: "none" };
	}

	if (args[1] === "--help" || args[1] === "-h") {
		return { kind: "help" };
	}

	const missionId = args[1];
	if (!missionId || missionId.startsWith("-")) {
		return { kind: "missing" };
	}

	return { kind: "resume", missionId };
}
