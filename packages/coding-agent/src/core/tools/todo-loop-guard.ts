/**
 * Guard against duplicate todo_write calls within a single user turn.
 *
 * - The first write after the per-turn lock is active is blocked and returns a
 *   paired TODO_WRITE_ALREADY_APPLIED rejection result.
 * - The second equivalent duplicate terminates the active agent run locally with
 *   REPEATED_TOOL_CALL_LOOP. The tool layer throws for this case.
 *
 * Counts reset on non-todo tool success or a new user message.
 */
export class TodoLoopGuard {
	private duplicateRejectionCount = 0;

	/**
	 * Record a todo_write attempt that was already rejected by the per-turn lock.
	 * Returns whether the call may return a rejection result (first duplicate)
	 * or must terminate the run (second equivalent duplicate).
	 */
	recordDuplicate(): boolean {
		this.duplicateRejectionCount++;
		return this.duplicateRejectionCount <= 1;
	}

	/**
	 * Reset loop guard after a successful non-todo tool call.
	 */
	resetOnNonTodoToolSuccess(_toolName: string): void {
		this.duplicateRejectionCount = 0;
	}

	/**
	 * Reset loop guard when a new user message arrives.
	 */
	resetOnNewUserMessage(): void {
		this.duplicateRejectionCount = 0;
	}

	/**
	 * Reset loop guard manually.
	 */
	reset(): void {
		this.duplicateRejectionCount = 0;
	}

	getDuplicateRejectionCount(): number {
		return this.duplicateRejectionCount;
	}

	isDuplicateLoop(): boolean {
		return this.duplicateRejectionCount >= 2;
	}
}
