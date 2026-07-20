import { spawnSync } from "child_process";
import { existsSync, type FSWatcher, readFileSync, statSync, watch } from "fs";
import { hostname } from "os";
import { basename, dirname, join, resolve } from "path";

type GitPaths = {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
};

/** Structured worktree entry from git worktree list --porcelain */
export interface WorktreeEntry {
	/** Absolute path to worktree root */
	path: string;
	/** HEAD commit hash */
	head: string;
	/** Branch name, null if detached HEAD */
	branch: string | null;
	/** Whether this worktree is locked */
	locked: boolean;
	/** Lock reason if locked */
	lockReason?: string;
	/** Whether this worktree is prunable */
	prunable: boolean;
}

/** Structured execution environment for agent context */
export interface ExecutionEnvironment {
	host: string;
	os: string;
	/** Login shell from $SHELL or platform default — may differ from the tool shell */
	loginShell: string;
	initialCwd: string;
	effectiveCwd: string;
	/** Git root of the effective working directory, or null */
	gitRoot: string | null;
	/** Git root of the initial working directory, only set when different from gitRoot */
	controllerGitRoot: string | null;
	gitBranch: string | null;
	gitWorktree: string | null;
	worktreeCount: number;
	isDetachedHead: boolean;
}

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
function findGitPaths(): GitPaths | null {
	let dir = process.cwd();
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = resolve(dir, content.slice(8).trim());
						const headPath = join(gitDir, "HEAD");
						if (!existsSync(headPath)) return null;
						const commonDirPath = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonDirPath)
							? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: gitDir;
						return { repoDir: dir, commonGitDir, headPath };
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (!existsSync(headPath)) return null;
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Ask git for the current branch. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGit(repoDir: string): string | null {
	const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const branch = result.status === 0 ? result.stdout.trim() : "";
	return branch || null;
}

/**
 * Parse git worktree list --porcelain output into structured entries.
 * Returns empty array if git is unavailable or the repo has no worktrees.
 */
export function parseWorktreeList(cwd: string): WorktreeEntry[] {
	try {
		const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status !== 0) return [];
		return parseWorktreePorcelain(result.stdout);
	} catch {
		return [];
	}
}

/**
 * Parse porcelain worktree output into structured entries.
 * Format: https://git-scm.com/docs/git-worktree#_porcelain_format
 */
function parseWorktreePorcelain(output: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: Partial<WorktreeEntry> = {};

	for (const line of output.split("\n")) {
		if (line === "") {
			// Empty line = end of entry
			if (current.path && current.head) {
				entries.push({
					path: current.path,
					head: current.head,
					branch: current.branch ?? null,
					locked: current.locked ?? false,
					lockReason: current.lockReason,
					prunable: current.prunable ?? false,
				});
			}
			current = {};
			continue;
		}

		if (line.startsWith("worktree ")) {
			current.path = line.slice(9);
		} else if (line.startsWith("HEAD ")) {
			current.head = line.slice(5);
		} else if (line.startsWith("branch ")) {
			const branchRef = line.slice(7);
			current.branch = branchRef.startsWith("refs/heads/") ? branchRef.slice(11) : branchRef;
		} else if (line.startsWith("detached")) {
			current.branch = null;
		} else if (line.startsWith("locked")) {
			current.locked = true;
			const spaceIdx = line.indexOf(" ", 7);
			if (spaceIdx > 0) {
				current.lockReason = line.slice(spaceIdx + 1);
			}
		} else if (line.startsWith("prunable ")) {
			current.prunable = true;
		}
	}

	return entries;
}

/**
 * Build a concise execution environment summary for the agent prompt.
 *
 * Sources:
 * - os.hostname() for host
 * - process.platform for OS (linux, darwin, win32)
 * - process.env.SHELL or platform default for shell
 * - initialCwd must be captured at session start and passed in
 * - process.cwd() for effective cwd
 * - git rev-parse for repo root
 * - git worktree list for worktree info
 *
 * Never includes secrets, full env vars, or sensitive data.
 */
export function buildExecutionEnvironment(initialCwd: string): ExecutionEnvironment {
	const osPlatform = process.platform;
	const osName = osPlatform === "win32" ? "Windows" : osPlatform === "darwin" ? "macOS" : "Linux";

	const loginShell = process.env.SHELL || (osPlatform === "win32" ? "powershell" : "/bin/sh");

	const effectiveCwd = process.cwd();

	let gitRoot: string | null = null;
	let controllerGitRoot: string | null = null;
	let gitBranch: string | null = null;
	let gitWorktree: string | null = null;
	let worktreeCount = 0;
	let isDetachedHead = false;

	try {
		// Effective repository (where commands actually run)
		const topLevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: effectiveCwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (topLevel.status === 0) {
			gitRoot = topLevel.stdout.trim();
		}

		// Controller repository (where Jensen was started), only if different from effective
		if (initialCwd !== effectiveCwd) {
			const controllerTopLevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
				cwd: initialCwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (controllerTopLevel.status === 0) {
				const candidate = controllerTopLevel.stdout.trim();
				if (candidate !== gitRoot) {
					controllerGitRoot = candidate;
				}
			}
		}

		const branch = spawnSync("git", ["branch", "--show-current"], {
			cwd: effectiveCwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (branch.status === 0) {
			const branchName = branch.stdout.trim();
			gitBranch = branchName || null;
			if (!branchName) isDetachedHead = true;
		}

		if (gitRoot) {
			const worktrees = parseWorktreeList(effectiveCwd);
			worktreeCount = worktrees.length;
			gitWorktree = findCurrentWorktree(effectiveCwd, worktrees);
		}
	} catch {
		// Not a git repo or git unavailable
	}

	return {
		host: hostname(),
		os: osName,
		loginShell,
		initialCwd,
		effectiveCwd,
		gitRoot,
		controllerGitRoot,
		gitBranch,
		gitWorktree,
		worktreeCount,
		isDetachedHead,
	};
}

/**
 * Find which worktree entry corresponds to the current directory.
 */
function findCurrentWorktree(cwd: string, worktrees: WorktreeEntry[]): string | null {
	// Normalize cwd for comparison (no trailing slash)
	const normalizedCwd = cwd.replace(/[/\\]$/, "");
	for (const wt of worktrees) {
		const normalizedPath = wt.path.replace(/[/\\]$/, "");
		if (normalizedCwd === normalizedPath) {
			return wt.path;
		}
	}
	// If no exact match, check if cwd is a subdirectory of a worktree
	for (const wt of worktrees) {
		if (cwd.startsWith(`${wt.path}/`) || cwd.startsWith(`${wt.path}\\`)) {
			return wt.path;
		}
	}
	return null;
}

/**
 * Provides git branch and extension statuses - data not otherwise accessible to extensions.
 * Token stats, model info available via ctx.sessionManager and ctx.model.
 */
export class FooterDataProvider {
	private extensionStatuses = new Map<string, string>();
	private cachedBranch: string | null | undefined = undefined;
	private gitPaths: GitPaths | null | undefined = undefined;
	private headWatcher: FSWatcher | null = null;
	private reftableWatcher: FSWatcher | null = null;
	private branchChangeCallbacks = new Set<() => void>();
	private availableProviderCount = 0;

	constructor() {
		this.gitPaths = findGitPaths();
		this.setupGitWatcher();
	}

	/** Current git branch, null if not in repo, "detached" if detached HEAD */
	getGitBranch(): string | null {
		if (this.cachedBranch === undefined) {
			this.cachedBranch = this.resolveGitBranch();
		}
		return this.cachedBranch;
	}

	/** Repository directory name, null if not in a git repository */
	getGitRepoName(): string | null {
		return this.gitPaths ? basename(this.gitPaths.repoDir) : null;
	}

	/** Extension status texts set via ctx.ui.setStatus() */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/** Subscribe to git branch changes. Returns unsubscribe function. */
	onBranchChange(callback: () => void): () => void {
		this.branchChangeCallbacks.add(callback);
		return () => this.branchChangeCallbacks.delete(callback);
	}

	/** Internal: set extension status */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.extensionStatuses.delete(key);
		} else {
			this.extensionStatuses.set(key, text);
		}
	}

	/** Internal: clear extension statuses */
	clearExtensionStatuses(): void {
		this.extensionStatuses.clear();
	}

	/** Number of unique providers with available models (for footer display) */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	/** Internal: update available provider count */
	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
	}

	/** Internal: cleanup */
	dispose(): void {
		if (this.headWatcher) {
			this.headWatcher.close();
			this.headWatcher = null;
		}
		if (this.reftableWatcher) {
			this.reftableWatcher.close();
			this.reftableWatcher = null;
		}
		this.branchChangeCallbacks.clear();
	}

	private notifyBranchChange(): void {
		for (const cb of this.branchChangeCallbacks) cb();
	}

	private refreshGitBranch(): void {
		const nextBranch = this.resolveGitBranch();
		if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
			this.cachedBranch = nextBranch;
			this.notifyBranchChange();
			return;
		}
		this.cachedBranch = nextBranch;
	}

	private resolveGitBranch(): string | null {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid" ? (resolveBranchWithGit(this.gitPaths.repoDir) ?? "detached") : branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	private setupGitWatcher(): void {
		if (!this.gitPaths) return;

		// Watch the directory containing HEAD, not HEAD itself.
		// Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
		// fs.watch on a file stops working after the inode changes.
		try {
			this.headWatcher = watch(dirname(this.gitPaths.headPath), (_eventType, filename) => {
				if (!filename || filename.toString() === "HEAD") {
					this.refreshGitBranch();
				}
			});
		} catch {
			// Silently fail if we can't watch
		}

		// In reftable repos, branch switches update files in the reftable directory
		// instead of HEAD. Watch it separately so the footer picks up those changes.
		const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
		if (existsSync(reftableDir)) {
			try {
				this.reftableWatcher = watch(reftableDir, () => {
					this.refreshGitBranch();
				});
			} catch {
				// Silently fail if we can't watch
			}
		}
	}
}

/** Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	"getGitBranch" | "getGitRepoName" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange"
>;
