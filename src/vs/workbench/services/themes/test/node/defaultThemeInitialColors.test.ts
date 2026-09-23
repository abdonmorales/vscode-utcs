/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { dirname, join } from '../../../../../base/common/path.js';
import { Color } from '../../../../../base/common/color.js';
import { parse } from '../../../../../base/common/json.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { ExtensionGalleryManifestService } from '../../../../../platform/extensionManagement/common/extensionGalleryManifestService.js';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/common/extensionResourceLoaderService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { mock, TestProductService } from '../../../../test/common/workbenchTestServices.js';
import { ColorThemeData } from '../../common/colorThemeData.js';
import { COLOR_THEME_DARK_INITIAL_COLORS, COLOR_THEME_LIGHT_INITIAL_COLORS, ThemeSettingDefaults } from '../../common/workbenchThemeService.js';

/**
 * The INITIAL_COLORS maps paint the workbench before the default theme has
 * loaded. Any key the default theme overrides must match it, or the first frame
 * shows one colour and then visibly swaps to another.
 *
 * Only the default theme's own keys are checked - the ones it sets on top of
 * the theme it `include`s. Inherited values belong to that base theme, and
 * keeping them in step is the base theme's concern rather than this fork's.
 */
suite('Themes - default theme initial colors', () => {
	const fileService = new FileService(new NullLogService());
	const extensionResourceLoaderService = new ExtensionResourceLoaderService(fileService, new (mock<IStorageService>())(), TestProductService, new (mock<IEnvironmentService>())(), new (mock<IConfigurationService>())(), new ExtensionGalleryManifestService(TestProductService), new (mock<IRequestService>())(), new NullLogService());
	const diskFileSystemProvider = new DiskFileSystemProvider(new NullLogService());
	fileService.registerProvider(Schemas.file, diskFileSystemProvider);

	teardown(() => {
		diskFileSystemProvider.dispose();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	// FileAccess.asFileUri('') points at the 'out' directory.
	const themeDefaults = join(dirname(FileAccess.asFileUri('').fsPath), 'extensions', 'theme-defaults');

	async function readJson(path: string) {
		return parse((await fileService.readFile(URI.file(path))).value.toString());
	}

	for (const [themeId, initialColors] of [
		[ThemeSettingDefaults.COLOR_THEME_DARK, COLOR_THEME_DARK_INITIAL_COLORS],
		[ThemeSettingDefaults.COLOR_THEME_LIGHT, COLOR_THEME_LIGHT_INITIAL_COLORS],
	] as const) {
		test(`first paint matches '${themeId}' for every key it overrides`, async () => {
			const manifest = await readJson(join(themeDefaults, 'package.json'));
			const contribution = manifest.contributes.themes.find((t: { id: string }) => t.id === themeId);
			assert.ok(contribution, `default theme '${themeId}' is not contributed by theme-defaults`);

			const themePath = join(themeDefaults, contribution.path);
			const ownKeys = Object.keys((await readJson(themePath)).colors ?? {});

			const theme = ColorThemeData.createUnloadedTheme(themeId);
			theme.location = URI.file(themePath);
			await theme.ensureLoaded(extensionResourceLoaderService);

			const primed = initialColors as Record<string, string>;
			const checked = ownKeys.filter(key => key in primed);
			const mismatches = checked
				.filter(key => !Color.equals(theme.getColor(key, false) ?? null, Color.fromHex(primed[key])))
				.map(key => `${key}: first paint ${primed[key]}, theme ${theme.getColor(key, false)}`);

			assert.deepStrictEqual(mismatches, []);
			// Guard against a vacuous pass, e.g. if the maps are ever re-keyed.
			assert.ok(checked.length >= 10, `only ${checked.length} overridden keys are primed at first paint`);
		});
	}
});
