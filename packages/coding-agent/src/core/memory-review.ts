import type { MemoryItem } from "./memory.js";

export const MEMORY_STALE_AFTER_DAYS = 7;

export interface MemoryReviewItem {
	item: MemoryItem;
	ageDays: number | null;
	label: string;
	reviewRecommended: boolean;
	note?: string;
}

export function getMemoryAgeDays(timestamp: string, now = Date.now()): number | null {
	const parsed = new Date(timestamp).getTime();
	if (Number.isNaN(parsed)) {
		return null;
	}
	const ageMs = Math.max(0, now - parsed);
	return Math.floor(ageMs / 86_400_000);
}

export function formatMemoryAgeLabel(ageDays: number | null): string {
	if (ageDays === null) return "unknown age";
	if (ageDays === 0) return "today";
	if (ageDays === 1) return "yesterday";
	return `${ageDays} days ago`;
}

export function reviewMemoryItems(items: MemoryItem[], now = Date.now()): MemoryReviewItem[] {
	return items.map((item) => {
		const ageDays = getMemoryAgeDays(item.timestamp, now);
		const reviewRecommended = ageDays !== null && ageDays > MEMORY_STALE_AFTER_DAYS;
		return {
			item,
			ageDays,
			label: formatMemoryAgeLabel(ageDays),
			reviewRecommended,
			note: reviewRecommended
				? `This memory is ${ageDays} days old and may be outdated. Verify before relying on it.`
				: undefined,
		};
	});
}
