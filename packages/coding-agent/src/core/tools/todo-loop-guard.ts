export interface LoopGuardResult {
	blocked: boolean;
	loopGuardTriggered?: boolean;
	todoWriteTemporarilyBlocked?: boolean;
	requiredNextAction?: string;
	message?: string;
}

/**
 * Guard against consecutive todo_write calls without real non-todo progress.
 */
export class TodoLoopGuard {
	private consecutiveWriteCount = 0;
	private isBlocked = false;

	/**
	 * Record a write attempt to todo_write.
	 * Returns LoopGuardResult indicating whether the call is blocked.
	 */
	recordWrite(_isNoOp: boolean): LoopGuardResult {
		if (this.isBlocked) {
			return {
				blocked: true,
				loopGuardTriggered: true,
				todoWriteTemporarilyBlocked: true,
				requiredNextAction: "execute a non-todo tool or return a useful response",
				message:
					"Todo loop guard triggered. Do not update the plan again. Execute the current in-progress task now.",
			};
		}

		this.consecutiveWriteCount++;

		if (this.consecutiveWriteCount >= 3) {
			this.isBlocked = true;
			return {
				blocked: true,
				loopGuardTriggered: true,
				todoWriteTemporarilyBlocked: true,
				requiredNextAction: "execute a non-todo tool or return a useful response",
				message:
					"Todo loop guard triggered. Do not update the plan again. Execute the current in-progress task now.",
			};
		}

		return { blocked: false };
	}

	/**
	 * Reset loop guard after a successful non-todo tool call.
	 */
	resetOnNonTodoToolSuccess(_toolName: string): void {
		this.consecutiveWriteCount = 0;
		this.isBlocked = false;
	}

	/**
	 * Reset loop guard when a new user message arrives.
	 */
	resetOnNewUserMessage(): void {
		this.consecutiveWriteCount = 0;
		this.isBlocked = false;
	}

	/**
	 * Reset loop guard manually.
	 */
	reset(): void {
		this.consecutiveWriteCount = 0;
		this.isBlocked = false;
	}

	getConsecutiveCount(): number {
		return this.consecutiveWriteCount;
	}

	isGuardActive(): boolean {
		return this.isBlocked;
	}
}
