import test from "node:test";
import assert from "node:assert/strict";
import { waitForPublishedVersion } from "./publish-unpublished-packages.mjs";

function createCheckVersion(responses) {
	let index = 0;
	const calls = [];

	return {
		calls,
		async checkVersion(name, version) {
			calls.push({ name, version });
			const response = responses[Math.min(index, responses.length - 1)];
			index += 1;
			return response;
		},
	};
}

test("waitForPublishedVersion succeeds immediately when the package version is already visible", async () => {
	const sleepCalls = [];
	const { calls, checkVersion } = createCheckVersion([{ published: true, summary: "confirmed version 0.1.4" }]);

	await waitForPublishedVersion("@apholdings/jensen-web-ui", "0.1.4", {
		checkVersion,
		sleep: async (ms) => {
			sleepCalls.push(ms);
		},
	});

	assert.equal(calls.length, 1);
	assert.deepEqual(sleepCalls, []);
});

test("waitForPublishedVersion retries with exponential backoff until the package version appears", async () => {
	const sleepCalls = [];
	const { calls, checkVersion } = createCheckVersion([
		{ published: false, summary: "exit=1 stdout=<empty> stderr=E404" },
		{ published: false, summary: "exit=1 stdout=<empty> stderr=E404" },
		{ published: true, summary: "confirmed version 0.1.4" },
	]);

	await waitForPublishedVersion("@apholdings/jensen-web-ui", "0.1.4", {
		checkVersion,
		sleep: async (ms) => {
			sleepCalls.push(ms);
		},
		initialDelayMs: 250,
		maxDelayMs: 1000,
	});

	assert.equal(calls.length, 3);
	assert.deepEqual(sleepCalls, [250, 500]);
});

test("waitForPublishedVersion tolerates slower propagation for the final package in the publish sequence", async () => {
	const sleepCalls = [];
	const { calls, checkVersion } = createCheckVersion([
		{ published: false, summary: "exit=1 stdout=<empty> stderr=E404" },
		{ published: false, summary: "exit=1 stdout=<empty> stderr=E404" },
		{ published: false, summary: "exit=1 stdout=<empty> stderr=E404" },
		{ published: true, summary: "confirmed version 0.1.4" },
	]);

	await waitForPublishedVersion("@apholdings/jensen-web-ui", "0.1.4", {
		checkVersion,
		sleep: async (ms) => {
			sleepCalls.push(ms);
		},
		initialDelayMs: 100,
		maxDelayMs: 400,
	});

	assert.equal(calls.length, 4);
	assert.deepEqual(sleepCalls, [100, 200, 400]);
});

test("waitForPublishedVersion fails with package, version, retry count, and last registry response after exhausting retries", async () => {
	const sleepCalls = [];
	const { calls, checkVersion } = createCheckVersion([
		{ published: false, summary: "exit=1 stdout=<empty> stderr=E404 Not Found - package not propagated yet" },
	]);

	await assert.rejects(
		waitForPublishedVersion("@apholdings/jensen-web-ui", "0.1.4", {
			checkVersion,
			sleep: async (ms) => {
				sleepCalls.push(ms);
			},
			maxAttempts: 4,
			initialDelayMs: 50,
			maxDelayMs: 100,
		}),
		(error) => {
			assert.match(error.message, /@apholdings\/jensen-web-ui@0\.1\.4/);
			assert.match(error.message, /after 4 attempts/);
			assert.match(error.message, /E404 Not Found - package not propagated yet/);
			return true;
		},
	);

	assert.equal(calls.length, 4);
	assert.deepEqual(sleepCalls, [50, 100, 100]);
});
