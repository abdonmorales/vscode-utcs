/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ILabMachine {
	readonly host: string;
	readonly up: boolean;
	readonly users: number | undefined;
	readonly load: number | undefined;
}

/**
 * Lab hostnames are single DNS labels such as `apple-jacks`. Anything else in the
 * Host column is rejected, since the value becomes an SSH destination.
 */
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

function cellText(cell: string): string {
	return cell
		.replace(/<[^>]*>/g, '')
		.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
			if (entity[0] === '#') {
				const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
				return Number.isFinite(code) ? String.fromCodePoint(code) : match;
			}
			return ENTITIES[entity.toLowerCase()] ?? match;
		})
		.trim();
}

function parseNumber(value: string): number | undefined {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parses the machine table of https://apps.cs.utexas.edu/unixlabstatus/, whose rows
 * are `Host | Status | Uptime | #Users | Load`. Rows that don't match that shape
 * (the timestamp, section titles and column headers) are skipped.
 */
export function parseLabStatus(html: string): ILabMachine[] {
	const machines: ILabMachine[] = [];
	const seen = new Set<string>();
	for (const row of html.match(/<tr[\s>][\s\S]*?<\/tr>/gi) ?? []) {
		const cells = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(match => cellText(match[1]));
		if (cells.length !== 5) {
			continue;
		}
		const [rawHost, status, , users, load] = cells;
		const host = rawHost.toLowerCase();
		if (!HOST_PATTERN.test(host) || seen.has(host)) {
			continue;
		}
		const state = status.toLowerCase();
		if (state !== 'up' && state !== 'down') {
			continue; // the column header row, or a status this parser does not know
		}
		seen.add(host);
		machines.push({ host, up: state === 'up', users: parseNumber(users), load: parseNumber(load) });
	}
	return machines;
}

/**
 * Machines that are up, least loaded first, then with the fewest users. Machines
 * that don't report a load sort after those that do.
 */
export function rankAvailable(machines: readonly ILabMachine[]): ILabMachine[] {
	return machines
		.filter(machine => machine.up)
		.sort((a, b) =>
			(a.load ?? Number.POSITIVE_INFINITY) - (b.load ?? Number.POSITIVE_INFINITY)
			|| (a.users ?? Number.POSITIVE_INFINITY) - (b.users ?? Number.POSITIVE_INFINITY)
			|| a.host.localeCompare(b.host));
}

export function isValidLabHost(host: string): boolean {
	return HOST_PATTERN.test(host);
}

/**
 * The remote authority Open Remote - SSH resolves: `ssh-remote+` followed by the
 * hex-encoded JSON destination. The hex form survives VS Code lowercasing the
 * authority when a window is restored from the recently opened list.
 */
export function sshRemoteAuthority(hostName: string, user: string): string {
	return `ssh-remote+${Buffer.from(JSON.stringify({ hostName, user }), 'utf8').toString('hex')}`;
}
