import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const packageJsonUrl = new URL("../package.json", import.meta.url);

type PackageJson = {
	name?: string;
	version?: string;
	keywords?: string[];
	files?: string[];
	scripts?: Record<string, string>;
	pi?: {
		extensions?: string[];
	};
};

async function readPackageJson(): Promise<PackageJson> {
	return JSON.parse(await readFile(packageJsonUrl, "utf8")) as PackageJson;
}

test("package metadata declares the Ralph Loop Pi package entrypoint", async () => {
	const packageJson = await readPackageJson();

	assert.equal(packageJson.name, "pi-ralph-loop");
	assert.equal(packageJson.version, "0.1.1");
	assert.ok(packageJson.keywords?.includes("pi-package"));
	assert.deepEqual(packageJson.pi?.extensions, ["./extensions/index.ts"]);
	await access(new URL("../extensions/index.ts", import.meta.url));
});

test("release package allowlist includes extension sources and public docs", async () => {
	const packageJson = await readPackageJson();
	const requiredFiles = ["extensions", "README.md", "CHANGELOG.md", "LICENSE"];

	for (const requiredFile of requiredFiles) {
		assert.ok(packageJson.files?.includes(requiredFile), `expected files to include ${requiredFile}`);
	}
});

test("npm pack and publish run the full verification suite first", async () => {
	const packageJson = await readPackageJson();

	assert.equal(packageJson.scripts?.verify, "npm test && npm run lint && npm run typecheck");
	assert.equal(packageJson.scripts?.prepack, "npm run verify");
});
