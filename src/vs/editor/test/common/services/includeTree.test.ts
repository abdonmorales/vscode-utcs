/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { collectIncludeTree, IIncludeDirective, parseIncludeDirectives } from '../../../common/services/includeTree.js';

suite('IncludeTree', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses include and import directives', () => {
		assert.deepStrictEqual(parseIncludeDirectives([
			'#include <stdio.h>',
			'  #  include "list.h" // trailing comment',
			'#include_next <limits.h>',
			'#import "Foundation.h"',
			'#include "win\\path.h"',
			'// #include "commented.h"',
			'#define INCLUDE "not a directive"',
			'int include = 0;',
			'#include MACRO_HEADER',
		]), [
			{ path: 'stdio.h', quoted: false },
			{ path: 'list.h', quoted: true },
			{ path: 'limits.h', quoted: false },
			{ path: 'Foundation.h', quoted: true },
			{ path: 'win/path.h', quoted: true },
		]);
	});

	function tree(files: Record<string, string[]>, root: string, maxDepth: number): string[] {
		const uris = Object.keys(files).map(path => URI.file(path));
		const includes = new Map<string, IIncludeDirective[]>(uris.map(uri => [uri.toString(), parseIncludeDirectives(files[uri.path])]));
		return collectIncludeTree(URI.file(root), uris, uri => includes.get(uri.toString()) ?? [], maxDepth).map(uri => uri.path);
	}

	const project = {
		'/src/main.c': ['#include "list.h"', '#include <stdio.h>'],
		'/src/list.h': ['#include "node.h"'],
		'/src/node.h': ['#include "list.h"'],
		'/src/unrelated.c': ['#include "node.h"'],
		'/usr/include/stdio.h': ['#include <bits/types.h>'],
		'/usr/include/bits/types.h': [],
	};

	test('follows includes up to the depth limit', () => {
		assert.deepStrictEqual({
			depth0: tree(project, '/src/main.c', 0),
			depth1: tree(project, '/src/main.c', 1),
			depth2: tree(project, '/src/main.c', 2),
		}, {
			depth0: ['/src/main.c'],
			depth1: ['/src/main.c', '/src/list.h', '/usr/include/stdio.h'],
			depth2: ['/src/main.c', '/src/list.h', '/usr/include/stdio.h', '/src/node.h', '/usr/include/bits/types.h'],
		});
	});

	test('visits each document once when includes form a cycle', () => {
		assert.deepStrictEqual(tree(project, '/src/list.h', 10), ['/src/list.h', '/src/node.h']);
	});

	test('prefers the including folder for quoted includes', () => {
		const files = {
			'/app/main.c': ['#include "util.h"', '#include "../shared/log.h"'],
			'/app/util.h': [],
			'/lib/util.h': [],
			'/shared/log.h': [],
		};
		assert.deepStrictEqual(tree(files, '/app/main.c', 1), ['/app/main.c', '/app/util.h', '/shared/log.h']);
	});

	test('matches angle includes by path suffix only on folder boundaries', () => {
		const files = {
			'/src/main.c': ['#include <types.h>'],
			'/usr/include/types.h': [],
			'/usr/include/mytypes.h': [],
		};
		assert.deepStrictEqual(tree(files, '/src/main.c', 1), ['/src/main.c', '/usr/include/types.h']);
	});
});
