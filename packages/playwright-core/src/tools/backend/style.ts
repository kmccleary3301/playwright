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

import * as z from 'zod';

import { elementSchema } from './snapshot';
import { defineTabTool } from './tool';

import type { Response } from './response';
import type { Tab } from './tab';
import type * as playwright from '../../..';

const STYLE_PRESETS = {
  typography: [
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'line-height',
    'letter-spacing',
    'text-transform',
    'text-decoration',
    'text-align',
    'color',
  ],
  box: [
    'display',
    'position',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'background-color',
    'background',
    'box-shadow',
    'opacity',
    'overflow',
    'overflow-x',
    'overflow-y',
  ],
  layout: [
    'width',
    'height',
    'min-width',
    'min-height',
    'max-width',
    'max-height',
    'flex',
    'flex-direction',
    'flex-wrap',
    'justify-content',
    'align-items',
    'align-content',
    'align-self',
    'gap',
    'row-gap',
    'column-gap',
    'grid-template-columns',
    'grid-template-rows',
    'grid-auto-flow',
    'grid-auto-columns',
    'grid-auto-rows',
  ],
  codeblock: [
    'font-family',
    'font-size',
    'line-height',
    'white-space',
    'tab-size',
    'overflow-x',
    'background-color',
    'border-radius',
    'color',
  ],
} as const;

type StylePreset = keyof typeof STYLE_PRESETS;

type LayoutMetrics = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
};

type CapturedTarget = {
  target: string;
  element?: string;
  tag?: string;
  id?: string | null;
  className?: string | null;
  text?: string | null;
  styles?: Record<string, string>;
  layout?: LayoutMetrics;
};

type SnapshotDiff = {
  target: string;
  type: 'missing' | 'extra' | 'style' | 'layout';
  message?: string;
  property?: string;
  expected?: string | number;
  actual?: string | number;
};

const layoutMetricsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
  left: z.number(),
  scrollWidth: z.number(),
  scrollHeight: z.number(),
  clientWidth: z.number(),
  clientHeight: z.number(),
});

const capturedTargetSchema = z.object({
  target: z.string(),
  styles: z.record(z.string(), z.string()).optional(),
  layout: layoutMetricsSchema.optional(),
}).passthrough();

const snapshotPayloadSchema = z.object({
  targets: z.array(capturedTargetSchema).optional(),
}).passthrough();

function snapshotTargets(snapshot: unknown): z.infer<typeof capturedTargetSchema>[] {
  const parsed = snapshotPayloadSchema.parse(snapshot);
  return parsed.targets || [];
}



function resolveProperties(params: { preset?: StylePreset, properties?: string[] }): string[] {
  const preset = params.preset ? STYLE_PRESETS[params.preset] : [];
  const combined = [...new Set([...(params.properties || []), ...preset])];
  if (combined.length)
    return combined;
  return [...STYLE_PRESETS.typography];
}

async function collectForTarget(
  locator: playwright.Locator,
  target: string,
  element: string | undefined,
  props: string[],
  includeLayout: boolean,
  includeText: boolean
): Promise<CapturedTarget> {
  const payload = await locator.evaluate((el, options) => {
    const computed = window.getComputedStyle(el as HTMLElement);
    const styles: Record<string, string> = {};
    for (const prop of options.props)
      styles[prop] = computed.getPropertyValue(prop);
    const rect = (el as HTMLElement).getBoundingClientRect();
    const layout = {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      scrollWidth: (el as HTMLElement).scrollWidth,
      scrollHeight: (el as HTMLElement).scrollHeight,
      clientWidth: (el as HTMLElement).clientWidth,
      clientHeight: (el as HTMLElement).clientHeight,
    };
    return {
      tag: (el as HTMLElement).tagName,
      id: (el as HTMLElement).id || null,
      className: typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : null,
      text: options.includeText ? ((el as HTMLElement).textContent || '').trim().slice(0, 200) : null,
      styles: options.props.length ? styles : undefined,
      layout: options.includeLayout ? layout : undefined,
    };
  }, { props, includeLayout, includeText });
  return { target, element, ...payload };
}

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

function diffStyleSnapshots(expected: unknown, actual: unknown): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = [];
  const expectedByTarget = new Map(snapshotTargets(expected).map(target => [target.target, target]));
  const actualByTarget = new Map(snapshotTargets(actual).map(target => [target.target, target]));
  for (const [target, expectedTarget] of expectedByTarget.entries()) {
    const actualTarget = actualByTarget.get(target);
    if (!actualTarget) {
      diffs.push({ target, type: 'missing', message: 'Target missing in current snapshot' });
      continue;
    }
    const expectedStyles = expectedTarget.styles || {};
    const actualStyles = actualTarget.styles || {};
    for (const key of Object.keys(expectedStyles)) {
      if (expectedStyles[key] !== actualStyles[key])
        diffs.push({ target, type: 'style', property: key, expected: expectedStyles[key], actual: actualStyles[key] });
    }
  }
  for (const [target] of actualByTarget.entries()) {
    if (!expectedByTarget.has(target))
      diffs.push({ target, type: 'extra', message: 'Target missing in baseline snapshot' });
  }
  return diffs;
}

function diffLayoutSnapshots(expected: unknown, actual: unknown): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = [];
  const expectedByTarget = new Map(snapshotTargets(expected).map(target => [target.target, target]));
  const actualByTarget = new Map(snapshotTargets(actual).map(target => [target.target, target]));
  for (const [target, expectedTarget] of expectedByTarget.entries()) {
    const actualTarget = actualByTarget.get(target);
    if (!actualTarget) {
      diffs.push({ target, type: 'missing', message: 'Target missing in current snapshot' });
      continue;
    }
    const expectedLayout: Partial<LayoutMetrics> = expectedTarget.layout || {};
    const actualLayout: Partial<LayoutMetrics> = actualTarget.layout || {};
    for (const key of Object.keys(expectedLayout) as (keyof LayoutMetrics)[]) {
      if (expectedLayout[key] !== actualLayout[key])
        diffs.push({ target, type: 'layout', property: key, expected: expectedLayout[key], actual: actualLayout[key] });
    }
  }
  for (const [target] of actualByTarget.entries()) {
    if (!expectedByTarget.has(target))
      diffs.push({ target, type: 'extra', message: 'Target missing in baseline snapshot' });
  }
  return diffs;
}
const styleSnapshot = defineTabTool({
  capability: 'styles',
  schema: {
    name: 'browser_style_snapshot',
    title: 'Style snapshot',
    description: 'Capture computed styles for selected targets using a preset or CSS properties.',
    inputSchema: z.object({
      targets: z.array(elementSchema).describe('Elements to capture styles for'),
      properties: z.array(z.string()).optional().describe('CSS properties to capture alongside the preset.'),
      preset: z.enum(['typography', 'box', 'layout', 'codeblock']).optional().describe('Preset: typography (text), box (spacing), layout (sizing), codeblock; default typography.'),
      includeLayout: z.boolean().optional().describe('Include layout metrics.'),
      includeText: z.boolean().optional().describe('Include truncated text content.'),
      filename: z.string().optional().describe('Snapshot output filename.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const props = resolveProperties(params);
    const preset = params.preset ?? (params.properties?.length ? 'custom' : 'typography');
    const resolvedTargets = await tab.targetLocators(params.targets);
    const targets = await Promise.all(resolvedTargets.map(({ locator }, index) =>
      collectForTarget(locator, params.targets[index].target, params.targets[index].element, props, params.includeLayout === true, params.includeText === true)));

    const snapshot = {
      createdAt: new Date().toISOString(),
      url: tab.page.url(),
      preset,
      properties: props,
      targets,
    };
    const payload = JSON.stringify(snapshot, null, 2);

    if (params.filename)
      await saveFile(response, params.filename, 'style-snapshot', 'json', 'Style snapshot', payload);
    else
      response.addTextResult(payload);
  }
});

const styleDiff = defineTabTool({
  capability: 'styles',
  schema: {
    name: 'browser_style_diff',
    title: 'Style snapshot diff',
    description: 'Compare computed styles with a JSON baseline.',
    inputSchema: z.object({
      baselinePath: z.string().describe('Path to baseline style snapshot JSON'),
      targets: z.array(elementSchema).describe('Elements to capture styles for'),
      properties: z.array(z.string()).optional().describe('CSS properties to capture'),
      preset: z.enum(['typography', 'box', 'layout', 'codeblock']).optional().describe('Preset: typography (text), box (spacing), layout (sizing), or codeblock.'),
      includeLayout: z.boolean().optional().describe('Include layout metrics.'),
      includeText: z.boolean().optional().describe('Include truncated text content.'),
      diffPath: z.string().optional().describe('Output path for diff JSON.'),
      failOnDiff: z.boolean().optional().describe('Fail when the page differs from the baseline (default true).'),
      maxDiffs: z.number().optional().describe('Maximum diff entries in response (default 20).'),
    }),
    type: 'assertion',
  },

  handle: async (tab, params, response) => {
    const baselineRaw = await readBaseline(response, params.baselinePath, 'Style snapshot');
    if (baselineRaw === undefined)
      return;
    const props = resolveProperties(params);
    const resolvedTargets = await tab.targetLocators(params.targets);
    const targets = await Promise.all(resolvedTargets.map(({ locator }, index) =>
      collectForTarget(locator, params.targets[index].target, params.targets[index].element, props, params.includeLayout === true, params.includeText === true)));
    const snapshot = {
      createdAt: new Date().toISOString(),
      url: tab.page.url(),
      preset: params.preset ?? (params.properties?.length ? 'custom' : 'typography'),
      properties: props,
      targets,
    };

    const baseline = JSON.parse(baselineRaw);
    const diffs = diffStyleSnapshots(baseline, snapshot);
    if (!diffs.length) {
      response.addTextResult('Style snapshot matches baseline.');
      return;
    }

    if (params.diffPath)
      await saveFile(response, params.diffPath, 'style-diff', 'json', 'Style snapshot diff', JSON.stringify(diffs, null, 2));

    const excerpt = diffs.slice(0, params.maxDiffs || 20).map(d => JSON.stringify(d)).join('\n');
    if (params.failOnDiff !== false) {
      response.addTextResult(excerpt);
      response.addError(`Style snapshot differs from baseline (${diffs.length} changes).`);
    } else {
      response.addTextResult(`Style snapshot differs from baseline (${diffs.length} changes).\n${excerpt}`);
    }
  }
});

const layoutSnapshot = defineTabTool({
  capability: 'styles',
  schema: {
    name: 'browser_layout_snapshot',
    title: 'Layout snapshot',
    description: 'Capture layout metrics for targets.',
    inputSchema: z.object({
      targets: z.array(elementSchema).describe('Elements to capture layout for'),
      includeText: z.boolean().optional().describe('Include truncated text content.'),
      filename: z.string().optional().describe('Snapshot output filename.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const resolvedTargets = await tab.targetLocators(params.targets);
    const targets = await Promise.all(resolvedTargets.map(({ locator }, index) =>
      collectForTarget(locator, params.targets[index].target, params.targets[index].element, [], true, params.includeText === true)));
    const snapshot = {
      createdAt: new Date().toISOString(),
      url: tab.page.url(),
      targets,
    };
    const payload = JSON.stringify(snapshot, null, 2);

    if (params.filename)
      await saveFile(response, params.filename, 'layout-snapshot', 'json', 'Layout snapshot', payload);
    else
      response.addTextResult(payload);
  }
});

const layoutDiff = defineTabTool({
  capability: 'styles',
  schema: {
    name: 'browser_layout_diff',
    title: 'Layout snapshot diff',
    description: 'Compare layout snapshots with a baseline.',
    inputSchema: z.object({
      baselinePath: z.string().describe('Path to baseline layout snapshot JSON'),
      targets: z.array(elementSchema).describe('Elements to capture layout for'),
      includeText: z.boolean().optional().describe('Include truncated text content.'),
      diffPath: z.string().optional().describe('Output path for diff JSON.'),
      failOnDiff: z.boolean().optional().describe('Fail when the page differs from the baseline (default true).'),
      maxDiffs: z.number().optional().describe('Maximum diff entries in response (default 20).'),
    }),
    type: 'assertion',
  },

  handle: async (tab, params, response) => {
    const baselineRaw = await readBaseline(response, params.baselinePath, 'Layout snapshot');
    if (baselineRaw === undefined)
      return;
    const resolvedTargets = await tab.targetLocators(params.targets);
    const targets = await Promise.all(resolvedTargets.map(({ locator }, index) =>
      collectForTarget(locator, params.targets[index].target, params.targets[index].element, [], true, params.includeText === true)));
    const snapshot = {
      createdAt: new Date().toISOString(),
      url: tab.page.url(),
      targets,
    };

    const baseline = JSON.parse(baselineRaw);
    const diffs = diffLayoutSnapshots(baseline, snapshot);
    if (!diffs.length) {
      response.addTextResult('Layout snapshot matches baseline.');
      return;
    }

    if (params.diffPath)
      await saveFile(response, params.diffPath, 'layout-diff', 'json', 'Layout snapshot diff', JSON.stringify(diffs, null, 2));

    const excerpt = diffs.slice(0, params.maxDiffs || 20).map(d => JSON.stringify(d)).join('\n');
    if (params.failOnDiff !== false) {
      response.addTextResult(excerpt);
      response.addError(`Layout snapshot differs from baseline (${diffs.length} changes).`);
    } else {
      response.addTextResult(`Layout snapshot differs from baseline (${diffs.length} changes).\n${excerpt}`);
    }
  }
});

export default [styleSnapshot, styleDiff, layoutSnapshot, layoutDiff];
