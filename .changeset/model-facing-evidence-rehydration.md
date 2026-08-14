---
"@apholdings/jensen-code": patch
---

Model-Facing Evidence Rehydration.

Adds a `retrieve_evidence` capability that lets the model page a cold
EvidenceArchive artifact back into hot context by its durable evidence id.
Retrieval is read-only, bounded (default page cap with a hard maximum), and
integrity-verified against the stored content hash (fail-closed on
missing/corrupt artifacts). Retrieved content is ordinary untrusted data: it is
returned in its archive-scrubbed representation and never carries completion
authority. Archived evidence references now survive ContextGovernor rollover via
the mission checkpoint, and retrieved-then-re-virtualized content reuses its
original evidence id instead of creating duplicate archive records. MissionRuntime
/ Completion Gate remain the sole completion authority.
