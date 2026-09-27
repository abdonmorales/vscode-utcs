/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { test } from 'node:test';
import { BUNDLED_LAB_HOSTS } from '../labHosts';
import { isValidLabHost, parseLabStatus, rankAvailable, sshRemoteAuthority } from '../labStatus';

// Rows copied from https://apps.cs.utexas.edu/unixlabstatus/ on 2026-09-27.
const row = (color: string, host: string, status: string, uptime: string, users: string, load: string) => `<tr>
<td style="background-color: ${color}; text-align:  left;">${host}</td>
<td style="background-color: ${color}; text-align:  center;">${status}</td>
<td style="background-color: ${color}; text-align:  right;">${uptime}</td>
<td style="background-color: ${color}; text-align:  center;">${users}</td>
<td style="background-color: ${color}; text-align:  right;">${load}</td>
</tr>`;

const page = `<html><body><table width="100%" cellspacing="0">
<tr><td colspan="5" style="text-align: center; background-color: white;">Sun Sep 27 13:31:08 2026</td></tr>
<tr>
<td colspan="5" style="padding: 10px; font-style: italic; font-weight: bold; text-align:  center;">
Public Linux Workstations - 64-bit</td>
</tr>
<tr>
<td style="font-weight: bold; text-align:  left;">Host</td>
<td style="font-weight: bold; text-align:  center;">Status</td>
<td style="font-weight: bold; text-align:  right;">Uptime</td>
<td style="font-weight: bold; text-align:  center;">#Users</td>
<td style="font-weight: bold; text-align:  right;">Load</td>
</tr>
${row('yellow', 'agate', 'up', '6+06:25,', '3', '15.01')}
${row('yellow', 'apple-jacks', 'up', '2+04:15,', '0', '0.01')}
${row('red', 'azurite', 'down', '149+00:49', '', '')}
${row('yellow', 'quartz', 'up', '6+06:25,', '16', '0.00')}
</table></body></html>`;

test('parses machines and skips the timestamp, section and header rows', () => {
	assert.deepStrictEqual(parseLabStatus(page), [
		{ host: 'agate', up: true, users: 3, load: 15.01 },
		{ host: 'apple-jacks', up: true, users: 0, load: 0.01 },
		{ host: 'azurite', up: false, users: undefined, load: undefined },
		{ host: 'quartz', up: true, users: 16, load: 0 },
	]);
});

test('ranks machines that are up by load, then by users', () => {
	assert.deepStrictEqual(rankAvailable(parseLabStatus(page)).map(machine => machine.host), ['quartz', 'apple-jacks', 'agate']);
});

test('rejects host cells that are not a plain lab hostname', () => {
	const hostile = [
		'evil.example.com',
		'-oProxyCommand=touch pwned',
		'user@host',
		'host name',
		'<b>agate</b>x;rm',
	].map(host => row('yellow', host, 'up', '1:00,', '0', '0.00')).join('\n');
	assert.deepStrictEqual(parseLabStatus(`<table>${hostile}</table>`), []);
	assert.strictEqual(isValidLabHost('-oProxyCommand=x'), false);
	assert.strictEqual(isValidLabHost('chocolate-frosted-sugar-bombs'), true);
});

test('ignores unknown statuses and duplicate hosts', () => {
	const html = `<table>${row('yellow', 'agate', 'up', '1:00,', '1', '1.00')}${row('yellow', 'agate', 'up', '1:00,', '9', '9.00')}${row('gray', 'onyx', 'maintenance', '', '', '')}</table>`;
	assert.deepStrictEqual(parseLabStatus(html), [{ host: 'agate', up: true, users: 1, load: 1 }]);
});

test('bundled hosts are all valid and unique', () => {
	assert.strictEqual(BUNDLED_LAB_HOSTS.length, 137);
	assert.strictEqual(new Set(BUNDLED_LAB_HOSTS).size, BUNDLED_LAB_HOSTS.length);
	assert.deepStrictEqual(BUNDLED_LAB_HOSTS.filter(host => !isValidLabHost(host)), []);
});

test('builds the Open Remote - SSH authority as hex-encoded JSON', () => {
	const authority = sshRemoteAuthority('agate.cs.utexas.edu', 'abc123');
	assert.ok(authority.startsWith('ssh-remote+'));
	assert.deepStrictEqual(JSON.parse(Buffer.from(authority.slice('ssh-remote+'.length), 'hex').toString('utf8')), { hostName: 'agate.cs.utexas.edu', user: 'abc123' });
	assert.match(authority, /^ssh-remote\+[0-9a-f]+$/);
});
