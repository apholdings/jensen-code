/**
 * MCP Client Foundation — SDK module-type shims (2.13.0).
 *
 * The official MCP SDK 1.30.0 ships an exports map whose wildcard subpaths are
 * inconsistent across resolvers: the runtime `import` target lacks a `.js`
 * extension (so Node requires `*.js`), while the `types` target only resolves
 * without the `.js` suffix. This breaks Node16 type-checking for the `.js`
 * specifiers Jensen must emit for the compiled Node runtime.
 *
 * These ambient declarations give TypeScript the SDK's own types for the
 * runtime-correct `*.js` specifiers by re-exporting from the type-correct
 * extensionless specifier. They have no runtime effect; Node/esbuild/vitest keep
 * resolving the real dist modules via the exports map.
 */

declare module "@modelcontextprotocol/sdk/client/stdio.js" {
	export * from "@modelcontextprotocol/sdk/client/stdio";
}

declare module "@modelcontextprotocol/sdk/types.js" {
	export * from "@modelcontextprotocol/sdk/types";
}
