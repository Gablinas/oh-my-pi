import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/sdk";
import { ReadTool } from "../../src/tools/read";
import { github } from "../../src/utils/github";
import { handleGitHub } from "../../src/web/scrapers/github";
import * as pages from "../../src/web/scrapers/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const URL = "https://api.github.com/repos/owner/private-repo/issues/comments/42";
let dir: string;
let tool: ReadTool;
beforeEach(() => {
	vi.spyOn(github, "available").mockReturnValue(true);
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "github-api-url-"));
	const session: ToolSession = {
		cwd: dir,
		hasUI: false,
		settings: Settings.isolated({ "fetch.enabled": true }),
		getSessionFile: () => path.join(dir, "session.jsonl"),
		getArtifactsDir: () => path.join(dir, "artifacts"),
		getSessionSpawns: () => null,
		allocateOutputArtifact: async () => ({ id: "0", path: path.join(dir, "artifacts", "0.log") }),
	};
	tool = new ReadTool(session);
});
afterEach(() => {
	vi.restoreAllMocks();
	removeSyncWithRetries(dir);
});

describe("authenticated GitHub repository API URL reads", () => {
	test("generic read renders private repository JSON through authenticated GET, not anonymous fetch", async () => {
		vi.spyOn(pages, "loadPage").mockImplementation(async () => {
			throw new Error("anonymous fetch cannot read this private resource");
		});
		vi.spyOn(github, "run").mockImplementation(async (_cwd, args) => {
			if (args[args.indexOf("--hostname") + 1] !== "github.com" || args[args.indexOf("--method") + 1] !== "GET")
				throw new Error("credential host or method boundary crossed");
			if (!args.includes("/repos/owner/private-repo/issues/comments/42")) throw new Error("wrong resource");
			return { exitCode: 0, stdout: '{"id":42,"body":"private comment"}', stderr: "" };
		});
		const result = await tool.execute("call", { path: URL });
		expect(result.details?.method).toBe("github-api");
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");
		expect(text).toContain('"id": 42');
		expect(text).toContain('"body": "private comment"');
	});

	test("generic read preserves successful plaintext workflow logs", async () => {
		vi.spyOn(pages, "loadPage").mockImplementation(async () => {
			throw new Error("anonymous fetch cannot read private logs");
		});
		vi.spyOn(github, "run").mockResolvedValue({
			exitCode: 0,
			stdout: "2026-10-06T18:00:00Z Running private job\n2026-10-06T18:00:01Z build completed\n",
			stderr: "",
		});
		const result = await tool.execute("logs", {
			path: "https://api.github.com/repos/owner/private-repo/actions/jobs/42/logs",
		});
		expect(result.details?.contentType).toBe("text/plain");
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");
		expect(text).toContain("2026-10-06T18:00:00Z Running private job");
		expect(text).toContain("2026-10-06T18:00:01Z build completed");
	});

	test("public repository JSON stays readable without the GitHub CLI", async () => {
		vi.spyOn(github, "available").mockReturnValue(false);
		vi.spyOn(github, "run").mockRejectedValue(new Error("missing CLI must not be invoked"));
		vi.spyOn(pages, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			finalUrl: URL,
			contentType: "application/json",
			content: '{"id":42,"private":false}',
		});
		const result = await tool.execute("public", { path: URL });
		expect(result.details?.method).toBe("json");
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");
		expect(text).toContain('"private": false');
		expect(text).toContain('"id": 42');
	});

	test("public repository JSON stays readable after an explicit local authentication setup refusal", async () => {
		vi.spyOn(github, "run").mockResolvedValue({
			exitCode: 4,
			stdout: "",
			stderr:
				"To get started with GitHub CLI, please run:  gh auth login\n" +
				"Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n",
		});
		vi.spyOn(pages, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			finalUrl: URL,
			contentType: "application/json",
			content: '{"id":42,"private":false}',
		});
		const result = await tool.execute("public", { path: URL });
		expect(result.details?.method).toBe("json");
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");
		expect(text).toContain('"private": false');
		expect(text).toContain('"id": 42');
	});

	test("HTTP auth failures and an unclassified exit code 4 never trigger an anonymous retry", async () => {
		const run = vi.spyOn(github, "run");
		const anonymous = vi.spyOn(pages, "loadPage").mockRejectedValue(new Error("unexpected anonymous retry"));
		for (const result of [
			{ exitCode: 1, stdout: '{"message":"Bad credentials"}', stderr: "gh: Bad credentials (HTTP 401)" },
			{ exitCode: 1, stdout: '{"message":"Forbidden"}', stderr: "gh: Forbidden (HTTP 403)" },
			{ exitCode: 4, stdout: "", stderr: "unclassified failure" },
		]) {
			run.mockResolvedValue(result);
			await expect(tool.execute("failure", { path: URL })).rejects.toThrow(result.stderr);
		}
		expect(anonymous).not.toHaveBeenCalled();
	});

	test("real HTTP 404 stays an error; no permission diagnosis or anonymous retry hides it", async () => {
		vi.spyOn(github, "run").mockResolvedValue({
			exitCode: 1,
			stdout: '{"message":"Not Found"}',
			stderr: "gh: Not Found (HTTP 404)",
		});
		const anonymous = vi.spyOn(pages, "loadPage").mockImplementation(async () => {
			throw new Error("unexpected anonymous retry");
		});
		await expect(tool.execute("call", { path: URL })).rejects.toThrow("Not Found (HTTP 404)");
		expect(anonymous).not.toHaveBeenCalled();
	});

	test("raw mode keeps its unauthenticated byte-reading contract", async () => {
		const authenticated = vi.spyOn(github, "run").mockImplementation(async () => {
			throw new Error("raw unexpectedly used stored credentials");
		});
		vi.spyOn(pages, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			finalUrl: URL,
			contentType: "application/json",
			content: '{"id":42}',
		});
		const result = await tool.execute("call", { path: `${URL}:raw` });
		expect(result.details?.method).toBe("raw");
		expect(result.content.find(c => c.type === "text")?.text).toContain('{"id":42}');
		expect(authenticated).not.toHaveBeenCalled();
	});

	test("stored GitHub credentials never enter caller-selected hosts, protocols, userinfo, ports or unrelated API routes", async () => {
		const authenticated = vi.spyOn(github, "run").mockImplementation(async () => {
			throw new Error("stored credential boundary crossed");
		});
		for (const url of [
			"https://api.github.com.evil.test/repos/o/r/issues/1",
			"http://api.github.com/repos/o/r/issues/1",
			"https://api.github.com:8443/repos/o/r/issues/1",
			"https://user:password@api.github.com/repos/o/r/issues/1",
			"https://api.github.com/user",
			"https://api.github.com/repos/%7Bowner%7D/r/issues/1",
			"not a URL",
		])
			expect(await handleGitHub(url, 5)).toBeNull();
		expect(authenticated).not.toHaveBeenCalled();
	});
});
