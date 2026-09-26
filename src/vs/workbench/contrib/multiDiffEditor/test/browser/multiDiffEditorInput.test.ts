/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Event, ValueWithChangeEvent } from '../../../../../base/common/event.js';
import { IReference, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, observableFromValueWithChangeEvent, observableValue, ValueWithChangeEventFromObservable, waitForState } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDiffProviderFactoryService } from '../../../../../editor/browser/widget/diffEditor/diffProviderFactoryService.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { ITextResourceConfigurationService } from '../../../../../editor/common/services/textResourceConfiguration.js';
import { TestDiffProviderFactoryService } from '../../../../../editor/test/browser/diff/testDiffProviderFactoryService.js';
import { createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { instantiateTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ITextFileEditorModelManager, ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { MultiDiffEditorInput } from '../../browser/multiDiffEditorInput.js';
import { IMultiDiffSourceResolverService, MultiDiffEditorItem } from '../../browser/multiDiffSourceResolverService.js';

suite('MultiDiffEditorInput', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('updates its name from the resolved source label', async () => {
		const sourceLabel = observableValue('sourceLabel', 'Current Turn Changes');
		const sourceResolverService = new class extends mock<IMultiDiffSourceResolverService>() {
			override resolve() {
				return Promise.resolve({
					resources: ValueWithChangeEvent.const([]),
					label: new ValueWithChangeEventFromObservable(sourceLabel),
				});
			}
		}();
		const textFileService = new class extends mock<ITextFileService>() {
			override readonly files = new class extends mock<ITextFileEditorModelManager>() {
				override readonly onDidChangeDirty = Event.None;
			}();
		}();
		const input = disposables.add(new MultiDiffEditorInput(
			URI.parse('multi-diff-editor:test'),
			'Fallback',
			undefined,
			false,
			new class extends mock<ITextModelService>() { }(),
			new class extends mock<ITextResourceConfigurationService>() { }(),
			new class extends mock<IInstantiationService>() { }(),
			sourceResolverService,
			textFileService,
		));
		await input.getViewModel();

		const names = [input.getName()];
		disposables.add(input.onDidChangeLabel(() => names.push(input.getName())));
		sourceLabel.set('Last Turn Changes', undefined);

		assert.deepStrictEqual(names, [
			'Current Turn Changes (0 files)',
			'Last Turn Changes (0 files)',
		]);
	});

	test('disposes models that finish resolving after input disposal', async () => {
		const referenceRequested = new DeferredPromise<void>();
		const referenceResult = new DeferredPromise<IReference<IResolvedTextEditorModel>>();
		let referenceDisposed = false;
		const textModelService = new class extends mock<ITextModelService>() {
			override createModelReference() {
				void referenceRequested.complete();
				return referenceResult.p;
			}
		}();
		const textFileService = new class extends mock<ITextFileService>() {
			override readonly files = new class extends mock<ITextFileEditorModelManager>() {
				override readonly onDidChangeDirty = Event.None;
			}();
		}();
		const input = disposables.add(new MultiDiffEditorInput(
			URI.parse('multi-diff-editor:test'),
			'Test',
			[new MultiDiffEditorItem(undefined, URI.parse('file:///modified.ts'), undefined)],
			false,
			textModelService,
			new class extends mock<ITextResourceConfigurationService>() { }(),
			new class extends mock<IInstantiationService>() { }(),
			new class extends mock<IMultiDiffSourceResolverService>() { }(),
			textFileService,
		));

		const viewModelPromise = input.getViewModel();
		await referenceRequested.p;
		input.dispose();
		await referenceResult.complete({
			object: new class extends mock<IResolvedTextEditorModel>() { }(),
			dispose: () => referenceDisposed = true,
		});

		await assert.rejects(viewModelPromise, CancellationError);
		assert.strictEqual(referenceDisposed, true);
	});

	for (const update of ['replace', 'remove', 'dispose'] as const) {
		test(`ignores stale document resolutions after ${update}`, async () => {
			const services = new ServiceCollection();
			services.set(IDiffProviderFactoryService, new TestDiffProviderFactoryService());
			const instantiationService = createCodeEditorServices(disposables, services);
			const createResource = (name: string) => new MultiDiffEditorItem(
				URI.parse(`inmemory:/original/${name}.ts`),
				URI.parse(`inmemory:/modified/${name}.ts`),
				undefined,
			);
			const removed = createResource('removed');
			const slow = createResource('slow');
			const current = createResource('current');
			const resources = observableValue<readonly MultiDiffEditorItem[]>('resources', [removed]);
			const slowReferenceRequested = new DeferredPromise<void>();
			const slowReferenceReady = new DeferredPromise<void>();
			const releasedReferences: string[] = [];
			const textModelService = new class extends mock<ITextModelService>() {
				override async createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
					if (resource.path.endsWith('/slow.ts')) {
						void slowReferenceRequested.complete();
						await slowReferenceReady.p;
					}
					const model = disposables.add(instantiateTextModel(instantiationService, resource.path, undefined, undefined, resource));
					const reference = disposables.add(toDisposable(() => {
						releasedReferences.push(resource.path);
						model.dispose();
					}));
					return {
						object: new class extends mock<IResolvedTextEditorModel>() {
							override readonly textEditorModel = model;
							override isReadonly() { return true; }
						}(),
						dispose: () => reference.dispose(),
					};
				}
			}();
			const input = disposables.add(new MultiDiffEditorInput(
				URI.parse('multi-diff-editor:test'),
				'Test',
				undefined,
				false,
				textModelService,
				new class extends mock<ITextResourceConfigurationService>() {
					override readonly onDidChangeConfiguration = Event.None;
					override getValue<T>(): T { return {} as T; }
				}(),
				instantiationService,
				new class extends mock<IMultiDiffSourceResolverService>() {
					override resolve() {
						return Promise.resolve({ resources: new ValueWithChangeEventFromObservable(resources) });
					}
				}(),
				new class extends mock<ITextFileService>() {
					override readonly files = new class extends mock<ITextFileEditorModelManager>() {
						override readonly onDidChangeDirty = Event.None;
					}();
				}(),
			));
			const viewModel = await input.getViewModel();
			const documents = observableFromValueWithChangeEvent(input, viewModel.model.documents);
			const publishedDocuments: string[][] = [];
			disposables.add(autorun(reader => {
				const value = documents.read(reader);
				if (value !== 'loading') {
					publishedDocuments.push(value.map(document => document.object.modified!.uri.path));
				}
			}));

			resources.set([removed, slow], undefined);
			await slowReferenceRequested.p;
			if (update === 'dispose') {
				input.dispose();
			} else {
				resources.set(update === 'replace' ? [current] : [], undefined);
				await waitForState(documents, value => value !== 'loading' && (update === 'replace'
					? value.length === 1 && value[0].object.modified?.uri.path === current.modifiedUri!.path
					: value.length === 0));
				await viewModel.waitForDiffOr1s();
			}

			await slowReferenceReady.complete();
			await timeout(0);

			assert.deepStrictEqual({
				publishedDocuments,
				releasedReferences: releasedReferences.sort(),
			}, {
				publishedDocuments: [
					['/modified/removed.ts'],
					...(update === 'dispose' ? [] : [update === 'replace' ? ['/modified/current.ts'] : []]),
				],
				releasedReferences: ['/modified/removed.ts', '/modified/slow.ts', '/original/removed.ts', '/original/slow.ts'],
			});
		});
	}
});
