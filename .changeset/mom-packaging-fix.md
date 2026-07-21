---
"@apholdings/jensen-mom": patch
---

Fix packaging: remove broken `main` and `types` entrypoints that referenced non-existent `dist/index.js` and `dist/index.d.ts`. Mom is a CLI-only package (bin: `mom`).
