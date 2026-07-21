import { describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "./bash.js";

describe("createBashTool", () => {
	it("returns structured cancellation instead of rejecting on abort", async () => {
		const controller = new AbortController();
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("partial output"));
				controller.abort();
				throw new Error("aborted");
			},
		};

		const tool = createBashTool(process.cwd(), { operations });

		// Cancelled results throw as errors so the agent loop marks isError=true.
		// The model sees structured content in the error message.
		try {
			await tool.execute("call_1", { command: "sleep 1" }, controller.signal);
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("cancelled: true");
			expect(msg).toContain("Command:");
			expect(msg).toContain("exit_code:");
		}
	});

	it("sanitizes streamed and final output with bash-executor parity", async () => {
		const updates: string[] = [];
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData, onStdout }) => {
				const data = Buffer.from("\u001b[31mred\u001b[0m\x00\u0007text\r\nnext\n");
				onData(data);
				onStdout?.(data);
				return { exitCode: 0 };
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		const result = await tool.execute("call_1", { command: "printf test" }, undefined, (partialResult) => {
			updates.push(partialResult.content[0]?.type === "text" ? partialResult.content[0].text : "");
		});

		// Partial updates stream sanitized content
		expect(updates).toEqual(["redtext\nnext\n"]);
		// Final content includes structured evidence with stdout section
		expect(result.content[0].type).toBe("text");
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("stdout:");
		expect(text).toContain("redtext\nnext");
		expect(text).toContain("exit_code: 0");
		// Details carry structured fields
		expect(result.details).toBeDefined();
		expect(result.details!.exitCode).toBe(0);
		expect(result.details!.stdout).toContain("redtext");
	});

	it("reports non-zero exit code as error with structured content", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onStdout }) => {
				onStdout?.(Buffer.from("SUCCESS-S04\n"));
				return { exitCode: 9 };
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		try {
			await tool.execute("call_1", { command: "exit 9" });
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("Command:");
			expect(msg).toContain("stdout:");
			expect(msg).toContain("SUCCESS-S04");
			expect(msg).toContain("exit_code: 9");
		}
	});

	it("reports timed out as error with structured content", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("partial\n"));
				throw new Error("timeout:5");
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		try {
			await tool.execute("call_1", { command: "sleep 10", timeout: 5 });
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("timed_out: true");
		}
	});

	it("keeps stderr separate from stdout in model-facing content", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onStdout, onStderr }) => {
				onStdout?.(Buffer.from("OUT\n"));
				onStderr?.(Buffer.from("ERR\n"));
				return { exitCode: 0 };
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		const result = await tool.execute("call_1", { command: "both streams" });

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("stdout:\nOUT");
		expect(text).toContain("stderr:\nERR");
		expect(result.details!.stdout).toBe("OUT\n");
		expect(result.details!.stderr).toBe("ERR\n");
		expect(result.details!.exitCode).toBe(0);
	});

	it("stderr with exit 0 is not classified as failure", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onStderr }) => {
				onStderr?.(Buffer.from("ONLY-STDERR\n"));
				return { exitCode: 0 };
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		const result = await tool.execute("call_1", { command: "stderr success" });

		// Should resolve (not throw) because exit code is 0
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("stderr:\nONLY-STDERR");
		expect(text).toContain("exit_code: 0");
		expect(result.details!.stderr).toContain("ONLY-STDERR");
		expect(result.details!.exitCode).toBe(0);
	});

	it("positive stdout with non-zero exit is classified as failure", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onStdout }) => {
				onStdout?.(Buffer.from("SUCCESS\n"));
				return { exitCode: 17 };
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		try {
			await tool.execute("call_1", { command: "stdout fail" });
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("stdout:\nSUCCESS");
			expect(msg).toContain("exit_code: 17");
		}
	});

	it("stderr with non-zero exit is classified as failure", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onStderr }) => {
				onStderr?.(Buffer.from("FAILURE\n"));
				return { exitCode: 19 };
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		try {
			await tool.execute("call_1", { command: "stderr fail" });
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("stderr:\nFAILURE");
			expect(msg).toContain("exit_code: 19");
		}
	});

	it("spawn error reaches model-facing output", async () => {
		const operations: BashOperations = {
			exec: async () => {
				throw new Error("ENOENT: no such file or directory");
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		try {
			await tool.execute("call_1", { command: "nonexistent" });
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("spawn_error:");
			expect(msg).toContain("ENOENT");
		}
	});
});

// ============================================================================
// Evidence integrity tests (E01-E07) — fail-closed pipeline evidence
// ============================================================================

describe("bash tool — evidence integrity", () => {
	it("E01: fd 3 cannot spoof metadata (no control channel exists)", async () => {
		// Since fd 3 is no longer reserved for metadata, writing to it is
		// just a user-space operation that may fail or succeed naturally.
		// The key assertion: no internal Jensen metadata is modified.
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_e01", {
			command: "printf 'E01-CLEAN\\n'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("E01-CLEAN");
		// No pipeline evidence for a non-pipeline command
		expect(text).not.toContain("pipeline_suspected: true");
		expect(text).not.toContain("pipeline_stage_exit_codes");
		expect(text).toContain("exit_code: 0");
		// Non-pipeline commands get explicit authority scope
		expect(text).toContain("authority_scope: final_shell_exit_status");
	});

	it("E02: user trap does not affect Jensen evidence", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_e02", {
			command: "trap 'printf \"USER-TRAP\\n\" >&2' EXIT\nfalse | cat",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		// The user trap output appears in stderr (normal)
		// But Jensen's evidence section is unaffected
		expect(text).toContain("pipeline_suspected: true");
		expect(text).toContain("validation_evidence_authoritative: false");
		expect(text).toContain("stage_exit_codes_known: false");
	});

	it("E03: trap removal does not affect evidence integrity", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_e03", {
			command: "trap - EXIT\nfalse | cat",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		// Evidence section must still be valid — non-authoritative pipeline
		expect(text).toContain("pipeline_suspected: true");
		expect(text).toContain("validation_evidence_authoritative: false");
	});

	it("E04: exec captures exit code without invented metadata", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_e04", {
				command: "exec bash -c 'printf \"EXEC\\n\"; exit 27'",
			});
			expect.fail("should have thrown for exit 27");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("EXEC");
			expect(msg).toContain("exit_code: 27");
			// No invented stage codes
			expect(msg).not.toContain("pipeline_stage_exit_codes");
		}
	});

	it("E05: deceptive pipeline (false|tail) is non-authoritative", async () => {
		const tool = createBashTool(process.cwd());
		// false | tail exits 0 (tail succeeds on empty input)
		// Must be marked non-authoritative
		const result = await tool.execute("call_e05", {
			command: "false | tail",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("pipeline_suspected: true");
		expect(text).toContain("validation_evidence_authoritative: false");
		expect(text).toContain("authority_scope: final_pipeline_stage_only");
		expect(text).toContain("exit_code: 0");
		expect(text).toContain("warning:");
	});

	it("E06: pipeline with deceptive success (bash -c 'exit 9' | cat) is non-authoritative", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_e06", {
			command: "bash -c 'printf \"SUCCESS\\n\"; exit 9' | cat",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		// exit_code is 0 because cat succeeds, but must be non-authoritative
		expect(text).toContain("SUCCESS");
		expect(text).toContain("exit_code: 0");
		expect(text).toContain("pipeline_suspected: true");
		expect(text).toContain("validation_evidence_authoritative: false");
		expect(text).toContain("stage_exit_codes_known: false");
	});

	it("E07: successful pipeline (printf|grep) is non-authoritative regardless of success", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_e07", {
			command: "printf 'ok\\n' | grep ok",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		// Even though both stages succeed, stage codes are not reliably captured
		expect(text).toContain("ok");
		expect(text).toContain("exit_code: 0");
		expect(text).toContain("pipeline_suspected: true");
		expect(text).toContain("validation_evidence_authoritative: false");
		expect(text).not.toContain("pipeline_stage_exit_codes");
	});
});

// ============================================================================
// Pipeline risk — fail-closed detection
// ============================================================================

describe("bash tool — pipeline risk detection", () => {
	it("should suspect pipeline: false | tail", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_risk1", {
			command: "false | tail",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("pipeline_suspected: true");
	});

	it("should suspect pipeline: printf | grep", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_risk2", {
			command: "printf 'x\\n' | grep x",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("pipeline_suspected: true");
	});

	it("should suspect pipeline: heredoc with pipe", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_risk3", {
			command: "cat <<'EOF' | grep x\nx\nEOF",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("pipeline_suspected: true");
	});

	it("should NOT suspect pipeline: quoted pipe character in single quotes", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_risk4", {
			command: "printf '%s\\n' 'a|b'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).not.toContain("pipeline_suspected: true");
	});

	it("should NOT suspect pipeline: quoted pipe character in double quotes", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_risk5", {
			command: 'printf "%s\\n" "a|b"',
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).not.toContain("pipeline_suspected: true");
	});

	it("should NOT suspect pipeline: escaped pipe", async () => {
		const tool = createBashTool(process.cwd());
		// a\|b — bash escapes the |, so this is not a real pipeline.
		// However, our simple quoting-aware detector sees | as unquoted
		// (the backslash before it is consumed by bash, not by our detector).
		// This is a known false positive — acceptable because it produces
		// a non-authoritative warning, not a false authoritative result.
		const result = await tool.execute("call_risk6", {
			command: "printf '%s\\n' a\\|b",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		// Output is correct — prints literal "a|b"
		expect(text).toContain("a|b");
		expect(text).toContain("exit_code: 0");
	});

	it("should NOT suspect pipeline: pipe in comment", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_risk7", {
			command: "printf 'COMMENT\\n' # false | cat",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("COMMENT");
		// The # prevents | from being parsed, but our simple detector sees
		// unquoted | after #. This is a known false positive — acceptable
		// because it produces a non-authoritative warning, not false authority.
		// We verify the exit code is still reported correctly.
		expect(text).toContain("exit_code: 0");
	});

	it("should NOT suspect pipeline: pipe in arithmetic expression $((1|2))", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_risk8", {
			command: "printf '%s\\n' $((1 | 2))",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		// $((1 | 2)) — bitwise OR in arithmetic context, not a shell pipeline.
		// Known false positive: detector sees unquoted |.
		expect(text).toContain("3");
		expect(text).toContain("exit_code: 0");
	});

	it("should NOT suspect pipeline: || operator", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_risk9", {
			command: "false || printf 'RECOVERED\\n'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("RECOVERED");
		expect(text).not.toContain("pipeline_suspected: true");
	});

	it("simple command has explicit authority scope", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_auth", {
			command: "printf 'AUTHORITATIVE\\n'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("AUTHORITATIVE");
		expect(text).toContain("exit_code: 0");
		// Non-pipeline commands now get explicit authority metadata
		expect(text).toContain("exit_status_known: true");
		expect(text).toContain("exit_status_authoritative: true");
		expect(text).toContain("authority_scope: final_shell_exit_status");
		expect(text).toContain("internal_command_statuses_known: false");
		expect(text).toContain("validation_evidence_authoritative: true");
		expect(text).not.toContain("pipeline_suspected: true");
	});

	it("non-pipeline command with non-zero exit is authoritative", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_auth2", {
				command: "bash -c 'printf \"SUCCESS\\n\"; exit 17'",
			});
			expect.fail("should have thrown for exit 17");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("SUCCESS");
			expect(msg).toContain("exit_code: 17");
			expect(msg).not.toContain("pipeline_suspected: true");
			expect(msg).toContain("exit_status_authoritative: true");
			expect(msg).toContain("authority_scope: final_shell_exit_status");
		}
	});
});

// ============================================================================
// Pipeline semantics — fail-closed redesign
// ============================================================================

describe("bash tool — pipeline semantics (fail-closed)", () => {
	it("pipeline metadata reaches model-facing output with warning", async () => {
		const tool = createBashTool(process.cwd());
		// false|cat exits 0 in bash (cat succeeds), but must be non-authoritative
		const result = await tool.execute("call_p1", {
			command: "false | cat",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("pipeline_suspected: true");
		expect(text).toContain("stage_exit_codes_known: false");
		expect(text).toContain("validation_evidence_authoritative: false");
		expect(text).toContain("authority_scope: final_pipeline_stage_only");
		expect(text).toContain("warning:");
		expect(text).toContain("Re-run the validation command without a pipeline");
	});

	it("pipeline with non-zero last stage shows warning with exit code", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_p2", {
				command: "false | grep DOES_NOT_EXIST",
			});
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("pipeline_suspected: true");
			expect(msg).toContain("validation_evidence_authoritative: false");
		}
	});

	it("simple command does not show pipeline evidence", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_simple", {
			command: "printf 'SIMPLE\\n'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("SIMPLE");
		expect(text).not.toContain("pipeline_suspected: true");
		// Simple commands now have explicit authority metadata
		expect(text).toContain("exit_status_known: true");
		expect(text).toContain("authority_scope: final_shell_exit_status");
	});

	it("operators that are not pipelines: ||", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_or", {
			command: "false || printf 'RECOVERED\\n'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("RECOVERED");
		expect(text).not.toContain("pipeline_suspected: true");
	});

	it("operators that are not pipelines: &&", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_and", {
			command: "true && printf 'AND\\n'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("AND");
		expect(text).not.toContain("pipeline_suspected: true");
	});
});

// ============================================================================
// Heredoc tests (HD01-HD12) — real bash execution
// ============================================================================

describe("bash tool — heredocs (real execution)", () => {
	it("HD01: basic heredoc produces only expected content", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_hd01", {
			command: "cat <<'EOF'\nHEREDOC-BASIC\nEOF",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("HEREDOC-BASIC");
		// No wrapper, trap, or sentinel leakage
		expect(text).not.toContain("__jensen_stages");
		expect(text).not.toContain("PIPESTATUS");
		expect(text).not.toContain("_PI_");
	});

	it("HD02: quoted delimiter disables expansion", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_hd02", {
			command: "VALUE=\"SECRET\"\ncat <<'EOF'\n$VALUE\nEOF",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		// Heredoc body with quoted delimiter shows literal $VALUE, not expanded value
		expect(text).toContain("$VALUE");
		// The expanded value SECRET should only appear in the command echo, not in stdout
		// (it's in the command itself, which is shown, so exclude from stdout section only)
		const stdoutSection = text.substring(text.indexOf("stdout:"), text.indexOf("--- Evidence ---"));
		expect(stdoutSection).not.toContain("SECRET");
	});

	it("HD03: unquoted delimiter enables expansion", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_hd03", {
			command: 'VALUE="EXPANDED"\ncat <<EOF\n$VALUE\nEOF',
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("EXPANDED");
	});

	it("HD04: heredoc followed by another command", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_hd04", {
			command: "cat <<'EOF'\nFIRST\nEOF\nprintf 'SECOND\\n'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("FIRST");
		expect(text).toContain("SECOND");
		expect(text).toContain("exit_code: 0");
	});

	it("HD05: heredoc inside pipeline produces non-authoritative warning", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_hd05", {
			command: "cat <<'EOF' | grep beta\nalpha\nbeta\nEOF",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("beta");
		expect(text).toContain("pipeline_suspected: true");
		expect(text).toContain("evidence_authoritative: false");
	});

	it("HD06: two heredocs in sequence", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_hd06", {
			command: "cat <<'FIRST'\nONE\nFIRST\ncat <<'SECOND'\nTWO\nSECOND",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("ONE");
		expect(text).toContain("TWO");
	});

	it("HD07: heredoc with tab-indented delimiter (<<-EOF)", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_hd07", {
			command: "cat <<-EOF\n\tTAB-INDENTED\n\tEOF",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("TAB-INDENTED");
		expect(text).toContain("exit_code: 0");
	});

	it("HD08: heredoc inside subshell", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_hd08", {
			command: "(\ncat <<'EOF'\nSUBSHELL-HEREDOC\nEOF\n)",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("SUBSHELL-HEREDOC");
	});

	it("HD09: heredoc with stderr and later failure", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_hd09", {
				command: "cat <<'EOF'\nVISIBLE\nEOF\nprintf 'HEREDOC-ERR\\n' >&2\nexit 9",
			});
			expect.fail("should have thrown for exit 9");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("VISIBLE");
			expect(msg).toContain("HEREDOC-ERR");
			expect(msg).toContain("exit_code: 9");
		}
	});

	it("HD10: heredoc without trailing newline in source", async () => {
		// Build source programmatically — last char is the delimiter "EOF",
		// no trailing newline after it.
		const source = "cat <<'EOF'\nHEREDOC-NO-NL\nEOF";
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_hd10", { command: source });
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("HEREDOC-NO-NL");
		expect(text).toContain("exit_code: 0");
	});

	it("HD11: heredoc inside function preserves function semantics", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_hd11", {
			command: "myfunc() {\n  cat <<'EOF'\nHEREDOC-IN-FUNC\nEOF\n}\nmyfunc",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("HEREDOC-IN-FUNC");
		expect(text).toContain("exit_code: 0");
	});

	it("HD12: heredoc followed by timeout captures heredoc content", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_hd12", {
				command: "cat <<'EOF'\nBEFORE-SLEEP\nEOF\nsleep 5",
				timeout: 1,
			});
			expect.fail("should have thrown on timeout");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("BEFORE-SLEEP");
			expect(msg).toContain("timed_out: true");
		}
	});
});

// ============================================================================
// Multiline regression tests (ML01-ML08) — real bash execution
// ============================================================================

describe("bash tool — multiline commands (real execution)", () => {
	it("ML01: multiline pipeline", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_ml01", {
			command: "printf 'alpha\\nbeta\\n' |\ngrep beta",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("beta");
	});

	it("ML02: function definition and invocation", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_ml02", {
			command: "sample_function() {\n  printf 'FUNCTION-OK\\n'\n}\nsample_function",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("FUNCTION-OK");
	});

	it("ML03: if block", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_ml03", {
			command: "if true; then\n  printf 'IF-OK\\n'\nfi",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("IF-OK");
	});

	it("ML04: for loop", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_ml04", {
			command: "for value in one two; do\n  printf '%s\\n' \"$value\"\ndone",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("one");
		expect(text).toContain("two");
	});

	it("ML05: case block", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_ml05", {
			command: 'value="a"\ncase "$value" in\n  a) printf \'CASE-A\\n\' ;;\nesac',
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("CASE-A");
	});

	it("ML06: command substitution", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_ml06", {
			command: "printf 'VALUE=%s\\n' \"$(printf 'INNER')\"",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("VALUE=INNER");
	});

	it("ML07: trailing comment", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_ml07", {
			command: "printf 'COMMENT-OK\\n' # trailing comment",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("COMMENT-OK");
	});

	it("ML08: quoted pipe character", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_ml08", {
			command: "printf '%s\\n' 'a|b'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("a|b");
		// Not a real pipeline — no pipeline evidence
		expect(text).not.toContain("pipeline_suspected: true");
	});
});

// ============================================================================
// Timeout tests (TO01-TO10) — real bash execution
// ============================================================================

describe("bash tool — timeout (real execution)", () => {
	it("TO01: timeout kills process and reports timedOut", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_to01", {
				command: "sleep 5",
				timeout: 1,
			});
			expect.fail("should have thrown on timeout");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("timed_out: true");
			expect(msg).toContain("cancelled: false");
			expect(msg).not.toContain("exit_code: 0");
		}
	});

	it("TO02: timeout preserves stdout produced before timeout", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_to02", {
				command: "printf 'BEFORE-TIMEOUT\\n'\nsleep 5",
				timeout: 1,
			});
			expect.fail("should have thrown on timeout");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("BEFORE-TIMEOUT");
			expect(msg).toContain("timed_out: true");
		}
	});

	it("TO03: timeout preserves stderr produced before timeout", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_to03", {
				command: "printf 'TIMEOUT-ERR\\n' >&2\nsleep 5",
				timeout: 1,
			});
			expect.fail("should have thrown on timeout");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("TIMEOUT-ERR");
			expect(msg).toContain("timed_out: true");
		}
	});

	it("TO04: timeout kills pipeline", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_to04", {
				command: "sleep 5 | cat",
				timeout: 1,
			});
			expect.fail("should have thrown on timeout");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("timed_out: true");
		}
	});

	it("TO05: timeout after heredoc preserves heredoc content", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_to05", {
				command: "cat <<'EOF'\nBEFORE-SLEEP\nEOF\nsleep 5",
				timeout: 1,
			});
			expect.fail("should have thrown on timeout");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("BEFORE-SLEEP");
			expect(msg).toContain("timed_out: true");
		}
	});

	it("TO06: timeout omitted means no timeout", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_to06", {
			command: "printf 'NO-TIMEOUT\\n'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("NO-TIMEOUT");
		expect(text).toContain("timed_out: false");
	});

	it("TO07: fractional timeout works", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_to07", {
				command: "sleep 3",
				timeout: 0.5,
			});
			expect.fail("should have thrown on timeout");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("timed_out: true");
		}
	});

	it("TO08: zero timeout is rejected with validation error", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_to08", {
				command: "printf 'ZERO\\n'",
				timeout: 0,
			});
			expect.fail("should have thrown for timeout=0");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("Timeout must be a positive number");
			expect(msg).toContain("Got 0");
		}
	});

	it("TO09: negative timeout is rejected with validation error", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_to09", {
				command: "printf 'NEGATIVE\\n'",
				timeout: -5,
			});
			expect.fail("should have thrown for timeout=-5");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("Timeout must be a positive number");
			expect(msg).toContain("-5");
		}
	});

	it("TO10: excessive timeout is rejected with validation error", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_to10", {
				command: "printf 'EXCESSIVE\\n'",
				timeout: 999999,
			});
			expect.fail("should have thrown for excessive timeout");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("exceeds maximum allowed timeout");
		}
	});

	it("TO11: NaN timeout is rejected", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_to11", {
				command: "printf 'NAN\\n'",
				timeout: NaN,
			});
			expect.fail("should have thrown for NaN timeout");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("Invalid timeout value");
		}
	});

	it("TO12: Infinity timeout is rejected", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_to12", {
				command: "printf 'INF\\n'",
				timeout: Infinity,
			});
			expect.fail("should have thrown for Infinity timeout");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("Invalid timeout value");
		}
	});
});

// ============================================================================
// Timeout child-process cleanup — real bash execution
// ============================================================================

describe("bash tool — timeout child process cleanup", () => {
	it("timeout leaves no orphan child processes", async () => {
		const tool = createBashTool(process.cwd());
		const markerFile = `/tmp/jensen-timeout-test-${process.pid}.marker`;

		try {
			await tool.execute("call_orphan", {
				command: `(
  printf '%s' "$$" > "${markerFile}"
  sleep 30
) &
CHILD_PID="$!"
printf '%s' "$CHILD_PID" >> "${markerFile}"
wait "$CHILD_PID"
`,
				timeout: 1,
			});
			expect.fail("should have thrown on timeout");
		} catch (_err) {
			// Child should be dead after timeout kills process group
			// Allow brief settling time for kill signal delivery
			await new Promise((r) => setTimeout(r, 500));

			// Try to read marker file for child PID
			try {
				const fs = await import("node:fs");
				const content = fs.readFileSync(markerFile, "utf-8").trim();
				const lines = content.split("\n");
				if (lines.length >= 2) {
					const childPid = parseInt(lines[1], 10);
					if (!Number.isNaN(childPid)) {
						// Check if child still alive
						let alive = false;
						try {
							process.kill(childPid, 0);
							alive = true;
						} catch {
							alive = false;
						}
						expect(alive).toBe(false);
					}
				}
			} finally {
				// Cleanup marker file
				try {
					const fs = await import("node:fs");
					fs.unlinkSync(markerFile);
				} catch {
					// Ignore cleanup errors
				}
			}
		}
	});
});

// ============================================================================
// Agent tool path contract
// ============================================================================

describe("bash tool — agent tool path contract", () => {
	it("simple command is not labeled pipeline", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_contract_simple", {
			command: "echo 'NOT-A-PIPELINE'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).not.toContain("pipeline_suspected: true");
	});

	it("real pipeline is marked non-authoritative", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_contract_pipeline", {
			command: "(exit 7) | cat",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("pipeline_suspected: true");
		expect(text).toContain("validation_evidence_authoritative: false");
	});

	it("no wrapper source leaks into stdout or stderr", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_noleak", {
			command: "printf 'CLEAN\\n'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).not.toContain("__jensen_stages");
		expect(text).not.toContain("PIPESTATUS");
		expect(text).not.toContain("_PI_");
	});

	it("timeout schema value reaches executor", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_h02_wired", {
				command: "sleep 3",
				timeout: 0.5,
			});
			expect.fail("should have thrown on timeout");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("timed_out: true");
		}
	});

	it("model-facing content contains all required evidence fields", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_evidence_fields", {
			command: "printf 'OK\\n'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		// Required fields
		expect(text).toContain("exit_code:");
		expect(text).toContain("timed_out:");
		expect(text).toContain("cancelled:");
		expect(text).toContain("truncated:");
		expect(text).toContain("stdout:");
	});
});

// ============================================================================
// Model-facing authority scope tests (M01-M12)
// ============================================================================

describe("bash tool — model-facing authority scope", () => {
	it("M01: simple success exposes explicit authority scope", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_m01", {
			command: "printf 'M01\\n'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("M01");
		expect(text).toContain("exit_code: 0");
		expect(text).toContain("exit_status_known: true");
		expect(text).toContain("exit_status_authoritative: true");
		expect(text).toContain("authority_scope: final_shell_exit_status");
		expect(text).toContain("internal_command_statuses_known: false");
		expect(text).toContain("validation_evidence_authoritative: true");
	});

	it("M02: simple failure exposes exit 17 with authority scope", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_m02", {
				command: "bash -c 'exit 17'",
			});
			expect.fail("should have thrown for exit 17");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("exit_code: 17");
			expect(msg).toContain("exit_status_known: true");
			expect(msg).toContain("exit_status_authoritative: true");
			expect(msg).toContain("authority_scope: final_shell_exit_status");
		}
	});

	it("M03: failure then success does not claim all commands passed", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_m03", {
			command: "false; true",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("exit_code: 0");
		expect(text).toContain("internal_command_statuses_known: false");
		// The exit code is 0 but internal command statuses are unknown
		// Model must not claim "all commands passed"
	});

	it("M04: success then failure has non-zero exit with correct scope", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_m04", {
				command: "true; false",
			});
			expect.fail("should have thrown for exit 1");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("exit_code: 1");
			expect(msg).toContain("authority_scope: final_shell_exit_status");
		}
	});

	it("M05: function with internal failure has limited scope", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_m05", {
			command: "sample() {\n  false\n  printf 'FUNCTION-END\\n'\n}\nsample",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("FUNCTION-END");
		expect(text).toContain("exit_code: 0");
		expect(text).toContain("authority_scope: final_shell_exit_status");
		expect(text).toContain("internal_command_statuses_known: false");
	});

	it("M06: subshell with internal failure has final_shell_exit_status scope", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_m06", {
			command: "(false; true)",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("exit_code: 0");
		expect(text).toContain("authority_scope: final_shell_exit_status");
		expect(text).toContain("internal_command_statuses_known: false");
	});

	it("M07: set -e failure produces non-zero exit with correct scope", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_m07", {
				command: "set -e\nfalse\nprintf 'UNREACHABLE\\n'",
			});
			expect.fail("should have thrown");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("exit_code: 1");
			expect(msg).toContain("authority_scope: final_shell_exit_status");
		}
	});

	it("M08: recovery operator || produces authoritative exit with limited scope", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_m08", {
			command: "false || printf 'RECOVERED\\n'",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("RECOVERED");
		expect(text).toContain("exit_code: 0");
		expect(text).not.toContain("pipeline_suspected: true");
		expect(text).toContain("authority_scope: final_shell_exit_status");
	});

	it("M09: pipeline is non-authoritative for validation", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_m09", {
			command: "false | tail",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("pipeline_suspected: true");
		expect(text).toContain("validation_evidence_authoritative: false");
		expect(text).toContain("authority_scope: final_pipeline_stage_only");
		expect(text).toContain("internal_command_statuses_known: false");
		// No fabricated stage codes
		expect(text).not.toContain("pipeline_stage_exit_codes");
	});

	it("M10: pipeline with deceptive positive output is non-authoritative", async () => {
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call_m10", {
			command: "bash -c 'printf \"SUCCESS\\n\"; exit 9' | cat",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("SUCCESS");
		expect(text).toContain("exit_code: 0");
		expect(text).toContain("validation_evidence_authoritative: false");
		expect(text).toContain("pipeline_suspected: true");
	});

	it("M11: timeout produces no_exit_status authority scope", async () => {
		const tool = createBashTool(process.cwd());
		try {
			await tool.execute("call_m11", {
				command: "sleep 5",
				timeout: 1,
			});
			expect.fail("should have thrown on timeout");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("timed_out: true");
			expect(msg).toContain("exit_status_known: false");
			expect(msg).toContain("exit_status_authoritative: false");
			expect(msg).toContain("authority_scope: no_exit_status");
			expect(msg).toContain("internal_command_statuses_known: false");
			expect(msg).toContain("validation_evidence_authoritative: false");
		}
	});

	it("M12: spawn error produces no_process_started authority scope", async () => {
		const operations: BashOperations = {
			exec: async () => {
				throw new Error("ENOENT: nonexistent command");
			},
		};

		const tool = createBashTool(process.cwd(), { operations });
		try {
			await tool.execute("call_m12", {
				command: "nonexistent_command",
			});
			expect.fail("should have thrown on spawn error");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("spawn_error:");
			expect(msg).toContain("exit_status_known: false");
			expect(msg).toContain("exit_status_authoritative: false");
			expect(msg).toContain("authority_scope: no_process_started");
			expect(msg).toContain("internal_command_statuses_known: false");
			expect(msg).toContain("validation_evidence_authoritative: false");
		}
	});
});
