import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { emptyStopDiagnostic } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";

function stop(
	content: AssistantMessage["content"],
	usage: { input?: number; output: number; reasoningTokens?: number },
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "minimax-code",
		model: "MiniMax-M3",
		usage: { input: 0, cacheRead: 0, cacheWrite: 0, ...usage },
		stopReason: "stop",
	} as AssistantMessage;
}

describe("emptyStopDiagnostic", () => {
	it("names a reasoning-only stop and never prescribes /shake images", () => {
		const { finalError, recoveryBranch } = emptyStopDiagnostic(
			stop([{ type: "thinking", thinking: "Only reasoning." }], { output: 1491 }),
			false,
		);

		expect(recoveryBranch).toBe("reasoning-only-stop");
		expect(finalError).toContain("reasoning-only stop");
		expect(finalError).toContain("no text, tool call, or image");
		// The context hypothesis is unobserved here; prescribing it was the bug.
		expect(finalError).not.toContain("/shake images");
		expect(finalError).not.toContain("archived frames");
	});

	it("treats a signature as replay metadata, not as a delivered answer", () => {
		const { finalError, recoveryBranch } = emptyStopDiagnostic(
			stop([{ type: "thinking", thinking: "Signed but still not an answer.", thinkingSignature: "sig" }], {
				output: 1571,
			}),
			false,
		);

		// A signed reasoning-only stop is still not something the user can read.
		expect(recoveryBranch).toBe("reasoning-only-stop");
		expect(finalError).toContain("1 signed / 0 unsigned");
		expect(finalError).not.toContain("/shake images");
	});

	it("reports signed and unsigned reasoning separately in the evidence", () => {
		const { evidence } = emptyStopDiagnostic(
			stop(
				[
					{ type: "thinking", thinking: "finished", thinkingSignature: "sig" },
					{ type: "thinking", thinking: "cut off mid-sen" },
				],
				{ output: 900 },
			),
			false,
		);

		expect(evidence.signedThinkingBlocks).toBe(1);
		expect(evidence.unsignedThinkingBlocks).toBe(1);
		expect(evidence.blockKinds).toEqual(["thinking", "thinking"]);
		expect(evidence.blockLengths).toEqual([8, 15]);
		expect(evidence.stopReason).toBe("stop");
		expect(evidence.recoveryBranch).toBe("reasoning-only-stop");
	});

	it("describes a zero-block stop without asserting a cause", () => {
		const { finalError, recoveryBranch } = emptyStopDiagnostic(stop([], { output: 400 }), false);

		expect(recoveryBranch).toBe("zero-block-stop");
		expect(finalError).toContain("no content blocks at all");
		// A content filter needs provider evidence; the message may not claim one.
		expect(finalError).not.toContain("content filter");
	});

	it("keeps an absent reasoning split unknown instead of reading it as zero", () => {
		const { finalError, evidence } = emptyStopDiagnostic(
			stop([{ type: "thinking", thinking: "Reasoning." }], { output: 1491 }),
			false,
		);

		expect(finalError).toContain("the reasoning/output split is unknown");
		expect(finalError).not.toContain("of them reasoning");
		expect(evidence.reasoningTokens).toBeNull();
	});

	it("reports the split when the provider supplied one", () => {
		const { finalError, evidence } = emptyStopDiagnostic(
			stop([{ type: "thinking", thinking: "Reasoning." }], { output: 1491, reasoningTokens: 1400 }),
			false,
		);

		expect(finalError).toContain("1400 of them reasoning");
		expect(evidence.reasoningTokens).toBe(1400);
	});

	it("keeps the provider-empty-output message distinct from a parsed reasoning stop", () => {
		const { finalError, recoveryBranch } = emptyStopDiagnostic(
			stop([{ type: "thinking", thinking: "Reasoning." }], { output: 0 }),
			true,
		);

		expect(recoveryBranch).toBe("provider-empty-output");
		expect(finalError).toBe("Assistant returned no final output after retry cap; try switching models");
	});

	it("does not count empty or whitespace-only text as delivered output", () => {
		const { finalError, recoveryBranch, evidence } = emptyStopDiagnostic(
			stop([{ type: "text", text: "   " }], { output: 40 }),
			false,
		);

		expect(recoveryBranch).toBe("non-actionable-mixed");
		expect(evidence.deliveredBlocks).toBe(0);
		// The real length is preserved even though the block delivered nothing.
		expect(evidence.blockLengths).toEqual([3]);
		expect(finalError).toContain("0 delivered blocks");
		expect(finalError).not.toContain("/shake images");
	});

	it("handles redacted reasoning explicitly instead of folding it into thinking", () => {
		const { finalError, recoveryBranch, evidence } = emptyStopDiagnostic(
			stop([{ type: "redactedThinking", data: "opaque-cipher-text" }], { output: 200, reasoningTokens: 180 }),
			false,
		);

		expect(recoveryBranch).toBe("reasoning-only-stop");
		expect(evidence.redactedThinkingBlocks).toBe(1);
		expect(evidence.redactedChars).toBe(18);
		expect(evidence.signedThinkingBlocks).toBe(0);
		expect(evidence.unsignedThinkingBlocks).toBe(0);
		expect(finalError).toContain("1 redacted thinking block (18 chars)");
		expect(finalError).toContain("180 of them reasoning");
	});
});
