/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as dom from '../../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { OffsetRange } from '../../../../../../editor/common/core/ranges/offsetRange.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { NullTelemetryService } from '../../../../../../platform/telemetry/common/telemetryUtils.js';
import { SaveReason } from '../../../../../common/editor.js';
import { ISaveAllEditorsOptions, ISaveEditorsResult } from '../../../../../services/editor/common/editorService.js';
import { TestEditorService } from '../../../../../test/browser/workbenchTestServices.js';
import { ChatInputPart } from '../../../browser/widget/input/chatInputPart.js';
import { acceptAndAwaitSentRequest, ChatWidget, getImmediateSilentSlashCommandPart, layoutChatWidgetForInputHeight, saveAllBeforeChatSend, shouldShowChatTip, shouldShowChatWelcome } from '../../../browser/widget/chatWidget.js';
import { ChatSendResult, ChatSendResultSent, IChatSendRequestData } from '../../../common/chatService/chatService.js';
import { ChatAgentLocation, ChatConfiguration } from '../../../common/constants.js';
import { IChatRequestViewModel } from '../../../common/model/chatViewModel.js';
import { ToolAndToolSetEnablementMap } from '../../../common/tools/languageModelToolsService.js';
import { ChatRequestSlashCommandPart, ChatRequestTextPart, IParsedChatRequest } from '../../../common/requestParser/chatParserTypes.js';
import { observePromptTimelineHostWidth } from '../../../browser/promptTimeline/promptTimelineWidgetContrib.js';

suite('ChatWidget', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	class RecordingEditorService extends TestEditorService {
		readonly saveAllCalls: (ISaveAllEditorsOptions | undefined)[] = [];

		override async saveAll(options?: ISaveAllEditorsOptions): Promise<ISaveEditorsResult> {
			this.saveAllCalls.push(options);
			return { success: true, editors: [] };
		}
	}

	function createRequestEditWidget(currentInput: string, currentAttachmentIds: readonly string[], confirmResult = false) {
		const editing = {};
		let confirmationCount = 0;
		let finishedCount = 0;
		let focusCount = 0;
		const widget = Object.create(ChatWidget.prototype) as ChatWidget;
		Object.defineProperties(widget, {
			viewModel: { value: { editing } },
			input: {
				value: {
					inputEditor: { getValue: () => currentInput },
					attachmentModel: { getAttachmentIDs: () => new Set(currentAttachmentIds) },
					focus: () => focusCount++,
				}
			},
			_requestEditSnapshot: {
				value: {
					input: 'original request',
					attachmentIds: new Set(['original-attachment']),
				},
				writable: true,
			},
			_requestEditCancellationPending: { value: false, writable: true },
			dialogService: {
				value: {
					confirm: async () => {
						confirmationCount++;
						return { confirmed: confirmResult };
					}
				}
			},
			finishedEditing: { value: () => finishedCount++ },
		});

		return {
			widget,
			result: () => ({ confirmationCount, finishedCount, focusCount }),
		};
	}

	test('saves non-untitled editors before sending by default', async () => {
		const configurationService = new TestConfigurationService();
		const editorService = store.add(new RecordingEditorService());

		await saveAllBeforeChatSend(configurationService, editorService);
		await configurationService.setUserConfiguration(ChatConfiguration.SaveBeforeSend, false);
		await saveAllBeforeChatSend(configurationService, editorService);

		assert.deepStrictEqual(editorService.saveAllCalls, [{
			includeUntitled: false,
			reason: SaveReason.EXPLICIT,
		}]);
	});

	test('confirms before cancelling changed request edits', async () => {
		const scenarios = [
			{ name: 'unchanged', input: 'original request', attachmentIds: ['original-attachment'] },
			{ name: 'text changed', input: 'edited request', attachmentIds: ['original-attachment'] },
			{ name: 'attachment added', input: 'original request', attachmentIds: ['original-attachment', 'new-attachment'] },
			{ name: 'attachment removed', input: 'original request', attachmentIds: [] },
		];
		const actual = [];

		for (const scenario of scenarios) {
			const requestEdit = createRequestEditWidget(scenario.input, scenario.attachmentIds);
			await requestEdit.widget.cancelEditing();
			actual.push({ name: scenario.name, ...requestEdit.result() });
		}
		assert.deepStrictEqual(actual, [
			{ name: 'unchanged', confirmationCount: 0, finishedCount: 1, focusCount: 0 },
			{ name: 'text changed', confirmationCount: 1, finishedCount: 0, focusCount: 1 },
			{ name: 'attachment added', confirmationCount: 1, finishedCount: 0, focusCount: 1 },
			{ name: 'attachment removed', confirmationCount: 1, finishedCount: 0, focusCount: 1 },
		]);
	});

	test('confirmed cancellation discards changed request edits', async () => {
		const requestEdit = createRequestEditWidget('edited request', ['original-attachment'], true);

		await requestEdit.widget.cancelEditing();

		assert.deepStrictEqual(requestEdit.result(), {
			confirmationCount: 1,
			finishedCount: 1,
			focusCount: 0,
		});
	});

	test('transcript overlays suppress the welcome state', () => {
		assert.deepStrictEqual({
			unavailable: shouldShowChatWelcome(undefined, false),
			progressBeforeModel: shouldShowChatWelcome(undefined, true),
			empty: shouldShowChatWelcome(0, false),
			progress: shouldShowChatWelcome(0, true),
			message: shouldShowChatWelcome(1, false),
		}, {
			unavailable: undefined,
			progressBeforeModel: false,
			empty: true,
			progress: false,
			message: false,
		});
	});

	test('loading suppresses the getting-started tip', () => {
		assert.deepStrictEqual([
			shouldShowChatTip(0, false, false),
			shouldShowChatTip(0, false, true),
		], [true, false]);
	});

	test('identifies only leading silent execute-immediately slash commands', () => {
		const command = new ChatRequestSlashCommandPart(
			new OffsetRange(0, 7),
			new Range(1, 1, 1, 8),
			{
				command: 'models',
				detail: 'Open models',
				executeImmediately: true,
				silent: true,
				locations: [ChatAgentLocation.Chat],
			},
		);
		const nonSilentCommand = new ChatRequestSlashCommandPart(
			new OffsetRange(0, 5),
			new Range(1, 1, 1, 6),
			{
				command: 'help',
				detail: 'Show help',
				executeImmediately: true,
				silent: false,
				locations: [ChatAgentLocation.Chat],
			},
		);
		const delayedCommand = new ChatRequestSlashCommandPart(
			new OffsetRange(0, 7),
			new Range(1, 1, 1, 8),
			{
				command: 'rename',
				detail: 'Rename chat',
				executeImmediately: false,
				silent: true,
				locations: [ChatAgentLocation.Chat],
			},
		);
		const prefix = new ChatRequestTextPart(new OffsetRange(0, 1), new Range(1, 1, 1, 2), ' ');
		const shiftedCommand = new ChatRequestSlashCommandPart(
			new OffsetRange(1, 8),
			new Range(1, 2, 1, 9),
			command.slashCommand,
		);

		assert.deepStrictEqual([
			getImmediateSilentSlashCommandPart({ text: '/models', parts: [command] } satisfies IParsedChatRequest)?.slashCommand.command,
			getImmediateSilentSlashCommandPart({ text: '/help', parts: [nonSilentCommand] } satisfies IParsedChatRequest)?.slashCommand.command,
			getImmediateSilentSlashCommandPart({ text: '/rename', parts: [delayedCommand] } satisfies IParsedChatRequest)?.slashCommand.command,
			getImmediateSilentSlashCommandPart({ text: ' /models', parts: [prefix, shiftedCommand] } satisfies IParsedChatRequest)?.slashCommand.command,
		], [
			'models',
			undefined,
			undefined,
			undefined,
		]);
	});

	test('input height changes update the budget without re-laying out the input', () => {
		const calls: unknown[] = [];
		const target = {
			setInputPartMaxHeightOverride: (height: number | undefined) => calls.push(['setInputPartMaxHeightOverride', height]),
			layoutForInputHeight: (height: number, width: number) => calls.push(['layoutForInputHeight', height, width]),
		};

		layoutChatWidgetForInputHeight(target, 600, 420, 720);

		assert.deepStrictEqual(calls, [
			['setInputPartMaxHeightOverride', 600],
			['layoutForInputHeight', 420, 720],
		]);
	});

	test('captures and restores transcript scroll state', () => {
		const listWidget = {
			scrollTop: 200,
			scrollHeight: 1000,
			renderHeight: 300,
			get isScrolledToBottom() {
				return this.scrollTop + this.renderHeight >= this.scrollHeight - 2;
			},
			scrollToEnd() {
				this.scrollTop = this.scrollHeight - this.renderHeight;
			},
		};
		const widget: ChatWidget = Object.assign(Object.create(ChatWidget.prototype), { listWidget });

		const scrolledUp = widget.getViewState();
		widget.restoreViewState({ scrollTop: 350 });
		const legacyScrollTop = listWidget.scrollTop;
		widget.restoreViewState({ scrollTop: 200, isAtBottom: true });

		assert.deepStrictEqual({
			scrolledUp,
			legacyScrollTop,
			bottomScrollTop: listWidget.scrollTop,
		}, {
			scrolledUp: { scrollTop: 200, isAtBottom: false },
			legacyScrollTop: 350,
			bottomScrollTop: 700,
		});
	});

	test('prompt timeline width follows explicit widget layout', () => {
		const onDidLayout = new Emitter<{ width: number; height: number }>();
		const host = document.createElement('div');
		Object.defineProperty(host, 'clientWidth', { value: 320 });
		const widths: number[] = [];
		const observation = observePromptTimelineHostWidth(
			{ onDidLayout: onDidLayout.event },
			host,
			{ setHostWidth: width => widths.push(width) },
		);

		onDidLayout.fire({ width: 480, height: 600 });
		observation.dispose();
		onDidLayout.fire({ width: 640, height: 600 });
		onDidLayout.dispose();
		assert.deepStrictEqual(widths, [320, 480]);
	});

	function createFakeInputPart(name: string) {
		const onDidFocus = store.add(new Emitter<void>());
		const entriesMap = observableValue(`${name}.entriesMap`, ToolAndToolSetEnablementMap.fromMap(new Map()));
		const counts = { updateContext: 0, dispose: 0 };
		const part = upcastPartial<ChatInputPart>({
			element: mainWindow.document.createElement('div'),
			inputUri: URI.parse(`chat-input:/${name}`),
			inputEditor: upcastPartial<ChatInputPart['inputEditor']>({
				getValue: () => 'original request', getModel: () => null, focus: () => { },
				onDidChangeModelContent: Event.None, onDidChangeCursorSelection: Event.None,
			}),
			attachmentModel: upcastPartial<ChatInputPart['attachmentModel']>({
				attachments: [], getAttachmentIDs: () => new Set(), addContext: () => { },
				updateContext: () => { counts.updateContext++; },
			}),
			selectedToolsModel: upcastPartial<ChatInputPart['selectedToolsModel']>({ entriesMap }),
			selectedLanguageModel: observableValue(`${name}.model`, undefined),
			height: observableValue(`${name}.height`, 0),
			currentModeObs: observableValue(`${name}.mode`, upcastPartial<ReturnType<ChatInputPart['currentModeObs']['get']>>({ id: 'agent' })),
			currentModeInfo: upcastPartial<ChatInputPart['currentModeInfo']>({}),
			dnd: upcastPartial<ChatInputPart['dnd']>({ setDisabledOverlay: () => { } }),
			onDidLoadInputState: Event.None,
			onDidFocus: onDidFocus.event,
			onDidAcceptFollowup: Event.None,
			onDidChangeCurrentChatMode: Event.None,
			onDidClickOverlay: Event.None,
			render: () => { },
			layout: () => { },
			setChatMode: () => { },
			setPermissionLevel: () => { },
			setEditing: () => { },
			toggleChatInputOverlay: () => { },
			renderAttachedContext: () => { },
			setValue: () => { },
			focus: () => { },
			dispose: () => { counts.dispose++; },
		});
		return { part, onDidFocus, entriesMap, counts };
	}

	test('releases the inline request edit input and its subscriptions when editing finishes', async () => {
		const configurationService = new TestConfigurationService();
		await configurationService.setUserConfiguration('chat.editRequests', 'inline');
		const main = createFakeInputPart('main');
		const inline = createFakeInputPart('inline');
		const onDidChangeAgents = store.add(new Emitter<void>());
		const onDidChangeContext = store.add(new Emitter<void>());
		let scopedServiceDisposed = false;
		let disposedTipPresenters = 0;
		const instantiationService = {
			createChild: () => ({ createInstance: () => inline.part, dispose: () => { scopedServiceDisposed = true; } }),
			createInstance: (ctor: unknown) => ctor === ChatInputPart ? main.part : { dispose: () => { disposedTipPresenters++; } },
		};
		const inlineInputHolder = store.add(new MutableDisposable<ChatInputPart>());
		const request = upcastPartial<IChatRequestViewModel>({
			id: 'request',
			message: { text: 'original request', parts: [] },
			messageText: 'original request',
			variables: [],
		});
		const rowContainer = mainWindow.document.createElement('div');
		const requestTimestampContainer = dom.append(rowContainer, dom.$('div'));
		let editing: IChatRequestViewModel | undefined;
		const widget = Object.create(ChatWidget.prototype) as ChatWidget;
		Object.defineProperties(widget, {
			_store: { value: store.add(new DisposableStore()) },
			_editingAutoScrollHold: { value: store.add(new MutableDisposable()) },
			_editingDisposables: { value: store.add(new MutableDisposable()) },
			inputPartDisposable: { value: store.add(new MutableDisposable()) },
			inlineInputPartDisposable: { value: inlineInputHolder },
			mainPasteTargetRegistration: { value: store.add(new MutableDisposable()) },
			inlinePasteTargetRegistration: { value: store.add(new MutableDisposable()) },
			_gettingStartedTip: { value: store.add(new MutableDisposable()) },
			_onDidChangeActiveInputEditor: { value: { fire: () => { } } },
			_onDidChangeContentHeight: { value: { fire: () => { } } },
			inputContainer: { value: undefined, writable: true },
			location: { value: ChatAgentLocation.Chat },
			viewContext: { value: {} },
			viewOptions: { value: {} },
			instantiationService: { value: instantiationService },
			chatPasteTargetService: { value: { registerTarget: () => Disposable.None } },
			chatAgentService: { value: { onDidChangeAgents: onDidChangeAgents.event } },
			contextKeyService: { value: { onDidChangeContext: onDidChangeContext.event } },
			configurationService: { value: configurationService },
			telemetryService: { value: NullTelemetryService },
			logService: { value: new NullLogService() },
			viewModel: {
				value: {
					model: { getRequests: () => [], setCheckpoint: () => { } },
					sessionResource: URI.parse('chat-session:/session'),
					get editing() { return editing; },
					setEditing: (request: IChatRequestViewModel | undefined) => { editing = request; },
				},
			},
			contribs: { value: [] },
			refreshParsedInput: { value: () => { } },
			onDidChangeItems: { value: () => { } },
			listWidget: {
				value: {
					getTemplateDataForRequestId: () => ({ currentElement: request, rowContainer, requestTimestampContainer }),
					acquireAutoScrollHold: () => Disposable.None,
				},
			},
		});
		const createInput = (ChatWidget.prototype as unknown as { createInput(container: HTMLElement): void }).createInput;
		createInput.call(widget, mainWindow.document.createElement('div'));

		widget.startEditing(request.id);
		const whileEditing = { input: widget.input === inline.part, focusListener: inline.onDidFocus.hasListeners() };
		main.entriesMap.set(ToolAndToolSetEnablementMap.fromMap(new Map()), undefined);
		widget.finishedEditing();
		const updatesAfterEdit = main.counts.updateContext + inline.counts.updateContext;
		inline.entriesMap.set(ToolAndToolSetEnablementMap.fromMap(new Map()), undefined);

		assert.deepStrictEqual({
			whileEditing,
			input: widget.input === main.part,
			inlineDisposed: inline.counts.dispose > 0,
			inlineInputHeld: inlineInputHolder.value !== undefined,
			disposedTipPresenters,
			scopedServiceDisposed,
			inlineFocusListener: inline.onDidFocus.hasListeners(),
			mainFocusListener: main.onDidFocus.hasListeners(),
			toolUpdatesFromInlineInput: main.counts.updateContext + inline.counts.updateContext - updatesAfterEdit,
			rowChildren: rowContainer.childElementCount,
		}, {
			whileEditing: { input: true, focusListener: true },
			input: true,
			inlineDisposed: true,
			inlineInputHeld: false,
			disposedTipPresenters: 0,
			scopedServiceDisposed: true,
			inlineFocusListener: false,
			mainFocusListener: true,
			toolUpdatesFromInlineInput: 0,
			rowChildren: 1,
		});
	});
});

suite('ChatWidget - acceptAndAwaitSentRequest', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function sentResult(): ChatSendResultSent {
		return { kind: 'sent', data: {} as IChatSendRequestData };
	}

	test('an immediately sent request is accepted and returned', async () => {
		let accepted = 0;
		const result = sentResult();

		const sent = await acceptAndAwaitSentRequest(result, () => accepted++);

		assert.deepStrictEqual({ accepted, sent }, { accepted: 1, sent: result });
	});

	test('a queued request is accepted before the queued request settles', async () => {
		const deferred = new DeferredPromise<ChatSendResult>();
		let accepted = 0;

		const pending = acceptAndAwaitSentRequest({ kind: 'queued', deferred: deferred.p }, () => accepted++);
		// The queued request has not run yet, so `pending` is still unresolved here.
		const acceptedWhileQueued = accepted === 1;

		const result = sentResult();
		await deferred.complete(result);

		assert.deepStrictEqual({ acceptedWhileQueued, accepted, sent: await pending }, {
			acceptedWhileQueued: true,
			accepted: 1,
			sent: result,
		});
	});

	test('a rejected request is never accepted', async () => {
		let accepted = 0;

		const sent = await acceptAndAwaitSentRequest({ kind: 'rejected', reason: 'Empty message' }, () => accepted++);

		assert.deepStrictEqual({ accepted, sent }, { accepted: 0, sent: undefined });
	});

	test('a queued request that is rejected when it runs stays accepted but is not sent', async () => {
		const deferred = new DeferredPromise<ChatSendResult>();
		let accepted = 0;

		const pending = acceptAndAwaitSentRequest({ kind: 'queued', deferred: deferred.p }, () => accepted++);
		await deferred.complete({ kind: 'rejected', reason: 'Session is read-only' });

		assert.deepStrictEqual({ accepted, sent: await pending }, { accepted: 1, sent: undefined });
	});

	test('accepting is optional', async () => {
		const result = sentResult();

		assert.strictEqual(await acceptAndAwaitSentRequest(result), result);
	});
});
