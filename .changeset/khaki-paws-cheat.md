---
"@apholdings/jensen-code": patch
---

Fix update notifications to default safely to the fork release channel, use strict stable semver comparison, reject malformed registry versions, and fail closed on empty or invalid channel configuration (including explicitly empty environment variables).