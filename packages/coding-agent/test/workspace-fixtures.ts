/**
 * Deterministic workspace-index fixtures shared across tests.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FixtureTree {
	root: string;
	storageRoot: string;
}

export function makeFixture(overrides: Record<string, string> = {}): FixtureTree {
	const root = mkdtempSync(path.join(tmpdir(), "ws-fixture-"));
	const storageRoot = mkdtempSync(path.join(tmpdir(), "ws-store-"));
	const defaults: Record<string, string> = {
		"src/auth.ts": [
			"export function authenticateUser(username: string, password: string): boolean {",
			"  // validate credentials against the user store",
			"  return username === 'admin' && password === 'secret';",
			"}",
			"export function hashPassword(pw: string): string {",
			"  return pw;",
			"}",
			"export class AuthService {",
			"  login(user: string, pw: string): boolean {",
			"    return authenticateUser(user, pw);",
			"  }",
			"}",
		].join("\n"),
		"src/db.ts": [
			"export function connectDatabase(url: string): void {",
			"  // open a connection",
			"}",
			"export function runQuery(sql: string): Array<Record<string, unknown>> {",
			"  return [];",
			"}",
		].join("\n"),
		"README.md": "# Demo workspace\nThis project demonstrates authentication and a database layer.\n",
		"package.json": '{"name":"fixture","version":"1.0.0"}',
		".gitignore": "node_modules/\ndist/\n",
		"src/.env": "API_KEY=super_secret_value_do_not_embed\n",
		".jensenindexignore": "",
	};
	const files: Record<string, string> = { ...defaults, ...overrides };
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(root, rel.replace(/\//g, path.sep));
		mkdirSync(path.dirname(abs), { recursive: true });
		writeFileSync(abs, content, "utf-8");
	}
	return { root, storageRoot };
}

export function makeSynthetic(override: Record<string, string> = {}): FixtureTree {
	return makeFixture({
		"src/auth.ts": "export const AUTH_VERSION = 1;\nexport function sign(x: string): string { return x; }\n",
		...override,
	});
}
