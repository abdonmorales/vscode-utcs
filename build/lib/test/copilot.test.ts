/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { copilotPlatforms, getCopilotExcludeFilter, getMxcExcludeFilter } from '../copilot.ts';

suite('copilot', () => {
	test('excludes standalone copilot executables from the platform package dependency stream', () => {
		const files = getCopilotExcludeFilter('linux', 'x64');

		assert(files.includes('**'));
		assert(files.includes('!**/node_modules/@github/copilot-*/copilot'));
		assert(files.includes('!**/node_modules/@github/copilot-*/copilot.exe'));
	});

	test('strips all copilot platform packages for unsupported armhf builds', () => {
		assert.deepStrictEqual(
			getCopilotExcludeFilter('linux', 'armhf'),
			[
				'**',
				...copilotPlatforms.map(platform => `!**/node_modules/@github/copilot-${platform}/**`),
				'!**/node_modules/@github/copilot-*/copilot',
				'!**/node_modules/@github/copilot-*/copilot.exe',
			]
		);
	});

	test('keeps only the target architecture of @microsoft/mxc-sdk', () => {
		assert.deepStrictEqual(
			getMxcExcludeFilter('x64'),
			[
				'**',
				'!**/node_modules/@microsoft/mxc-sdk/bin/arm64/**',
			]
		);
		assert.deepStrictEqual(
			getMxcExcludeFilter('arm64'),
			[
				'**',
				'!**/node_modules/@microsoft/mxc-sdk/bin/x64/**',
			]
		);
	});

	test('strips every @microsoft/mxc-sdk architecture for unsupported armhf builds', () => {
		assert.deepStrictEqual(
			getMxcExcludeFilter('armhf'),
			[
				'**',
				'!**/node_modules/@microsoft/mxc-sdk/bin/x64/**',
				'!**/node_modules/@microsoft/mxc-sdk/bin/arm64/**',
			]
		);
	});
});
