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

import { defineTabTool } from './tool';

import type { Response } from './response';
import type { Tab } from './tab';
import type * as playwright from '../../..';

function parseKeyValue(line: string): { key: string, value: string } | null {
  const match = line.match(/^\s*-\s*([^:]+):\s*(.*)$/);
  if (!match)
    return null;
  return { key: match[1].trim(), value: match[2].trim() };
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    return value.slice(1, -1);
  return value;
}

function parseArgs(text: string): Record<string, string> {
  const args: Record<string, string> = {};
  const regex = /(\w+)=(("[^"]*")|('[^']*')|\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)))
    args[match[1]] = stripQuotes(match[2]);
  return args;
}

function parseSteps(markdown: string): { setup: Record<string, string>, steps: string[] } {
  const lines = markdown.split(/\r?\n/);
  let section = '';
  const setup: Record<string, string> = {};
  const steps: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith('## ')) {
      section = line.trim().slice(3).toLowerCase();
      continue;
    }
    if (section === 'setup') {
      const kv = parseKeyValue(line);
      if (kv)
        setup[kv.key] = kv.value;
      continue;
    }
    if (section === 'steps') {
      const stepMatch = line.match(/^\s*(?:\d+\.|-)\s+(.*)$/);
      if (stepMatch)
        steps.push(stepMatch[1].trim());
    }
  }
  return { setup, steps };
}

async function resolveLocator(tab: Tab, args: Record<string, string>): Promise<playwright.Locator> {
  if (args.target)
    return (await tab.targetLocator({ target: args.target, element: args.element })).locator;
  if (args.role)
    return tab.page.getByRole(args.role as Parameters<typeof tab.page.getByRole>[0], { name: args.name || args.accessibleName });
  if (args.text)
    return tab.page.getByText(args.text);
  throw new Error('Unable to resolve locator (requires role/name, text, or target)');
}

async function runStep(tab: Tab, step: string, setup: Record<string, string>, artifacts: { files: { title: string, path: string }[] }, response: Response) {
  const [commandRaw, ...rest] = step.split(/\s+/);
  const command = commandRaw.toLowerCase();
  const restText = rest.join(' ');

  if (command === 'goto') {
    const target = stripQuotes(restText);
    const url = setup.baseUrl && target.startsWith('/') ? setup.baseUrl.replace(/\/$/, '') + target : target;
    await tab.navigate(url);
    return { action: 'goto', detail: url };
  }

  if (command === 'wait') {
    const waitArgs = parseArgs(restText);
    const ms = waitArgs.ms ? Number(waitArgs.ms) : Number(stripQuotes(restText));
    if (!Number.isFinite(ms))
      throw new Error(`Invalid wait duration: ${restText}`);
    await tab.page.waitForTimeout(ms);
    return { action: 'wait', detail: ms };
  }

  if (command === 'click') {
    const args = parseArgs(restText);
    const locator = await resolveLocator(tab, args);
    await tab.waitForCompletion(async () => {
      await locator.click();
    });
    return { action: 'click', detail: args.role || args.text || args.target || 'element' };
  }

  if (command === 'fill') {
    const args = parseArgs(restText);
    const locator = await resolveLocator(tab, args);
    if (!args.value)
      throw new Error('fill requires value=...');
    await tab.waitForCompletion(async () => {
      await locator.fill(args.value);
    });
    return { action: 'fill', detail: args.role || args.text || args.target || 'element' };
  }

  if (command === 'select') {
    const args = parseArgs(restText);
    const locator = await resolveLocator(tab, args);
    if (!args.value)
      throw new Error('select requires value=...');
    await tab.waitForCompletion(async () => {
      await locator.selectOption(args.value);
    });
    return { action: 'select', detail: args.value };
  }

  if (command === 'expect') {
    const args = parseArgs(restText);
    const locator = await resolveLocator(tab, args);
    const count = await locator.count();
    if (!count)
      throw new Error('Expected element not found');
    const visible = await locator.first().isVisible();
    if (!visible)
      throw new Error('Expected element not visible');
    return { action: 'expect', detail: args.role || args.text || args.target || 'element' };
  }

  if (command === 'snapshot') {
    const labelMatch = restText.match(/"([^"]+)"|'([^']+)'/);
    const label = labelMatch ? (labelMatch[1] || labelMatch[2]) : 'snapshot';
    const snapshot = await tab.captureSnapshot(undefined, undefined, undefined, undefined);
    const resolvedFile = await response.resolveClientOutputFile({ prefix: label.replace(/\s+/g, '-'), ext: 'yaml' }, `ARIA snapshot: ${label}`);
    await response.addFileResult(resolvedFile, snapshot.ariaSnapshot);
    artifacts.files.push({ title: `ARIA snapshot: ${label}`, path: resolvedFile.relativeName });
    return { action: 'snapshot', detail: label };
  }

  throw new Error(`Unknown command: ${command}`);
}

async function captureFailureAria(tab: Tab, step: string): Promise<string> {
  const args = parseArgs(step.split(/\s+/).slice(1).join(' '));
  let root: playwright.Locator | undefined;
  if (args.target) {
    try {
      const { locator } = await tab.targetLocator({ target: args.target, element: args.element });
      const container = locator.locator('xpath=..');
      root = await container.count() ? container : locator;
    } catch {
    }
  }
  return (await tab.captureSnapshot(root, 3, undefined, undefined)).ariaSnapshot;
}

const runScenario = defineTabTool({
  capability: 'scenarios',
  schema: {
    name: 'browser_run_scenario',
    title: 'Run scenario',
    description: 'Run a Markdown scenario file; debug mode records a trace.',
    inputSchema: z.object({
      file: z.string().describe('Path to scenario Markdown file'),
      mode: z.enum(['spec', 'debug']).optional().describe('Mode: spec (normal) or debug (record a trace).'),
      baseUrl: z.string().optional().describe('Base URL override'),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    const filePath = await response.resolveClientFilename(params.file);
    let markdown: string;
    try {
      markdown = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw error;
      response.addError(`Scenario file not found: ${params.file}`);
      return;
    }

    const { setup, steps } = parseSteps(markdown);
    if (params.baseUrl)
      setup.baseUrl = params.baseUrl;

    const artifacts = {
      files: [] as { title: string, path: string }[],
    };
    const summary: {
      file: string;
      status: 'passed' | 'failed';
      steps: { index: number, step: string, result: unknown }[];
      failedStep: { index: number, step: string } | null;
      error: string | null;
      artifacts: { type: string, title?: string, path: string }[];
    } = {
      file: params.file,
      status: 'passed',
      steps: [],
      failedStep: null,
      error: null,
      artifacts: [],
    };

    const traceFile = params.mode === 'debug'
      ? await response.resolveClientOutputFile({ prefix: 'scenario-trace', ext: 'zip' }, 'Playwright trace')
      : undefined;
    let traceStarted = false;
    let failureAriaExcerpt = '';
    try {
      if (traceFile) {
        try {
          await tab.page.context().tracing.start({ screenshots: true, snapshots: true });
        } catch (error) {
          throw new Error(`mode 'debug' records its own trace and could not start one (${error instanceof Error ? error.message : String(error)}). Stop the active trace with browser_stop_tracing, or run without mode 'debug'.`);
        }
        traceStarted = true;
      }

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        try {
          const result = await runStep(tab, step, setup, artifacts, response);
          summary.steps.push({ index: i + 1, step, result });
        } catch (error) {
          summary.status = 'failed';
          summary.failedStep = { index: i + 1, step };
          summary.error = error instanceof Error ? error.message : String(error);
          const failureAria = await captureFailureAria(tab, step).catch(() => '');
          failureAriaExcerpt = failureAria.slice(0, 4000) || '(ARIA snapshot unavailable)';
          const screenshot = await tab.page.screenshot({ type: 'png', fullPage: true });
          const screenshotFile = await response.resolveClientOutputFile({ prefix: 'scenario-failure', ext: 'png' }, 'Scenario failure screenshot');
          await response.addFileResult(screenshotFile, screenshot);
          summary.artifacts.push({ type: 'screenshot', path: screenshotFile.relativeName });

          const ariaFile = await response.resolveClientOutputFile({ prefix: 'scenario-failure', ext: 'yaml' }, 'Scenario failure ARIA excerpt');
          await response.addFileResult(ariaFile, failureAria);
          summary.artifacts.push({ type: 'aria', path: ariaFile.relativeName });
          break;
        }
      }
    } finally {
      if (traceStarted && traceFile) {
        await tab.page.context().tracing.stop({ path: traceFile.fileName });
        await response.addFileResult(traceFile, null);
        summary.artifacts.push({ type: 'trace', title: 'Playwright trace', path: traceFile.relativeName });
      }
    }

    for (const file of artifacts.files)
      summary.artifacts.push({ type: 'file', title: file.title, path: file.path });

    const summaryFile = await response.resolveClientOutputFile({ prefix: 'scenario-summary', ext: 'json' }, 'Scenario summary');
    await response.addFileResult(summaryFile, JSON.stringify(summary, null, 2));

    if (summary.status === 'passed') {
      response.addTextResult(`Scenario passed (${summary.steps.length} steps).`);
    } else if (summary.failedStep) {
      response.addError(`Scenario failed at step ${summary.failedStep.index}: ${summary.failedStep.step}\nError: ${summary.error}\nARIA excerpt:\n${failureAriaExcerpt}`);
    } else {
      response.addError('Scenario failed.');
    }
  }
});

export default [runScenario];
