/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The bundled agent host has been removed from core, so the remote server no
// longer spawns or bridges to one. The IPC channel is still registered with a
// stub implementation so that renderers which ask for it fail with an explicit
// error instead of the IPC layer reporting `Unknown channel: agentHostProxy`.

import { Event } from '../../base/common/event.js';
import { IServerChannel } from '../../base/parts/ipc/common/ipc.js';

const agentHostProxyUnavailableMessage = 'Agent host proxy is not available: the bundled agent host is not part of this build.';

/**
 * IPC channel registered when the remote server has no agent host upstream.
 * Keeping the channel present lets renderers fail explicitly without making
 * the IPC layer report `Unknown channel: agentHostProxy`.
 */
export class UnavailableAgentHostChannel<TContext> implements IServerChannel<TContext> {

	listen<T>(_ctx: TContext, event: string): Event<T> {
		switch (event) {
			case 'frame':
			case 'close':
				return Event.None;
		}
		throw new Error(`Invalid listen: ${event}`);
	}

	call<T>(_ctx: TContext, command: string): Promise<T> {
		switch (command) {
			case 'connect':
				return Promise.reject(new Error(agentHostProxyUnavailableMessage));
			case 'send':
			case 'close':
				return Promise.resolve(undefined as T);
		}
		return Promise.reject(new Error(`Invalid call: ${command}`));
	}
}
