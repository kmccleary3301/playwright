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
import path from 'path';

import { diff } from 'playwright-core/lib/utilsBundle';
import { z } from 'playwright-core/lib/mcpBundle';

import { defineTabTool } from './tool';
import { outputDir as outputDirForClient } from '../config';

import type { Context } from '../context';
import type { Tab } from '../tab';

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

function extractYamlBlock(text: string): string {
  const match = text.match(/```yaml\n([\s\S]*?)\n```/);
  return match ? match[1] : text;
}

async function readTextFile(resolvedPath: string): Promise<string> {
  return await fs.promises.readFile(resolvedPath, 'utf8');
}

function resolveMaybeRelative(context: Context, inputPath: string): string {
  if (path.isAbsolute(inputPath))
    return inputPath;
  const cwdPath = path.resolve(process.cwd(), inputPath);
  if (fs.existsSync(cwdPath))
    return cwdPath;
  const outDir = outputDirForClient(context.config, context.options.clientInfo);
  return path.resolve(outDir, inputPath);
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

async function captureAriaSnapshot(tab: Tab): Promise<string> {
  const snapshot = await (tab.page as any)._snapshotForAI({ track: 'response' });
  return snapshot.full;
}

async function captureDomSnapshot(tab: Tab, params: { ref?: string, element?: string, stripScripts: boolean, stripStyles: boolean, normalize: 'light' | 'none' }): Promise<string> {
  let html: string;
  if (params.ref && params.element) {
    const { locator } = await tab.refLocator({ ref: params.ref, element: params.element });
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
    description: 'Compare current ARIA snapshot against a baseline file',
    inputSchema: z.object({
      baselinePath: z.string().describe('Path to baseline snapshot (raw YAML or full snapshot output)'),
      currentPath: z.string().optional().describe('Optional file path to save current snapshot'),
      diffPath: z.string().optional().describe('Optional file path to save the diff'),
      maxDiffLines: z.number().optional().describe('Maximum diff lines to include in response'),
      failOnDiff: z.boolean().optional().describe('Whether to fail when diff is detected (default true)'),
    }),
    type: 'assertion',
  },

  handle: async (tab, params, response) => {
    const currentRaw = await captureAriaSnapshot(tab);
    const baselinePath = resolveMaybeRelative(tab.context, params.baselinePath);
    const baselineRaw = await readTextFile(baselinePath);
    const expected = normalizeText(extractYamlBlock(baselineRaw));
    const actual = normalizeText(currentRaw);

    if (params.currentPath) {
      const currentFile = await response.addFile(params.currentPath, { origin: 'llm', reason: 'Current ARIA snapshot' });
      await fs.promises.writeFile(currentFile, currentRaw, 'utf8');
    }

    const diffResult = summarizeDiff(expected, actual, 'aria-snapshot', params.maxDiffLines || 120);
    if (diffResult.equal) {
      response.addResult('ARIA snapshot matches baseline.');
      return;
    }

    if (params.diffPath) {
      const diffFile = await response.addFile(params.diffPath, { origin: 'llm', reason: 'ARIA snapshot diff' });
      await fs.promises.writeFile(diffFile, diffResult.patch, 'utf8');
    }

    const failOnDiff = params.failOnDiff !== false;
    const message = `ARIA snapshot differs from baseline.\n${diffResult.patch}`;
    if (failOnDiff)
      response.addError(message);
    else
      response.addResult(message);
  },
});

const domSnapshot = defineTabTool({
  capability: 'diffs',
  schema: {
    name: 'browser_dom_snapshot',
    title: 'DOM snapshot',
    description: 'Capture DOM snapshot of the page or an element',
    inputSchema: z.object({
      element: z.string().optional().describe('Human-readable element description'),
      ref: z.string().optional().describe('Exact target element reference'),
      filename: z.string().optional().describe('File name to save snapshot to'),
      stripScripts: z.boolean().optional().describe('Remove script tags (default true)'),
      stripStyles: z.boolean().optional().describe('Remove style tags (default false)'),
      normalize: z.enum(['light', 'none']).optional().describe('Normalization mode (default light)'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    if (!!params.element !== !!params.ref)
      throw new Error('Both element and ref must be provided or neither.');

    const snapshot = await captureDomSnapshot(tab, {
      element: params.element,
      ref: params.ref,
      stripScripts: params.stripScripts !== false,
      stripStyles: params.stripStyles === true,
      normalize: params.normalize || 'light',
    });

    if (params.filename) {
      const fileName = await response.addFile(params.filename, { origin: 'llm', reason: 'DOM snapshot' });
      await fs.promises.writeFile(fileName, snapshot, 'utf8');
      response.addResult(`Saved DOM snapshot to ${fileName}`);
    } else {
      response.addResult(snapshot);
    }
  }
});

const domDiff = defineTabTool({
  capability: 'diffs',
  schema: {
    name: 'browser_dom_diff',
    title: 'DOM snapshot diff',
    description: 'Compare DOM snapshot against a baseline file',
    inputSchema: z.object({
      baselinePath: z.string().describe('Path to baseline DOM snapshot'),
      element: z.string().optional().describe('Human-readable element description'),
      ref: z.string().optional().describe('Exact target element reference'),
      diffPath: z.string().optional().describe('Optional file path to save the diff'),
      maxDiffLines: z.number().optional().describe('Maximum diff lines to include in response'),
      failOnDiff: z.boolean().optional().describe('Whether to fail when diff is detected (default true)'),
      stripScripts: z.boolean().optional().describe('Remove script tags (default true)'),
      stripStyles: z.boolean().optional().describe('Remove style tags (default false)'),
      normalize: z.enum(['light', 'none']).optional().describe('Normalization mode (default light)'),
    }),
    type: 'assertion',
  },

  handle: async (tab, params, response) => {
    if (!!params.element !== !!params.ref)
      throw new Error('Both element and ref must be provided or neither.');

    const current = await captureDomSnapshot(tab, {
      element: params.element,
      ref: params.ref,
      stripScripts: params.stripScripts !== false,
      stripStyles: params.stripStyles === true,
      normalize: params.normalize || 'light',
    });
    const baselinePath = resolveMaybeRelative(tab.context, params.baselinePath);
    const expected = normalizeText(await readTextFile(baselinePath));
    const actual = normalizeText(current);

    const diffResult = summarizeDiff(expected, actual, 'dom-snapshot', params.maxDiffLines || 120);
    if (diffResult.equal) {
      response.addResult('DOM snapshot matches baseline.');
      return;
    }

    if (params.diffPath) {
      const diffFile = await response.addFile(params.diffPath, { origin: 'llm', reason: 'DOM snapshot diff' });
      await fs.promises.writeFile(diffFile, diffResult.patch, 'utf8');
    }

    const failOnDiff = params.failOnDiff !== false;
    const message = `DOM snapshot differs from baseline.\n${diffResult.patch}`;
    if (failOnDiff)
      response.addError(message);
    else
      response.addResult(message);
  }
});

export default [ariaSnapshotDiff, domSnapshot, domDiff];
