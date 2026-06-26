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

import * as z from 'zod';

import { defineTabTool } from './tool';
import { outputDir as outputDirForClient } from './context';

import type { Context } from './context';
import type { Tab } from './tab';

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
  ref: string;
  element: string;
  tag?: string;
  id?: string | null;
  className?: string | null;
  text?: string | null;
  styles?: Record<string, string>;
  layout?: LayoutMetrics;
};

type SnapshotDiff = {
  ref: string;
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
  ref: z.string(),
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


function resolveMaybeRelative(context: Context, inputPath: string): string {
  if (path.isAbsolute(inputPath))
    return inputPath;
  const cwdPath = path.resolve(process.cwd(), inputPath);
  if (fs.existsSync(cwdPath))
    return cwdPath;
  const outDir = outputDirForClient(context.options);
  return path.resolve(outDir, inputPath);
}

function resolveProperties(params: { preset?: StylePreset, properties?: string[] }): string[] {
  const preset = params.preset ? STYLE_PRESETS[params.preset] : [];
  const combined = [...new Set([...(params.properties || []), ...preset])];
  if (combined.length)
    return combined;
  return [...STYLE_PRESETS.typography];
}

async function collectForTarget(
  tab: Tab,
  target: { ref: string, element: string },
  props: string[],
  includeLayout: boolean,
  includeText: boolean
): Promise<Omit<CapturedTarget, 'ref' | 'element'>> {
  const { locator } = await tab.targetLocator({ target: target.ref, element: target.element });
  return await locator.evaluate((el, options) => {
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
      styles,
      layout: options.includeLayout ? layout : undefined,
    };
  }, { props, includeLayout, includeText });
}

function diffStyleSnapshots(expected: unknown, actual: unknown): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = [];
  const expectedByRef = new Map(snapshotTargets(expected).map(target => [target.ref, target]));
  const actualByRef = new Map(snapshotTargets(actual).map(target => [target.ref, target]));
  for (const [ref, expectedTarget] of expectedByRef.entries()) {
    const actualTarget = actualByRef.get(ref);
    if (!actualTarget) {
      diffs.push({ ref, type: 'missing', message: 'Target missing in current snapshot' });
      continue;
    }
    const expectedStyles = expectedTarget.styles || {};
    const actualStyles = actualTarget.styles || {};
    for (const key of Object.keys(expectedStyles)) {
      if (expectedStyles[key] !== actualStyles[key])
        diffs.push({ ref, type: 'style', property: key, expected: expectedStyles[key], actual: actualStyles[key] });
    }
  }
  for (const [ref] of actualByRef.entries()) {
    if (!expectedByRef.has(ref))
      diffs.push({ ref, type: 'extra', message: 'Target missing in baseline snapshot' });
  }
  return diffs;
}

function diffLayoutSnapshots(expected: unknown, actual: unknown): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = [];
  const expectedByRef = new Map(snapshotTargets(expected).map(target => [target.ref, target]));
  const actualByRef = new Map(snapshotTargets(actual).map(target => [target.ref, target]));
  for (const [ref, expectedTarget] of expectedByRef.entries()) {
    const actualTarget = actualByRef.get(ref);
    if (!actualTarget) {
      diffs.push({ ref, type: 'missing', message: 'Target missing in current snapshot' });
      continue;
    }
    const expectedLayout: Partial<LayoutMetrics> = expectedTarget.layout || {};
    const actualLayout: Partial<LayoutMetrics> = actualTarget.layout || {};
    for (const key of Object.keys(expectedLayout) as (keyof LayoutMetrics)[]) {
      if (expectedLayout[key] !== actualLayout[key])
        diffs.push({ ref, type: 'layout', property: key, expected: expectedLayout[key], actual: actualLayout[key] });
    }
  }
  for (const [ref] of actualByRef.entries()) {
    if (!expectedByRef.has(ref))
      diffs.push({ ref, type: 'extra', message: 'Target missing in baseline snapshot' });
  }
  return diffs;
}

const targetSchema = z.object({
  element: z.string().describe('Human-readable element description'),
  ref: z.string().describe('Exact target element reference'),
});

const styleSnapshot = defineTabTool({
  capability: 'styles',
  schema: {
    name: 'browser_style_snapshot',
    title: 'Style snapshot',
    description: 'Capture computed style snapshot for specific elements',
    inputSchema: z.object({
      targets: z.array(targetSchema).describe('Elements to capture styles for'),
      properties: z.array(z.string()).optional().describe('CSS properties to capture'),
      preset: z.enum(['typography', 'box', 'layout', 'codeblock']).optional().describe('Preset property group'),
      includeLayout: z.boolean().optional().describe('Include layout metrics in snapshot'),
      includeText: z.boolean().optional().describe('Include truncated text content'),
      filename: z.string().optional().describe('File name to save snapshot to'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const props = resolveProperties(params);
    const targets: CapturedTarget[] = [];
    for (const target of params.targets)
      targets.push({ ref: target.ref, element: target.element, ...(await collectForTarget(tab, target, props, params.includeLayout === true, params.includeText === true)) });

    const snapshot = {
      createdAt: new Date().toISOString(),
      url: tab.page.url(),
      properties: props,
      targets,
    };
    const payload = JSON.stringify(snapshot, null, 2);

    if (params.filename) {
      const fileName = await response.resolveClientFilename(params.filename);
      await fs.promises.writeFile(fileName, payload, 'utf8');
      response.addTextResult(`Saved style snapshot to ${fileName}`);
    } else {
      response.addTextResult(payload);
    }
  }
});

const styleDiff = defineTabTool({
  capability: 'styles',
  schema: {
    name: 'browser_style_diff',
    title: 'Style snapshot diff',
    description: 'Compare computed style snapshot against baseline',
    inputSchema: z.object({
      baselinePath: z.string().describe('Path to baseline style snapshot JSON'),
      targets: z.array(targetSchema).describe('Elements to capture styles for'),
      properties: z.array(z.string()).optional().describe('CSS properties to capture'),
      preset: z.enum(['typography', 'box', 'layout', 'codeblock']).optional().describe('Preset property group'),
      includeLayout: z.boolean().optional().describe('Include layout metrics in snapshot'),
      includeText: z.boolean().optional().describe('Include truncated text content'),
      diffPath: z.string().optional().describe('File path to save diff JSON'),
      failOnDiff: z.boolean().optional().describe('Whether to fail when diff is detected (default true)'),
      maxDiffs: z.number().optional().describe('Maximum diffs to include in response'),
    }),
    type: 'assertion',
  },

  handle: async (tab, params, response) => {
    const props = resolveProperties(params);
    const targets: CapturedTarget[] = [];
    for (const target of params.targets)
      targets.push({ ref: target.ref, element: target.element, ...(await collectForTarget(tab, target, props, params.includeLayout === true, params.includeText === true)) });

    const snapshot = {
      createdAt: new Date().toISOString(),
      url: tab.page.url(),
      properties: props,
      targets,
    };

    const baselinePath = resolveMaybeRelative(tab.context, params.baselinePath);
    const baselineRaw = await fs.promises.readFile(baselinePath, 'utf8');
    const baseline = JSON.parse(baselineRaw);
    const diffs = diffStyleSnapshots(baseline, snapshot);

    if (!diffs.length) {
      response.addTextResult('Style snapshot matches baseline.');
      return;
    }

    if (params.diffPath) {
      const diffFile = await response.resolveClientFilename(params.diffPath);
      await fs.promises.writeFile(diffFile, JSON.stringify(diffs, null, 2), 'utf8');
    }

    const maxDiffs = params.maxDiffs || 20;
    const excerpt = diffs.slice(0, maxDiffs).map(d => JSON.stringify(d)).join('\n');
    const message = `Style snapshot differs from baseline (${diffs.length} changes).\n${excerpt}`;
    if (params.failOnDiff !== false)
      response.addError(message);
    else
      response.addTextResult(message);
  }
});

const layoutSnapshot = defineTabTool({
  capability: 'styles',
  schema: {
    name: 'browser_layout_snapshot',
    title: 'Layout snapshot',
    description: 'Capture layout metrics for specific elements',
    inputSchema: z.object({
      targets: z.array(targetSchema).describe('Elements to capture layout for'),
      includeText: z.boolean().optional().describe('Include truncated text content'),
      filename: z.string().optional().describe('File name to save snapshot to'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const targets: CapturedTarget[] = [];
    for (const target of params.targets) {
      const { locator } = await tab.targetLocator({ target: target.ref, element: target.element });
      const payload = await locator.evaluate((el, options) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        return {
          tag: (el as HTMLElement).tagName,
          id: (el as HTMLElement).id || null,
          className: typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : null,
          text: options.includeText ? ((el as HTMLElement).textContent || '').trim().slice(0, 200) : null,
          layout: {
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
          }
        };
      }, { includeText: params.includeText === true });
      targets.push({ ref: target.ref, element: target.element, ...payload });
    }

    const snapshot = {
      createdAt: new Date().toISOString(),
      url: tab.page.url(),
      targets,
    };
    const payload = JSON.stringify(snapshot, null, 2);

    if (params.filename) {
      const fileName = await response.resolveClientFilename(params.filename);
      await fs.promises.writeFile(fileName, payload, 'utf8');
      response.addTextResult(`Saved layout snapshot to ${fileName}`);
    } else {
      response.addTextResult(payload);
    }
  }
});

const layoutDiff = defineTabTool({
  capability: 'styles',
  schema: {
    name: 'browser_layout_diff',
    title: 'Layout snapshot diff',
    description: 'Compare layout snapshot against baseline',
    inputSchema: z.object({
      baselinePath: z.string().describe('Path to baseline layout snapshot JSON'),
      targets: z.array(targetSchema).describe('Elements to capture layout for'),
      includeText: z.boolean().optional().describe('Include truncated text content'),
      diffPath: z.string().optional().describe('File path to save diff JSON'),
      failOnDiff: z.boolean().optional().describe('Whether to fail when diff is detected (default true)'),
      maxDiffs: z.number().optional().describe('Maximum diffs to include in response'),
    }),
    type: 'assertion',
  },

  handle: async (tab, params, response) => {
    const targets: CapturedTarget[] = [];
    for (const target of params.targets) {
      const { locator } = await tab.targetLocator({ target: target.ref, element: target.element });
      const payload = await locator.evaluate((el, options) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        return {
          tag: (el as HTMLElement).tagName,
          id: (el as HTMLElement).id || null,
          className: typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : null,
          text: options.includeText ? ((el as HTMLElement).textContent || '').trim().slice(0, 200) : null,
          layout: {
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
          }
        };
      }, { includeText: params.includeText === true });
      targets.push({ ref: target.ref, element: target.element, ...payload });
    }

    const snapshot = {
      createdAt: new Date().toISOString(),
      url: tab.page.url(),
      targets,
    };

    const baselinePath = resolveMaybeRelative(tab.context, params.baselinePath);
    const baselineRaw = await fs.promises.readFile(baselinePath, 'utf8');
    const baseline = JSON.parse(baselineRaw);
    const diffs = diffLayoutSnapshots(baseline, snapshot);

    if (!diffs.length) {
      response.addTextResult('Layout snapshot matches baseline.');
      return;
    }

    if (params.diffPath) {
      const diffFile = await response.resolveClientFilename(params.diffPath);
      await fs.promises.writeFile(diffFile, JSON.stringify(diffs, null, 2), 'utf8');
    }

    const maxDiffs = params.maxDiffs || 20;
    const excerpt = diffs.slice(0, maxDiffs).map(d => JSON.stringify(d)).join('\n');
    const message = `Layout snapshot differs from baseline (${diffs.length} changes).\n${excerpt}`;
    if (params.failOnDiff !== false)
      response.addError(message);
    else
      response.addTextResult(message);
  }
});

export default [styleSnapshot, styleDiff, layoutSnapshot, layoutDiff];
