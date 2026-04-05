/**
 * Rich LLM-facing tool prompts.
 * Returns detailed instructions for each tool, covering usage, parameters, and best practices.
 */

const TOOL_PROMPTS: Record<string, string> = {
	/**
	 * Read tool - file content reading
	 */
	read: `Read file contents.

Usage: Use this tool to read files from the filesystem.

When to use:
- ALWAYS use read instead of \`cat\`, \`head\`, \`tail\`, or \`sed\` to display file contents
- You MUST read a file before editing it
- Read configuration files, source code, documentation, and any text-based files
- Use before modifying any file to understand its current state

Parameters:
- path: Relative or absolute path to the file
- offset: Line number to start reading from (1-indexed), optional
- limit: Maximum number of lines to read, optional

Behavior:
- Returns file contents up to the limits specified
- For large files, use offset and limit to read in chunks
- Binary files (images, executables, etc.) are not readable - will return an error
- Respects the working directory configured for the tool

Best practices:
- Always read before editing to understand the exact content
- Use offset/limit for large files instead of shell commands like head/tail
- Read files completely when you need to understand the full context`,

	/**
	 * Bash tool - command execution
	 */
	bash: `Execute bash commands in the terminal.

Usage: Run shell commands for operations not covered by specialized tools.

When to use:
- Git operations (commit, push, pull, branch management)
- Running build scripts, tests, or development servers
- System operations (process management, environment variables)
- Operations requiring shell features (pipes, redirects, conditionals)
- Any command not covered by specialized tools (read, grep, find, ls, edit, write)

Parameters:
- command: The shell command to execute
- timeout: Optional timeout in seconds (default varies by configuration)
- cwd: Working directory for the command (defaults to configured directory)

Behavior:
- Commands run in a shell environment (bash)
- The working directory persists between commands
- Shell state does NOT persist (environment is re-initialized each call)
- Returns stdout and stderr output

Safety notes:
- DO NOT run destructive commands unless explicitly instructed:
  - \`git reset --hard\`, \`git clean -fd\`, \`git branch -D\`
  - \`rm -rf\` without verification
  - Force pushes to main/master branches
- Prefer specific file operations over \`git add -A\` or \`git add .\`
- Always verify paths before operations that modify files

Best practices:
- Use absolute paths to avoid working directory issues
- Chain dependent commands with \`&&\` or \`;\`
- Run independent commands in parallel when possible
- Check command exit status when operations depend on success
- Use appropriate timeouts for long-running operations`,

	/**
	 * PowerShell tool - Windows-first command execution
	 */
	powershell: `Execute PowerShell commands in the terminal.

Usage: Run Windows-first shell commands for workflows that need real PowerShell semantics.

When to use:
- Windows and Unity workflows that rely on PowerShell cmdlets or Windows-native tools
- PowerShell-specific scripting, pipelines, and object-oriented command composition
- Native Windows automation where bash semantics would be the wrong fit
- Any task where the user explicitly wants PowerShell instead of bash

Parameters:
- command: The PowerShell command to execute
- timeout: Optional timeout in seconds (default varies by configuration)

Behavior:
- Commands run in a PowerShell host with non-interactive execution flags
- The working directory persists between commands
- Shell state does NOT persist (environment is re-initialized each call)
- On Windows, prefers PowerShell 7 (pwsh) and falls back to Windows PowerShell when needed
- On non-Windows hosts, requires PowerShell 7+ (pwsh)
- Returns combined stdout and stderr output

Safety notes:
- Do NOT use PowerShell for dedicated built-in file tools when read/grep/find/ls/edit/write are available
- Do NOT run destructive commands unless explicitly instructed
- Prefer explicit file paths and PowerShell call syntax when invoking Windows executables with spaces

Best practices:
- Keep PowerShell usage explicit and intentional; do not assume bash syntax applies
- Use PowerShell cmdlets and quoting rules correctly for Windows paths and arguments
- Use appropriate timeouts for long-running commands
- Prefer the dedicated built-in file tools over shell-based file inspection when available`,

	/**
	 * Edit tool - surgical file modifications
	 */
	edit: `Make surgical edits to files by finding exact text and replacing it.

Usage: Modify specific portions of existing files without rewriting the entire file.

When to use:
- Change a specific function or method
- Update configuration values
- Fix bugs in existing code
- Add or remove specific lines
- Any targeted modification to file contents

Parameters:
- path: Path to the file to edit
- oldText: EXACT text to find in the file (must match exactly, including whitespace)
- newText: New text to replace the old text with

Critical rules:
- oldText MUST match the file content exactly - every character, whitespace, and newline
- Use the read tool first to get the exact content
- The edit replaces the first occurrence of oldText in the file
- If oldText appears multiple times, only the first occurrence is replaced

Common pitfalls:
1. Whitespace mismatches: Copy EXACTLY from the file, including indentation
2. Missing newlines: Ensure newText has appropriate line endings
3. Partial matches: oldText must be a complete, unique section
4. Regex escaping: This is NOT regex - treat all characters as literals
5. Multi-line edits: Include all lines from start to end of the section being replaced

Best practices:
- ALWAYS read the file first to get exact content
- Use small, specific oldText chunks to minimize mismatch risk
- Verify the edit worked by reading the file again
- If multiple edits are needed in the same file, make them in separate calls
- For large rewrites, consider using write instead`,

	/**
	 * Write tool - file creation and overwrite
	 */
	write: `Create new files or completely overwrite existing files.

Usage: Create new files or replace entire file contents.

When to use:
- Creating brand new files that don't exist
- Completely rewriting an existing file (not partial edits)
- Generating files from templates
- Writing configuration files, source code, or documentation

Parameters:
- path: Path to the file to write (relative or absolute)
- content: The complete file content to write

Behavior:
- Creates the file if it doesn't exist
- OVERWRITES the entire file if it exists (complete replacement)
- Does NOT append to existing content
- Creates parent directories automatically if needed

Important:
- This is a complete file replacement, NOT a partial update
- For partial modifications to existing files, use the edit tool instead
- Always read existing files before overwriting to understand current state
- Be certain you want to replace ALL content when using this tool

Best practices:
- Use for new files or complete rewrites only
- Use edit for partial modifications to existing files
- Verify the file was written correctly by reading it back
- Ensure proper file encoding (UTF-8)`,

	/**
	 * Grep tool - content search
	 */
	grep: `Search file contents for patterns using ripgrep.

Usage: Find text within files using regex or literal patterns.

When to use:
- Search for function definitions, variable names, or imports
- Find all occurrences of a string or pattern across files
- Search within specific file types (e.g., only .ts files)
- When you need to find where something is defined or used
- Content search respects .gitignore by default

Parameters:
- pattern: Search pattern (regex or literal string)
- path: Directory or file to search in (default: current directory)
- glob: Optional glob pattern to filter files (e.g., "*.ts", "**/*.js")
- ignoreCase: Case-insensitive search (default: false)
- literal: Treat pattern as literal string instead of regex (default: false)
- context: Number of lines to show before and after each match (default: 0)

Behavior:
- Respects .gitignore - won't search ignored files/directories
- Supports regex patterns for powerful search
- Can limit search to specific file types with glob
- Returns matching lines with file paths and line numbers

When to prefer over bash grep:
- Faster and more efficient for most searches
- Automatically respects .gitignore
- Better regex support (PCRE-like)
- Outputs structured results with line numbers
- Parallel search by default

Best practices:
- Use glob to limit search to relevant file types
- Use ignoreCase for case-insensitive searches
- Use context to see surrounding lines
- Use literal for simple string searches to avoid regex issues`,

	/**
	 * Find tool - file glob search
	 */
	find: `Find files by glob pattern matching.

Usage: Locate files matching specific patterns in the filesystem.

When to use:
- Find all files of a certain type (e.g., all .ts files)
- Search for files with specific naming patterns
- Discover project structure and file organization
- Find configuration files, test files, or source files
- Respects .gitignore by default

Parameters:
- pattern: Glob pattern to match files (e.g., "*.ts", "**/*.js", "src/**/*.test.ts")
- path: Directory to search in (default: current directory)
- limit: Maximum number of results (default: 1000)

Behavior:
- Respects .gitignore - won't return ignored files/directories
- Supports standard glob patterns:
  - * matches any characters in a single path component
  - ** matches any characters across path components (recursive)
  - ? matches a single character
  - [abc] matches character classes
- Returns file paths relative to the search directory

When to prefer over bash find:
- Faster and more intuitive for common patterns
- Automatically respects .gitignore
- Simpler syntax for typical use cases
- Better output formatting

Best practices:
- Use ** for recursive searches (e.g., "**/*.ts" for all TypeScript files)
- Use * for non-recursive searches within a directory
- Combine with grep tool for finding files containing specific content
- Use appropriate limits to avoid overwhelming output`,

	/**
	 * Ls tool - directory listing
	 */
	ls: `List directory contents.

Usage: Display files and directories in a specified location.

When to use:
- Explore directory structure
- Verify files exist before operations
- See what files are in a directory
- Check directory organization
- Respects .gitignore by default (doesn't list ignored files)

Parameters:
- path: Directory to list (default: current directory)
- limit: Maximum number of entries to return (default: 500)

Behavior:
- Returns entries sorted alphabetically
- Directories are marked with '/' suffix
- Includes dotfiles (files starting with .)
- Respects .gitignore - won't list ignored files/directories

When to prefer over bash ls:
- Faster and more efficient for exploration
- Automatically respects .gitignore
- Structured output that's easier to parse
- Better defaults for code exploration

Best practices:
- Use to verify directory contents before creating files
- Check parent directory exists before creating new files
- Use after file operations to verify success
- Explore project structure systematically`,

	/**
	 * Todo write tool - task/todo list management
	 */
	todo_write: `Update the session's structured task/todo list for multi-step workflows.

Usage: Create and track a list of tasks to complete. This provides visible progress tracking during execution.

When to use proactively:
- The user provides a list of things to do (treat each as a todo item)
- Work spans multiple files or distinct phases
- Starting complex work without a clear plan (create todos as your plan)
- After completing a task, create/update todos for next steps
- During active work, at least one todo should be in_progress

Parameters:
- todos: Array of task objects with:
  - content: Imperative description of what needs to be done (e.g., "Implement user authentication")
  - activeForm: Present continuous form shown during execution (e.g., "Implementing user authentication")
  - status: One of "pending", "in_progress", or "completed"

Semantics:
- FULL LIST REPLACEMENT: Each call completely replaces the previous list — include ALL current todos in every call
- Mark tasks in_progress when you start working on them, completed when done
- Mark tasks complete IMMEDIATELY after finishing (do not leave them in_progress)
- Exactly ONE task should be in_progress at any time during active work
- An empty array clears all todos

When NOT to use:
- Single trivial operations (just do them directly)
- Quick file reads or lookups
- Tasks better tracked mentally

Examples:
- Start workflow: todos=[{content: "Read existing code", activeForm: "Reading existing code", status: "pending"}, {content: "Implement feature", activeForm: "Implementing feature", status: "pending"}]
- Begin work: update status of first task to "in_progress"
- Finish and move on: update first to "completed", second to "in_progress"
- Clear list: todos=[] (when all tasks are done)`,

	/**
	 * Memory write tool - structured session memory
	 */
	memory_write: `Record or clear structured session memory that must survive compaction.

Usage: Store stable facts, constraints, decisions, or working context that should remain visible on future turns even after conversation history is compacted.

When to use:
- Stable constraints from the user (e.g., "never run npm test", "do not modify reference repo")
- Important decisions that later turns must respect
- Working context that is likely to matter after compaction
- Facts that complement, but do not replace, the active todo list

Parameters:
- action: "set" to store/update a memory item, "clear" to remove all session memory
- key: Short stable key (required for action=set), such as "constraints.test_command"
- value: Memory value (required for action=set)

Semantics:
- Session-local persistence: memory is saved in the session and restored on resume
- Compaction-safe: memory is injected into the real model-facing context path after compaction
- Prefer concise, durable facts over noisy notes
- Update an existing key by calling action=set with the same key
- Clear everything only when the stored memory is no longer trustworthy or relevant

When NOT to use:
- Temporary step-by-step task progress (use todo_write)
- Large notes or raw transcripts
- Facts that are already obvious from current prompt context
- Speculative information that may go stale quickly`,

	/**
	 * Task create tool - structured multi-step work tracking
	 */
	task_create: `Create a structured task for multi-step work tracking.

Usage: Create a new explicit work item that can be inspected, updated, and tracked across the session.

When to use:
- The work is multi-step and spans multiple tool calls or turns
- The work has a clear deliverable that should be tracked explicitly
- The work is complex enough that it benefits from having a separate subject and description
- You want to give the model explicit awareness of a work item it is currently doing
- Use task_update to mark it in_progress when you start working on it

When to use vs task_list:
- Always call task_list FIRST to check for existing tasks and avoid duplicates
- Only create a new task if no existing task covers the work

Parameters:
- subject: Brief title/subject of the task (required)
- description: Detailed description of what the task involves
- activeForm: Strongly recommended — active-form phrasing shown when task is in_progress (e.g., "Implementing feature X")
- metadata: Optional free-form metadata object

Status transitions:
- After creating, use task_update to mark the task as in_progress before starting work
- When the deliverable is complete, use task_update to mark it as completed
- Keep status in_sync with actual work state

Meaningful tasks only:
- Do NOT create a task for every trivial step; reserve tasks for meaningful multi-step work
- A task should represent a coherent unit of work, not a single command
- Quick lookups, file reads, or exploratory work do not need tasks

Anti-patterns:
- Do NOT create a task and then never update its status
- Do NOT confuse tasks with todo_write items — tasks have explicit id/subject/description and are designed for model-visible work tracking

Examples:
- Create a task before starting multi-file refactoring
- Create a task when the user assigns a complex feature to implement
- Create a task when you need to track a complex investigation across multiple steps`,

	/**
	 * Task list tool - list all structured tasks
	 */
	task_list: `List all structured tasks with their current status.

Usage: Get a summary view of all tasks grouped by status (pending, in_progress, completed).

When to use:
- Before creating a new task: ALWAYS check here first to avoid duplicates
- You want to check the current state of all tracked work
- You are about to start new work and want to know what is already in progress
- You need to assess what remains before wrapping up

When to use vs task_get:
- Use task_list for a summary view or when you don't have a specific task ID
- Use task_get when you have a task ID and need full details

Parameters: None

Examples:
- List tasks before creating a new one to check for overlap
- List tasks at the start of a session to assess current state
- List tasks before updating status to see the full picture`,

	/**
	 * Task get tool - retrieve a specific task by ID
	 */
	task_get: `Retrieve full details of a specific task by its ID.

Usage: Inspect a single task's subject, description, status, activeForm, and metadata.

When to use:
- You have a task ID and need to see the full task details
- You need the current status before updating
- You want to verify task state after resuming a session
- You are about to update a task and want to confirm the current values

Parameters:
- taskId: The unique ID of the task (required)

When NOT to use:
- You don't know the task ID — use task_list first
- You want to update multiple tasks — use task_update directly with known IDs
- You just want a summary — use task_list instead

Examples:
- Get task details before updating status
- Verify a task exists after session resume
- Read description to understand what a task involves before working on it

Anti-patterns:
- Do NOT use task_get to list all tasks — use task_list instead`,

	/**
	 * Task update tool - update an existing task's fields
	 */
	task_update: `Update one or more fields of an existing task.

Usage: Modify task status, subject, description, activeForm, or metadata.

When to use:
- Mark a task as in_progress when you start working on it
- Mark a task as completed when you finish it
- Update the subject or description if requirements change
- Change the activeForm to reflect current work phrasing
- Update metadata to record progress or decisions

Status transition rules:
- pending → in_progress: Mark when you begin working on a task
- in_progress → completed: Mark immediately when the deliverable is done
- Exactly ONE task should be in_progress at any time
- Do not leave tasks in_progress after finishing — mark them completed immediately

When NOT to use:
- You don't know the task ID — use task_list first
- You want to create a new task — use task_create instead
- You want to see task details — use task_get instead

Parameters:
- taskId: The unique ID of the task to update (required)
- subject: New subject/title (optional)
- description: New description (optional)
- status: New status — "pending", "in_progress", or "completed" (optional)
- activeForm: New active-form phrasing for in_progress display (optional)
- metadata: Replacement metadata object (optional)

Anti-patterns:
- Do NOT update a task you did not create or verify exists
- Do NOT leave a task in_progress when you finish — update to completed immediately
- Do NOT use task_update to create tasks — use task_create instead

Examples:
- Update task status to in_progress when starting work
- Update task status to completed when done
- Update activeForm to show "Refactoring authentication module" while in_progress`,
};

/**
 * Get rich LLM-facing prompt instructions for a specific tool.
 *
 * @param toolName - Name of the tool (read, bash, edit, write, grep, find, ls, todo_write, memory_write)
 * @returns Rich prompt instructions for the tool, or undefined if no rich prompt exists
 */
export function getToolPrompt(toolName: string): string | undefined {
	return TOOL_PROMPTS[toolName];
}

/**
 * Get a fallback one-line description for tools without rich prompts.
 */
const FALLBACK_DESCRIPTIONS: Record<string, string> = {
	read: "Read file contents",
	bash: "Execute bash commands (ls, grep, find, etc.)",
	powershell: "Execute PowerShell commands with Windows-first semantics",
	edit: "Make surgical edits to files (find exact text and replace)",
	write: "Create or overwrite files",
	grep: "Search file contents for patterns (respects .gitignore)",
	find: "Find files by glob pattern (respects .gitignore)",
	ls: "List directory contents",
	todo_write: "Update the session's structured task/todo list for multi-step workflows",
	memory_write: "Record or clear structured session memory that survives compaction",
	task_create: "Create a structured task for multi-step work tracking",
	task_list: "List all structured tasks with their current status",
	task_get: "Retrieve full details of a specific task by its ID",
	task_update: "Update an existing task's fields (status, subject, description, etc.)",
};

/**
 * Get tool description - rich prompt if available, otherwise fallback.
 *
 * @param toolName - Name of the tool
 * @returns Rich prompt or one-line fallback description
 */
export function getToolDescription(toolName: string): string {
	return TOOL_PROMPTS[toolName] ?? FALLBACK_DESCRIPTIONS[toolName] ?? toolName;
}
