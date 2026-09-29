/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dirname, isEqual, joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';

/**
 * A `#include` (or `#import`) directive: the path between the quotes or angle brackets.
 */
export interface IIncludeDirective {
	readonly path: string;
	/** `#include "..."`, which is resolved against the including file's folder first. */
	readonly quoted: boolean;
}

const INCLUDE_DIRECTIVE = /^\s*#\s*(?:include|include_next|import)\s*(?:"(?<quoted>[^"]+)"|<(?<angled>[^>]+)>)/;

/**
 * Parses the C preprocessor include directives in the given lines.
 */
export function parseIncludeDirectives(lines: readonly string[]): IIncludeDirective[] {
	const directives: IIncludeDirective[] = [];
	for (const line of lines) {
		const match = INCLUDE_DIRECTIVE.exec(line);
		const quoted = match?.groups?.quoted;
		const path = (quoted ?? match?.groups?.angled)?.trim().replace(/\\/g, '/');
		if (path) {
			directives.push({ path, quoted: quoted !== undefined });
		}
	}
	return directives;
}

function resolveInclude(includer: URI, directive: IIncludeDirective, candidates: readonly URI[]): URI[] {
	if (directive.quoted) {
		const sibling = joinPath(dirname(includer), directive.path);
		const exact = candidates.find(candidate => isEqual(candidate, sibling));
		if (exact) {
			return [exact];
		}
	}
	// Otherwise match any candidate whose path ends with the include path, e.g.
	// `<sys/types.h>` matches `/usr/include/sys/types.h`.
	const suffix = `/${directive.path.replace(/^(?:\.\/)+/, '')}`;
	return candidates.filter(candidate => candidate.path.endsWith(suffix));
}

/**
 * The documents reachable from `root` by following include directives through
 * `candidates`, at most `maxDepth` levels deep. Level 1 is what `root` includes
 * directly. The result starts with `root` and holds each document once.
 */
export function collectIncludeTree(root: URI, candidates: readonly URI[], getIncludes: (uri: URI) => readonly IIncludeDirective[], maxDepth: number): URI[] {
	const tree: URI[] = [root];
	const seen = new Set<string>([root.toString()]);
	let level: URI[] = [root];
	for (let depth = 1; depth <= maxDepth && level.length; depth++) {
		const next: URI[] = [];
		for (const includer of level) {
			for (const directive of getIncludes(includer)) {
				for (const included of resolveInclude(includer, directive, candidates)) {
					const key = included.toString();
					if (!seen.has(key)) {
						seen.add(key);
						tree.push(included);
						next.push(included);
					}
				}
			}
		}
		level = next;
	}
	return tree;
}
