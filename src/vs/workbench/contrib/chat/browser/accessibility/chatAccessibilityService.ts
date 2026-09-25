/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { renderAsPlaintext } from '../../../../../base/browser/markdownRenderer.js';
import { alert, status } from '../../../../../base/browser/ui/aria/aria.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableMap, DisposableSet, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { runOnChange } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { AccessibilityProgressSignalScheduler } from '../../../../../platform/accessibilitySignal/browser/progressAccessibilitySignalScheduler.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { FocusMode } from '../../../../../platform/native/common/native.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { AccessibilityVoiceSettingId } from '../../../accessibility/browser/accessibilityConfiguration.js';
import { ElicitationState, IChatElicitationRequest, IChatService } from '../../common/chatService/chatService.js';
import { IChatModel } from '../../common/model/chatModel.js';
import { IChatResponseViewModel } from '../../common/model/chatViewModel.js';
import { ChatConfiguration, ChatNotificationMode } from '../../common/constants.js';
import { IChatAccessibilityService, IChatWidgetService } from '../chat.js';
import { ChatWidget } from '../widget/chatWidget.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';

const CHAT_RESPONSE_PENDING_ALLOWANCE_MS = 4000;
export class ChatAccessibilityService extends Disposable implements IChatAccessibilityService {
	declare readonly _serviceBrand: undefined;

	private _pendingSignalMap: DisposableMap<URI, IDisposable> = this._register(new DisposableMap(new ResourceMap()));

	private readonly toasts = this._register(new DisposableSet());

	constructor(
		@IAccessibilitySignalService private readonly _accessibilitySignalService: IAccessibilitySignalService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IHostService private readonly _hostService: IHostService,
		@IChatWidgetService private readonly _widgetService: IChatWidgetService,
		@IChatService private readonly _chatService: IChatService,
	) {
		super();
		this._register(this._widgetService.onDidBackgroundSession(e => {
			const session = this._chatService.getSession(e);
			if (!session) {
				return;
			}
			const requestInProgress = session.requestInProgress.get();
			if (!requestInProgress) {
				return;
			}
			this.disposeRequest(e);
		}));
	}

	acceptRequest(uri: URI, skipRequestSignal?: boolean, model: IChatModel | undefined = this._chatService.getSession(uri)): void {
		if (!skipRequestSignal) {
			this._accessibilitySignalService.playSignal(AccessibilitySignal.chatRequestSent, { allowManyInParallel: true });
		}
		const store = new DisposableStore();
		const scheduler = store.add(new MutableDisposable<AccessibilityProgressSignalScheduler>());
		const startProgress = () => {
			if (!scheduler.value) {
				scheduler.value = this._instantiationService.createInstance(AccessibilityProgressSignalScheduler, CHAT_RESPONSE_PENDING_ALLOWANCE_MS, undefined);
			}
		};
		startProgress();
		if (model) {
			// Reruns cancel the active request right before sending its replacement, so only stop once the model settles as idle.
			const stopIfIdle = store.add(new RunOnceScheduler(() => {
				if (!model.hasActiveRequest.get()) {
					this._disposeRequestIfCurrent(uri, store);
				}
			}, 0));
			store.add(runOnChange(model.requestInProgress, inProgress => inProgress ? startProgress() : scheduler.clear()));
			store.add(runOnChange(model.hasActiveRequest, active => active ? stopIfIdle.cancel() : stopIfIdle.schedule()));
			store.add(Event.once(model.onDidDispose)(() => this._disposeRequestIfCurrent(uri, store)));
		}
		this._pendingSignalMap.set(uri, store);
	}

	private _disposeRequestIfCurrent(uri: URI, store: IDisposable): void {
		if (this._pendingSignalMap.get(uri) === store) {
			this._pendingSignalMap.deleteAndDispose(uri);
		}
	}

	disposeRequest(requestId: URI): void {
		this._pendingSignalMap.deleteAndDispose(requestId);
	}

	acceptResponse(widget: ChatWidget, container: HTMLElement, response: IChatResponseViewModel | string | undefined, requestId: URI, isVoiceInput?: boolean): void {
		this._pendingSignalMap.deleteAndDispose(requestId);
		const isPanelChat = typeof response !== 'string';
		const responseContent = typeof response === 'string' ? response : response?.response.toString();
		this._accessibilitySignalService.playSignal(AccessibilitySignal.chatResponseReceived, { allowManyInParallel: true });
		if (!response || !responseContent) {
			return;
		}
		const plainTextResponse = renderAsPlaintext(new MarkdownString(responseContent));
		const errorDetails = isPanelChat && response.errorDetails ? ` ${response.errorDetails.message}` : '';
		this._showOSNotification(widget, container, plainTextResponse + errorDetails);
		if (!isVoiceInput || this._configurationService.getValue(AccessibilityVoiceSettingId.AutoSynthesize) !== 'on') {
			status(plainTextResponse + errorDetails);
		}
	}
	acceptElicitation(elicitation: IChatElicitationRequest): void {
		if (elicitation.state.get() !== ElicitationState.Pending) {
			return;
		}
		const title = typeof elicitation.title === 'string' ? elicitation.title : elicitation.title.value;
		const message = typeof elicitation.message === 'string' ? elicitation.message : elicitation.message.value;
		alert(title + ' ' + message);
		this._accessibilitySignalService.playSignal(AccessibilitySignal.chatUserActionRequired, { allowManyInParallel: true });
	}

	private async _showOSNotification(widget: ChatWidget, container: HTMLElement, responseContent: string): Promise<void> {
		const mode = this._configurationService.getValue<ChatNotificationMode>(ChatConfiguration.NotifyWindowOnResponseReceived);
		if (mode === ChatNotificationMode.Off) {
			return;
		}

		const targetWindow = dom.getWindow(container);
		if (!targetWindow) {
			return;
		}

		const isFocused = targetWindow.document.hasFocus();
		if (mode !== ChatNotificationMode.Always && isFocused) {
			return;
		}

		// Don't show notification if there's no meaningful content
		if (!responseContent || !responseContent.trim()) {
			return;
		}

		// Focus window in notify mode (flash taskbar/dock) if not already focused
		if (!isFocused) {
			await this._hostService.focus(targetWindow, { mode: FocusMode.Notify });
		}

		// Dispose any previous unhandled notifications to avoid replacement/coalescing.
		this.toasts.clearAndDisposeAll();

		const title = widget?.viewModel?.model.title ? localize('chatTitle', "Chat: {0}", widget.viewModel.model.title) : localize('chat.untitledChat', "Untitled Chat");

		const cts = new CancellationTokenSource();
		const disposable = toDisposable(() => cts.dispose(true));
		this.toasts.add(disposable);

		const { clicked } = await this._hostService.showToast({ title, body: localize('notificationDetail', "New chat response.") }, cts.token);
		this.toasts.deleteAndDispose(disposable);
		if (clicked) {
			await this._hostService.focus(targetWindow, { mode: FocusMode.Force });
			await this._widgetService.reveal(widget);
			widget.focusInput();
		}
	}

}
