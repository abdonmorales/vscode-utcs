/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This type previously lived in `vs/sessions/common/agentHostSessionsProvider.ts`. The
// `vs/sessions` layer (the bundled "Cowork" sessions workbench) was removed from core, but
// the type is still referenced by `contrib/chat`, so it is rehomed here next to the rest of
// the agent-host protocol types it is built from.

import { McpServerStatus, type CustomizationEnablement, type McpServerState } from './state/protocol/state.js';
import { type CustomizationDisabledReason } from './customizationEnablement.js';

/**
 * A rich view of a single MCP server exposed by an agent host session.
 * Encapsulates the dispatch plumbing so consumers can present and toggle
 * servers without depending on the low-level protocol action surface.
 */
export interface IAgentHostMcpServer {
	readonly id: string;
	readonly name: string;
	readonly enabled: boolean;
	readonly enablement?: readonly CustomizationEnablement[];
	readonly isPluginProvided?: boolean;
	readonly isClientBundled?: boolean;
	readonly owningPluginClientId?: string;
	readonly disabledReason?: CustomizationDisabledReason;
	readonly status: McpServerStatus;
	readonly state: McpServerState;
	readonly logOutputChannelId?: string;
	/** Starts or restarts the server. Providers that cannot control lifecycle may no-op. */
	start(): Promise<void>;
	/** Stops the server. Providers that cannot control lifecycle may no-op. */
	stop(): Promise<void>;
	setEnabled(enabled: boolean): void;
}
