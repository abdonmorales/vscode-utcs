/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BUNDLED_LAB_HOSTS } from './labHosts';
import { ILabMachine, isValidLabHost, parseLabStatus, rankAvailable, sshRemoteAuthority } from './labStatus';

const SSH_EXTENSION_ID = 'jeanp413.open-remote-ssh';
const STATUS_TIMEOUT_MS = 8000;
const USERNAME_PATTERN = /^[a-z_][a-z0-9_.-]{0,31}$/i;

interface IMachinePick extends vscode.QuickPickItem {
	readonly host?: string;
	readonly leastBusy?: boolean;
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('utcsLab.connect', () => connect(false)));
	context.subscriptions.push(vscode.commands.registerCommand('utcsLab.connectInCurrentWindow', () => connect(true)));
}

function configuration() {
	return vscode.workspace.getConfiguration('utcsLab');
}

async function fetchLabStatus(token: vscode.CancellationToken): Promise<ILabMachine[] | undefined> {
	const url = configuration().get<string>('statusUrl', 'https://apps.cs.utexas.edu/unixlabstatus/');
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
	const cancel = token.onCancellationRequested(() => controller.abort());
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) {
			return undefined;
		}
		const machines = parseLabStatus(await response.text());
		return machines.length ? machines : undefined;
	} catch {
		return undefined; // offline, off campus or the page moved; fall back to the bundled list
	} finally {
		clearTimeout(timer);
		cancel.dispose();
	}
}

function liveItems(machines: readonly ILabMachine[]): IMachinePick[] {
	const available = rankAvailable(machines);
	const down = machines.filter(machine => !machine.up).length;
	const items: IMachinePick[] = [];
	if (available.length) {
		items.push({
			label: `$(zap) ${vscode.l10n.t('Least busy machine')}`,
			description: available[0].host,
			detail: describe(available[0]),
			leastBusy: true,
			host: available[0].host,
		});
	}
	items.push({
		label: down
			? vscode.l10n.t('Available machines, least loaded first ({0} down and hidden)', down)
			: vscode.l10n.t('Available machines, least loaded first'),
		kind: vscode.QuickPickItemKind.Separator,
	});
	for (const machine of available) {
		items.push({ label: machine.host, description: describe(machine), host: machine.host });
	}
	return items;
}

function bundledItems(): IMachinePick[] {
	return [
		{ label: vscode.l10n.t('Lab status is unavailable; showing all known machines'), kind: vscode.QuickPickItemKind.Separator },
		...BUNDLED_LAB_HOSTS.map(host => ({ label: host, host })),
	];
}

function describe(machine: ILabMachine): string {
	const parts: string[] = [];
	if (machine.load !== undefined) {
		parts.push(vscode.l10n.t('load {0}', machine.load.toFixed(2)));
	}
	if (machine.users !== undefined) {
		parts.push(machine.users === 1 ? vscode.l10n.t('1 user') : vscode.l10n.t('{0} users', machine.users));
	}
	return parts.join(' · ');
}

async function pickMachine(): Promise<string | undefined> {
	const quickPick = vscode.window.createQuickPick<IMachinePick>();
	quickPick.title = vscode.l10n.t('Connect to UTCS Lab Machine');
	quickPick.placeholder = vscode.l10n.t('Select a lab machine to connect to over SSH');
	quickPick.matchOnDescription = true;
	quickPick.items = bundledItems();
	quickPick.busy = true;

	const cts = new vscode.CancellationTokenSource();
	fetchLabStatus(cts.token).then(machines => {
		if (cts.token.isCancellationRequested) {
			return; // the picker was closed before the status arrived
		}
		quickPick.busy = false;
		if (machines) {
			quickPick.items = liveItems(machines);
		}
	});

	try {
		return await new Promise<string | undefined>(resolve => {
			quickPick.onDidAccept(() => {
				const host = quickPick.selectedItems[0]?.host;
				if (host) {
					resolve(host);
					quickPick.hide();
				}
			});
			quickPick.onDidHide(() => resolve(undefined));
			quickPick.show();
		});
	} finally {
		cts.cancel();
		cts.dispose();
		quickPick.dispose();
	}
}

async function ensureUsername(): Promise<string | undefined> {
	const configured = configuration().get<string>('username', '').trim();
	if (configured && USERNAME_PATTERN.test(configured)) {
		return configured;
	}
	const username = await vscode.window.showInputBox({
		title: vscode.l10n.t('UTCS Username'),
		prompt: vscode.l10n.t('Your UTCS (CS department) username, used to sign in to the lab machines. It is saved in the utcsLab.username setting.'),
		ignoreFocusOut: true,
		validateInput: value => USERNAME_PATTERN.test(value.trim()) ? undefined : vscode.l10n.t('Enter a username such as abc123.'),
	});
	const trimmed = username?.trim();
	if (!trimmed) {
		return undefined;
	}
	await configuration().update('username', trimmed, vscode.ConfigurationTarget.Global);
	return trimmed;
}

async function ensureSshExtension(): Promise<boolean> {
	if (vscode.extensions.getExtension(SSH_EXTENSION_ID)) {
		return true;
	}
	const show = vscode.l10n.t('Show Extension');
	const choice = await vscode.window.showErrorMessage(
		vscode.l10n.t('Connecting to lab machines needs the Open Remote - SSH extension, which is not installed or is disabled.'),
		show);
	if (choice === show) {
		await vscode.commands.executeCommand('workbench.extensions.search', `@id:${SSH_EXTENSION_ID}`);
	}
	return false;
}

async function connect(reuseWindow: boolean): Promise<void> {
	if (!await ensureSshExtension()) {
		return;
	}
	const host = await pickMachine();
	if (!host || !isValidLabHost(host)) {
		return;
	}
	const user = await ensureUsername();
	if (!user) {
		return;
	}
	const domain = configuration().get<string>('domain', 'cs.utexas.edu').replace(/^\.+/, '');
	await vscode.commands.executeCommand('vscode.newWindow', {
		remoteAuthority: sshRemoteAuthority(`${host}.${domain}`, user),
		reuseWindow,
	});
}
