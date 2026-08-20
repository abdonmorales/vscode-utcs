/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The platforms that @github/copilot ships platform-specific packages for.
 * These are the `@github/copilot-{platform}` optional dependency packages.
 */
export const copilotPlatforms = [
	'darwin-arm64', 'darwin-x64',
	'linux-arm64', 'linux-x64',
	'linuxmusl-arm64', 'linuxmusl-x64',
	'win32-arm64', 'win32-x64',
];

/**
 * Converts VS Code build platform/arch to the values that Node.js reports
 * at runtime via `process.platform` and `process.arch`.
 *
 * The copilot SDK's `loadNativeModule` looks up native binaries under
 * `prebuilds/${process.platform}-${process.arch}/`, so the directory names
 * must match these runtime values exactly.
 */
function toNodePlatformArch(platform: string, arch: string): { nodePlatform: string; nodeArch: string } {
	// alpine is musl-linux; Node still reports process.platform === 'linux'
	let nodePlatform = platform === 'alpine' ? 'linux' : platform;
	let nodeArch = arch;

	if (arch === 'armhf') {
		// VS Code build uses 'armhf'; Node reports process.arch === 'arm'
		nodeArch = 'arm';
	} else if (arch === 'alpine') {
		// Legacy: { platform: 'linux', arch: 'alpine' } means alpine-x64
		nodePlatform = 'linux';
		nodeArch = 'x64';
	}

	return { nodePlatform, nodeArch };
}

/**
 * The platform-arch directories shipped by @vscode/ripgrep-universal.
 * These follow Node's `${process.platform}-${process.arch}` naming.
 * Alpine builds reuse the regular `linux-*` binaries (ripgrep is statically
 * linked enough to run on both glibc and musl).
 */
const ripgrepUniversalPlatforms = [
	'darwin-arm64', 'darwin-x64',
	'linux-arm', 'linux-arm64', 'linux-ia32', 'linux-x64',
	'linux-ppc64', 'linux-riscv64', 'linux-s390x',
	'win32-arm64', 'win32-ia32', 'win32-x64',
];

const copilotTgrepPlatforms = [
	'darwin-arm64', 'darwin-x64',
	'linux-arm64', 'linux-x64',
	'linuxmusl-arm64', 'linuxmusl-x64',
	'win32-arm64', 'win32-x64',
];

const mxcArchitectures = ['x64', 'arm64'];

function toCopilotTgrepPlatformArch(platform: string, arch: string): string {
	if (platform === 'alpine') {
		return `linuxmusl-${arch}`;
	}
	if (arch === 'alpine') {
		return 'linuxmusl-x64';
	}

	const { nodePlatform, nodeArch } = toNodePlatformArch(platform, arch);
	return `${nodePlatform}-${nodeArch}`;
}

function toCopilotPackagePlatformArch(platform: string, arch: string): string {
	if (platform === 'alpine') {
		return `linuxmusl-${arch}`;
	}
	if (arch === 'alpine') {
		return 'linuxmusl-x64';
	}

	const { nodePlatform, nodeArch } = toNodePlatformArch(platform, arch);
	return `${nodePlatform}-${nodeArch}`;
}

/**
 * Returns a glob filter that strips @microsoft/mxc-sdk `bin/<arch>` payload for
 * architectures other than the build target. `@microsoft/mxc-sdk` ships a full
 * set of sandbox binaries for every architecture under `bin/<arch>/`; only the
 * build target's architecture is needed. Architectures that mxc-sdk does not
 * ship (e.g. armhf) strip every `bin/<arch>` directory.
 */
export function getMxcExcludeFilter(arch: string): string[] {
	const target = mxcArchitectures.includes(arch) ? arch : undefined;
	const nonTargetArchitectures = mxcArchitectures.filter(a => a !== target);

	return [
		'**',
		...nonTargetArchitectures.map(a => `!**/node_modules/@microsoft/mxc-sdk/bin/${a}/**`),
	];
}

/**
 * Returns a glob filter that strips @vscode/ripgrep-universal bin directories
 * for architectures other than the build target.
 */
export function getRipgrepExcludeFilter(platform: string, arch: string): string[] {
	const { nodePlatform, nodeArch } = toNodePlatformArch(platform, arch);
	const target = `${nodePlatform}-${nodeArch}`;
	const nonTargetPlatforms = ripgrepUniversalPlatforms.filter(p => p !== target);

	const excludes = nonTargetPlatforms.map(p => `!**/node_modules/@vscode/ripgrep-universal/bin/${p}/**`);

	return ['**', ...excludes];
}

export function getCopilotTgrepExcludeFilter(platform: string, arch: string): string[] {
	const target = toCopilotTgrepPlatformArch(platform, arch);
	const nonTargetPlatforms = copilotTgrepPlatforms.filter(p => p !== target);

	return [
		'**',
		...nonTargetPlatforms.map(p => `!**/node_modules/@github/copilot/tgrep/bin/${p}/**`),
		...nonTargetPlatforms.map(p => `!**/node_modules/@github/copilot/sdk/tgrep/bin/${p}/**`),
	];
}

/**
 * Returns a glob filter that strips @github/copilot platform packages
 * for architectures other than the build target.
 *
 * Alpine uses the linuxmusl-* packages. Other platform package names follow
 * Node's `${process.platform}-${process.arch}` naming. If Copilot does not
 * ship the computed platform package (for example linux-arm for armhf builds),
 * this strips every known @github/copilot-* platform package.
 */
export function getCopilotExcludeFilter(platform: string, arch: string): string[] {
	const targetPlatformArch = toCopilotPackagePlatformArch(platform, arch);
	const nonTargetPlatforms = copilotPlatforms.filter(p => p !== targetPlatformArch);

	// Strip wrong-architecture @github/copilot-{platform} packages.
	const excludes = nonTargetPlatforms.map(p => `!**/node_modules/@github/copilot-${p}/**`);

	return [
		'**',
		...excludes,
		'!**/node_modules/@github/copilot-*/copilot',
		'!**/node_modules/@github/copilot-*/copilot.exe',
	];
}
