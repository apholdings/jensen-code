import { describe, expect, it } from "vitest";
import { parseResumeCommand } from "./resume-command.js";

describe("parseResumeCommand", () => {
	it("returns none for non-resume commands", () => {
		expect(parseResumeCommand([])).toEqual({ kind: "none" });
		expect(parseResumeCommand(["--help"])).toEqual({ kind: "none" });
		expect(parseResumeCommand(["--continue"])).toEqual({ kind: "none" });
		expect(parseResumeCommand(["config"])).toEqual({ kind: "none" });
	});

	it("parses an explicit session ID", () => {
		expect(parseResumeCommand(["resume", "1234abc-qwer-tyui-09876"])).toEqual({
			kind: "resume",
			sessionId: "1234abc-qwer-tyui-09876",
		});
		expect(parseResumeCommand(["resume", "9ad37e10-243e-4fe6-9d7c-59c2e327aabc"])).toEqual({
			kind: "resume",
			sessionId: "9ad37e10-243e-4fe6-9d7c-59c2e327aabc",
		});
	});

	it("treats the session ID as opaque (no format constraint)", () => {
		expect(parseResumeCommand(["resume", "abc"])).toEqual({ kind: "resume", sessionId: "abc" });
		expect(parseResumeCommand(["resume", "session-A"])).toEqual({ kind: "resume", sessionId: "session-A" });
	});

	it("reports a missing session ID", () => {
		expect(parseResumeCommand(["resume"])).toEqual({ kind: "missing" });
		expect(parseResumeCommand(["resume", "--model", "foo"])).toEqual({ kind: "missing" });
	});

	it("supports resume help", () => {
		expect(parseResumeCommand(["resume", "--help"])).toEqual({ kind: "help" });
		expect(parseResumeCommand(["resume", "-h"])).toEqual({ kind: "help" });
	});

	it("leaves trailing flags out of the resume command so they parse normally", () => {
		expect(parseResumeCommand(["resume", "abc123", "--model", "foo", "hello"])).toEqual({
			kind: "resume",
			sessionId: "abc123",
		});
	});
});
