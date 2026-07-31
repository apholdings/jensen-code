export interface LoopGuardResult {
	/** Whether this call should proceed */
	allowed: boolean;
	/** True if we're entering the final blocked range (not yet circuit open) */
	isBlocked?: boolean;
	/** True if circuit is fully open (3rd direct-blocked) */
	circuitOpen?: boolean;
	/** How many consecutive writes have occurred */
	consecutiveWrites: number;
	todoWriteTemporarilyBlocked?: boolean;
	requiredNextAction?: string;
	message?: string;
}

/**
 * Guard against consecutive todo_write calls without real non-todo progress.
 *
 * Circuit breakers:
 * - Consecutive write count resets on non-todo tool success or new user message
 * - After 3 consecutive write calls (regardless of outcome), circuit opens
 * - Circuit opening halts the turn locally
 *
 * Every call that reaches recordWrite() counts toward consecutiveWrites.
 * When blockedCallCount >= 3, the circuit opens and the tool throws
 * REPEATED_TOOL_CALL_LOOP to halt the run immediately.
 */
export class TodoLoopGuard {
	private consecutiveWriteCount = 0;
	private blockedCallCount = 0;

	/**
	 * Record a write attempt to todo_write.
	 * Returns LoopGuardResult indicating whether the call proceeds.
	 */
	recordWrite(_isNoOp: boolean): LoopGuardResult {
		this.consecutiveWriteCount++;

		const result: LoopGuardResult = {
			allowed: true,
			consecutiveWrites: this.consecutiveWriteCount,
		};

		// All calls count toward the circuit breaker
		this.blockedCallCount++;

		if (this.blockedCallCount >= 3) {
			result.circuitOpen = true;
			result.allowed = false;
			result.isBlocked = true;
			result.message =
				"Repeated todo_write attempts detected. All subsequent calls are terminated. Execute the current in-progress task now.";
		}

		return result;
	}

	/**
	 * Reset loop guard after a successful non-todo tool call.
	 */
	resetOnNonTodoToolSuccess(_toolName: string): void {
		this.consecutiveWriteCount = 0;
		this.blockedCallCount = 0;
	}

	/**
	 * Reset loop guard when a new user message arrives.
	 */
	resetOnNewUserMessage(): void {
		this.consecutiveWriteCount = 0;
		this.blockedCallCount = 0;
	}

	/**
	 * Reset loop guard manually.
	 */
	reset(): void {
		this.consecutiveWriteCount = 0;
		this.blockedCallCount = 0;
	}

	getConsecutiveCount(): number {
		return this.consecutiveWriteCount;
	}

	getBlockedCallCount(): number {
		return this.blockedCallCount;
	}

	isCircuitOpen(): boolean {
		return this.blockedCallCount >= 3;
	}
}
