/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';

import { diff } from '../../utilsBundle';
import * as z from 'zod';

import { optionalElementSchema } from './snapshot';
import { defineTabTool } from './tool';

import type { Response } from './response';
import type { Tab } from './tab';

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readBaseline(response: Response, inputPath: string, label: string): Promise<string | undefined> {
  const resolvedPath = await response.resolveClientFilename(inputPath);
  try {
    return await fs.promises.readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (!isMissingFile(error))
      throw error;
    response.addError(`${label} baseline file not found: ${inputPath}`);
    return undefined;
  }
}

async function saveFile(response: Response, filename: string, prefix: string, ext: string, title: string, data: string) {
  const resolvedFile = await response.resolveClientOutputFile({ prefix, ext, suggestedFilename: filename }, title);
  await response.addFileResult(resolvedFile, data);
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

function buildPatch(label: string, expected: string, actual: string, maxLines?: number): string {
  const patch = diff.createPatch(label, expected, actual, 'baseline', 'current', { context: 3 });
  const lines = patch.split('\n');
  if (!maxLines || lines.length <= maxLines)
    return patch;
  return lines.slice(0, maxLines).join('\n') + '\n...';
}

function summarizeDiff(expected: string, actual: string, label: string, maxLines?: number): { equal: boolean, patch: string } {
  if (expected === actual)
    return { equal: true, patch: '' };
  return { equal: false, patch: buildPatch(label, expected, actual, maxLines) };
}

async function captureAriaSnapshot(tab: Tab, target?: { target?: string, element?: string }): Promise<string> {
  const root = target?.target ? (await tab.targetLocator({ target: target.target, element: target.element })).locator : undefined;
  const snapshot = await tab.captureSnapshot(root, undefined, undefined, undefined);
  return snapshot.ariaSnapshot;
}

async function captureDomSnapshot(tab: Tab, params: { target?: string, element?: string, stripScripts: boolean, stripStyles: boolean, normalize: 'light' | 'none' }): Promise<string> {
  let html: string;
  if (params.target) {
    const { locator } = await tab.targetLocator({ target: params.target, element: params.element });
    html = await locator.evaluate(el => (el as HTMLElement).outerHTML);
  } else {
    html = await tab.page.evaluate(() => document.documentElement.outerHTML);
  }

  if (params.stripScripts)
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  if (params.stripStyles)
    html = html.replace(/<style[\s\S]*?<\/style>/gi, '');

  if (params.normalize !== 'none') {
    html = html.replace(/\sstyle=""/g, '');
    html = normalizeText(html)
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
  }

  return html;
}

const ariaSnapshotDiff = defineTabTool({
  capability: 'diffs',
  schema: {
    name: 'browser_aria_snapshot_diff',
    title: 'ARIA snapshot diff',
    description: 'Compare an ARIA snapshot with a YAML baseline; optionally target an element.',
    inputSchema: optionalElementSchema.extend({
      baselinePath: z.string().describe('Path to raw YAML baseline snapshot'),
      currentPath: z.string().optional().describe('Output path for the current snapshot.'),
      diffPath: z.string().optional().describe('Output path for the diff.'),
      maxDiffLines: z.number().optional().describe('Maximum diff lines in response (default 120).'),
      failOnDiff: z.boolean().optional().describe('Fail when the page differs from the baseline (default true).'),
    }),
    type: 'assertion',
  },

  handle: async (tab, params, response) => {
    const baselineRaw = await readBaseline(response, params.baselinePath, 'ARIA snapshot');
    if (baselineRaw === undefined)
      return;
    const currentRaw = await captureAriaSnapshot(tab, params);
    const expected = normalizeText(baselineRaw);
    const actual = normalizeText(currentRaw);

    if (params.currentPath)
      await saveFile(response, params.currentPath, 'aria-snapshot', 'yaml', 'Current ARIA snapshot', currentRaw);

    const diffResult = summarizeDiff(expected, actual, 'aria-snapshot', params.maxDiffLines || 120);
    if (diffResult.equal) {
      response.addTextResult('ARIA snapshot matches baseline.');
      return;
    }

    if (params.diffPath)
      await saveFile(response, params.diffPath, 'aria-snapshot-diff', 'diff', 'ARIA snapshot diff', diffResult.patch);

    const failOnDiff = params.failOnDiff !== false;
    if (failOnDiff) {
      response.addTextResult(diffResult.patch);
      response.addError('ARIA snapshot differs from baseline.');
    } else {
      response.addTextResult(`ARIA snapshot differs from baseline.\n${diffResult.patch}`);
    }
  },
});

const domSnapshot = defineTabTool({
  capability: 'diffs',
  schema: {
    name: 'browser_dom_snapshot',
    title: 'DOM snapshot',
    description: 'Capture a page or target DOM snapshot.',
    inputSchema: optionalElementSchema.extend({
      filename: z.string().optional().describe('Snapshot output filename.'),
      stripScripts: z.boolean().optional().describe('Remove script tags (default true).'),
      stripStyles: z.boolean().optional().describe('Remove style tags (default false).'),
      normalize: z.enum(['light', 'none']).optional().describe('Normalization: light (trim whitespace) or none (default light).'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const snapshot = await captureDomSnapshot(tab, {
      target: params.target,
      element: params.element,
      stripScripts: params.stripScripts !== false,
      stripStyles: params.stripStyles === true,
      normalize: params.normalize || 'light',
    });

    if (params.filename)
      await saveFile(response, params.filename, 'dom-snapshot', 'html', 'DOM snapshot', snapshot);
    else
      response.addTextResult(snapshot);
  }
});

const domDiff = defineTabTool({
  capability: 'diffs',
  schema: {
    name: 'browser_dom_diff',
    title: 'DOM snapshot diff',
    description: 'Compare DOM snapshots with a baseline.',
    inputSchema: optionalElementSchema.extend({
      baselinePath: z.string().describe('Path to baseline DOM snapshot'),
      diffPath: z.string().optional().describe('Output path for the diff.'),
      maxDiffLines: z.number().optional().describe('Maximum diff lines in response (default 120).'),
      failOnDiff: z.boolean().optional().describe('Fail when the page differs from the baseline (default true).'),
      stripScripts: z.boolean().optional().describe('Remove script tags (default true).'),
      stripStyles: z.boolean().optional().describe('Remove style tags (default false).'),
      normalize: z.enum(['light', 'none']).optional().describe('Normalization: light (trim whitespace) or none (default light).'),
    }),
    type: 'assertion',
  },

  handle: async (tab, params, response) => {
    const baselineRaw = await readBaseline(response, params.baselinePath, 'DOM');
    if (baselineRaw === undefined)
      return;
    const current = await captureDomSnapshot(tab, {
      target: params.target,
      element: params.element,
      stripScripts: params.stripScripts !== false,
      stripStyles: params.stripStyles === true,
      normalize: params.normalize || 'light',
    });
    const expected = normalizeText(baselineRaw);
    const actual = normalizeText(current);

    const diffResult = summarizeDiff(expected, actual, 'dom-snapshot', params.maxDiffLines || 120);
    if (diffResult.equal) {
      response.addTextResult('DOM snapshot matches baseline.');
      return;
    }

    if (params.diffPath)
      await saveFile(response, params.diffPath, 'dom-snapshot-diff', 'diff', 'DOM snapshot diff', diffResult.patch);

    if (params.failOnDiff !== false) {
      response.addTextResult(diffResult.patch);
      response.addError('DOM snapshot differs from baseline.');
    } else {
      response.addTextResult(`DOM snapshot differs from baseline.\n${diffResult.patch}`);
    }
  }
});

export default [ariaSnapshotDiff, domSnapshot, domDiff];

