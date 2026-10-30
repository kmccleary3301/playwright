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

import { PNG } from '../../utilsBundle';
import * as z from 'zod';

import { optionalElementSchema } from './snapshot';
import { defineTabTool } from './tool';

import type { Response } from './response';
import type * as playwright from '../../..';

async function decodePng(buffer: Buffer): Promise<PNG> {
  return await new Promise<PNG>((resolve, reject) => {
    new PNG().parse(buffer, (error, png) => {
      if (error)
        reject(error);
      else
        resolve(png);
    });
  });
}

async function encodePng(image: PNG): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of image.pack())
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function saveImage(response: Response, filename: string, prefix: string, title: string, image: Buffer) {
  const resolvedFile = await response.resolveClientOutputFile({ prefix, ext: 'png', suggestedFilename: filename }, title);
  await response.addFileResult(resolvedFile, image);
}

function comparePixels(actual: Buffer, expected: Buffer, diff: Buffer, width: number, height: number, threshold: number): number {
  let diffPixels = 0;
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    const redDelta = Math.abs(actual[offset] - expected[offset]);
    const greenDelta = Math.abs(actual[offset + 1] - expected[offset + 1]);
    const blueDelta = Math.abs(actual[offset + 2] - expected[offset + 2]);
    const alphaDelta = Math.abs(actual[offset + 3] - expected[offset + 3]);
    const different = redDelta > threshold || greenDelta > threshold || blueDelta > threshold || alphaDelta > threshold;
    diff[offset] = different ? 255 : actual[offset];
    diff[offset + 1] = different ? 0 : actual[offset + 1];
    diff[offset + 2] = different ? 0 : actual[offset + 2];
    diff[offset + 3] = 255;
    if (different)
      diffPixels++;
  }
  return diffPixels;
}

async function withTemporaryStyle(page: playwright.Page, css: string, callback: () => Promise<Buffer>): Promise<Buffer> {
  const tag = await page.addStyleTag({ content: css });
  try {
    return await callback();
  } finally {
    await tag.evaluate((node: HTMLElement) => node.remove()).catch(() => {});
  }
}

const screenshotDiff = defineTabTool({
  capability: 'diffs',
  schema: {
    name: 'browser_screenshot_diff',
    title: 'Screenshot diff',
    description: 'Compare a screenshot with a PNG baseline; threshold is a per-channel delta (0-255, default 1).',
    inputSchema: optionalElementSchema.extend({
      baselinePath: z.string().describe('Path to baseline PNG image'),
      fullPage: z.boolean().optional().describe('Capture full page; ignored for target screenshots.'),
      threshold: z.number().optional().describe('Max per-channel color delta, 0-255 (default 1).'),
      diffPath: z.string().optional().describe('Output path for the diff image.'),
      currentPath: z.string().optional().describe('Output path for the current screenshot.'),
      highlight: z.boolean().optional().describe('Highlight the target element before capture.'),
      disableAnimations: z.boolean().optional().describe('Disable CSS animations/transitions before capture.'),
      failOnDiff: z.boolean().optional().describe('Fail when the page differs from the baseline (default true).'),
    }),
    type: 'assertion',
  },

  handle: async (tab, params, response) => {
    const baselinePath = await response.resolveClientFilename(params.baselinePath);
    let baselineBuffer: Buffer;
    try {
      baselineBuffer = await fs.promises.readFile(baselinePath);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw error;
      response.addError(`Screenshot baseline file not found: ${params.baselinePath}`);
      return;
    }
    const expected = await decodePng(baselineBuffer);
    const target = params.target ? await tab.targetLocator({ target: params.target, element: params.element }) : undefined;
    const options = {
      type: 'png',
      fullPage: params.fullPage === true && !target,
    } as const;

    const capture = async () => {
      if (target)
        return await target.locator.screenshot(options);
      return await tab.page.screenshot(options);
    };

    const highlightCSS = '[data-mcp-highlight="true"]{outline:2px solid #ff3b30 !important;outline-offset:2px !important;}';
    let buffer: Buffer;

    if (params.disableAnimations) {
      buffer = await withTemporaryStyle(tab.page, '*{animation:none !important;transition:none !important;}', async () => {
        if (params.highlight && target) {
          await target.locator.evaluate((el: HTMLElement) => el.setAttribute('data-mcp-highlight', 'true'));
          return await withTemporaryStyle(tab.page, highlightCSS, async () => {
            try {
              return await capture();
            } finally {
              await target.locator.evaluate((el: HTMLElement) => el.removeAttribute('data-mcp-highlight')).catch(() => {});
            }
          });
        }
        return await capture();
      });
    } else if (params.highlight && target) {
      buffer = await withTemporaryStyle(tab.page, highlightCSS, async () => {
        await target.locator.evaluate((el: HTMLElement) => el.setAttribute('data-mcp-highlight', 'true'));
        try {
          return await capture();
        } finally {
          await target.locator.evaluate((el: HTMLElement) => el.removeAttribute('data-mcp-highlight')).catch(() => {});
        }
      });
    } else {
      buffer = await capture();
    }

    const actual = await decodePng(buffer);
    if (expected.width !== actual.width || expected.height !== actual.height) {
      if (params.currentPath)
        await saveImage(response, params.currentPath, 'screenshot-current', 'Current screenshot', buffer);
      response.addError(`Screenshot size mismatch: expected ${expected.width}x${expected.height}, got ${actual.width}x${actual.height}.`);
      return;
    }

    const diffImage = new PNG({ width: expected.width, height: expected.height });
    const diffPixels = comparePixels(actual.data, expected.data, diffImage.data, expected.width, expected.height, params.threshold ?? 1);
    const totalPixels = expected.width * expected.height;
    const diffPercent = (diffPixels / totalPixels) * 100;

    if (params.currentPath)
      await saveImage(response, params.currentPath, 'screenshot-current', 'Current screenshot', buffer);

    if (diffPixels === 0) {
      response.addTextResult('Screenshot matches baseline.');
      return;
    }

    if (params.diffPath)
      await saveImage(response, params.diffPath, 'screenshot-diff', 'Screenshot diff', await encodePng(diffImage));

    const message = `Screenshot differs from baseline: ${diffPixels} pixels (${diffPercent.toFixed(2)}%).`;
    if (params.failOnDiff !== false)
      response.addError(message);
    else
      response.addTextResult(message);
  }
});

export default [screenshotDiff];

