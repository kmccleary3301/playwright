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
import os from 'os';
import path from 'path';

import { test, expect, parseResponse } from './fixtures';

test.skip(({ mcpBrowser }) => mcpBrowser !== 'chrome', 'QoL functional tests only need one installed browser.');

test('diff and style tools compare generated baselines using refs and selectors', async ({ startClient, server }, testInfo) => {
  server.setContent('/', `
    <main>
      <button id="target" style="color: rgb(255, 0, 0); margin: 4px">Styled target</button>
    </main>
  `, 'text/html');
  const { client } = await startClient({
    args: ['--caps=diffs,styles'],
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  const snapshotResponse = await client.callTool({
    name: 'browser_snapshot',
  });
  const snapshot = parseResponse(snapshotResponse, testInfo.outputPath()).inlineSnapshot || '';
  const buttonRef = snapshot.match(/button "Styled target" \[ref=(e\d+)\]/)?.[1];
  expect(buttonRef).toBeTruthy();

  const domSnapshotResponse = await client.callTool({
    name: 'browser_dom_snapshot',
    arguments: { target: buttonRef },
  });
  expect(parseResponse(domSnapshotResponse, testInfo.outputPath()).result).toContain('<button');
  const domBaseline = 'dom-baseline.html';
  await fs.promises.writeFile(testInfo.outputPath(domBaseline), parseResponse(domSnapshotResponse, testInfo.outputPath()).result || '', 'utf8');
  expect(await client.callTool({
    name: 'browser_dom_diff',
    arguments: { baselinePath: domBaseline, target: '#target' },
  })).toHaveResponse({
    result: 'DOM snapshot matches baseline.',
  });

  const styleSnapshotResponse = await client.callTool({
    name: 'browser_style_snapshot',
    arguments: {
      targets: [{ target: buttonRef, element: 'styled button' }, { target: '#target' }],
      includeText: true,
    },
  });
  const styleSnapshot = JSON.parse(parseResponse(styleSnapshotResponse, testInfo.outputPath()).result || '{}');
  expect(styleSnapshot.preset).toBe('typography');
  expect(styleSnapshot.properties).toContain('font-family');
  expect(styleSnapshot.targets.map((target: { target: string }) => target.target)).toEqual([buttonRef, '#target']);
  const styleBaseline = 'style-baseline.json';
  await fs.promises.writeFile(testInfo.outputPath(styleBaseline), JSON.stringify(styleSnapshot), 'utf8');
  expect(await client.callTool({
    name: 'browser_style_diff',
    arguments: {
      baselinePath: styleBaseline,
      targets: [{ target: buttonRef, element: 'styled button' }, { target: '#target' }],
      includeText: true,
    },
  })).toHaveResponse({
    result: 'Style snapshot matches baseline.',
  });
});

test('screenshot diff resolves a relative baseline from the client workspace', async ({ startClient, server }) => {
  server.setContent('/', `<body style="margin:0;background:white"><div style="width:20px;height:20px;background:black"></div></body>`, 'text/html');
  const { client } = await startClient({
    args: ['--caps=diffs'],
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  await client.callTool({
    name: 'browser_take_screenshot',
    arguments: { filename: 'baseline.png' },
  });

  expect(await client.callTool({
    name: 'browser_screenshot_diff',
    arguments: { baselinePath: 'baseline.png' },
  })).toHaveResponse({
    result: 'Screenshot matches baseline.',
  });
});

test('ARIA diff compares raw target-scoped snapshots', async ({ startClient, server }, testInfo) => {
  server.setContent('/', '<main><button id="target">ARIA target</button><p>Out of scope</p></main>', 'text/html');
  const { client } = await startClient({
    args: ['--caps=diffs'],
  });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const snapshotResponse = await client.callTool({
    name: 'browser_snapshot',
    arguments: { target: '#target' },
  });
  const baseline = parseResponse(snapshotResponse, testInfo.outputPath()).inlineSnapshot || '';
  expect(baseline).toContain('ARIA target');
  expect(baseline).not.toContain('Out of scope');
  await fs.promises.writeFile(testInfo.outputPath('aria-baseline.yml'), baseline, 'utf8');

  expect(await client.callTool({
    name: 'browser_aria_snapshot_diff',
    arguments: { baselinePath: 'aria-baseline.yml', target: '#target' },
  })).toHaveResponse({
    result: 'ARIA snapshot matches baseline.',
  });

  await fs.promises.writeFile(testInfo.outputPath('aria-baseline.yml'), baseline.replace('ARIA target', 'Different target'), 'utf8');
  const mismatch = await client.callTool({
    name: 'browser_aria_snapshot_diff',
    arguments: { baselinePath: 'aria-baseline.yml', target: '#target' },
  });
  expect(parseResponse(mismatch, testInfo.outputPath()).error).toContain('ARIA snapshot differs from baseline.');
  expect(mismatch.isError).toBe(true);
});

test('layout snapshots compare matching and changed target metrics', async ({ startClient, server }, testInfo) => {
  server.setContent('/', '<div id="target" style="width:40px;height:20px">Layout target</div>', 'text/html');
  const { client } = await startClient({
    args: ['--caps=styles'],
  });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const snapshotResponse = await client.callTool({
    name: 'browser_layout_snapshot',
    arguments: { targets: [{ target: '#target' }] },
  });
  const snapshot = JSON.parse(parseResponse(snapshotResponse, testInfo.outputPath()).result || '{}');
  expect(snapshot.targets[0].target).toBe('#target');
  const baselinePath = 'layout-baseline.json';
  await fs.promises.writeFile(testInfo.outputPath(baselinePath), JSON.stringify(snapshot), 'utf8');

  expect(await client.callTool({
    name: 'browser_layout_diff',
    arguments: { baselinePath, targets: [{ target: '#target' }] },
  })).toHaveResponse({
    result: 'Layout snapshot matches baseline.',
  });

  snapshot.targets[0].layout.width++;
  await fs.promises.writeFile(testInfo.outputPath(baselinePath), JSON.stringify(snapshot), 'utf8');
  const mismatch = await client.callTool({
    name: 'browser_layout_diff',
    arguments: { baselinePath, targets: [{ target: '#target' }] },
  });
  expect(mismatch.isError).toBe(true);
  expect(parseResponse(mismatch, testInfo.outputPath()).error).toContain('Layout snapshot differs from baseline');
  expect(parseResponse(mismatch, testInfo.outputPath()).result).toContain('"target":"#target"');
});

test('QoL tools reject absolute input paths outside the client roots', async ({ startClient, server }, testInfo) => {
  server.setContent('/', '<button id="target">Ready</button>', 'text/html');
  const outsideDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'playwright-mcp-qol-'));
  try {
    const baselinePath = path.join(outsideDirectory, 'baseline');
    const scenarioPath = path.join(outsideDirectory, 'scenario.md');
    await fs.promises.writeFile(baselinePath, '<button>Ready</button>', 'utf8');
    await fs.promises.writeFile(scenarioPath, '## Steps\n1. goto /', 'utf8');

    const { client } = await startClient({
      args: ['--caps=diffs,styles,scenarios'],
    });
    await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

    for (const callTool of [
      () => client.callTool({ name: 'browser_dom_diff', arguments: { baselinePath } }),
      () => client.callTool({ name: 'browser_style_diff', arguments: { baselinePath, targets: [{ target: '#target' }] } }),
      () => client.callTool({ name: 'browser_screenshot_diff', arguments: { baselinePath } }),
      () => client.callTool({ name: 'browser_run_scenario', arguments: { file: scenarioPath } }),
    ]) {
      const result = await callTool();
      expect(result.isError).toBe(true);
      expect(parseResponse(result, testInfo.outputPath()).error).toMatch(/File access denied: .* is outside allowed roots/);
    }
  } finally {
    await fs.promises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('diff tools report missing baseline files as concise errors', async ({ startClient, server }, testInfo) => {
  server.setContent('/', '<button id="target">Ready</button>', 'text/html');
  const { client } = await startClient({
    args: ['--caps=diffs'],
  });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const result = await client.callTool({
    name: 'browser_dom_diff',
    arguments: { baselinePath: 'missing-baseline.html' },
  });
  expect(result.isError).toBe(true);
  expect(parseResponse(result, testInfo.outputPath()).error).toContain('DOM baseline file not found: missing-baseline.html');
});

test('scenario failures include inline step diagnostics and debug mode links a trace', async ({ startClient, server }, testInfo) => {
  server.setContent('/', `<button>Scenario ready</button>`, 'text/html');
  await fs.promises.writeFile(testInfo.outputPath('scenario.md'), `
## Steps
1. goto /
2. expect text="Scenario ready"
`, 'utf8');
  await fs.promises.writeFile(testInfo.outputPath('scenario-failure.md'), `
## Steps
1. expect text="Missing scenario text"
`, 'utf8');

  const { client } = await startClient({
    args: ['--caps=scenarios,perf'],
  });

  const debugResponse = await client.callTool({
    name: 'browser_run_scenario',
    arguments: { file: 'scenario.md', baseUrl: server.PREFIX, mode: 'debug' },
  });
  const debugResult = parseResponse(debugResponse, testInfo.outputPath()).result || '';
  expect(debugResult).toContain('Scenario passed (2 steps).');
  expect(debugResult).toMatch(/Playwright trace.*\.zip/);

  const failureResponse = await client.callTool({
    name: 'browser_run_scenario',
    arguments: { file: 'scenario-failure.md', baseUrl: server.PREFIX },
  });
  const failure = parseResponse(failureResponse, testInfo.outputPath());
  expect(failureResponse.isError).toBe(true);
  expect(failure.error).toContain('step 1');
  expect(failure.error).toContain('expect text="Missing scenario text"');
  expect(failure.error).toContain('Expected element not found');
  expect(failure.error).toContain('ARIA excerpt:');
  expect(failure.result).toContain('Scenario failure screenshot');
  expect(failure.result).toContain('Scenario failure ARIA excerpt');

  const perfResponse = await client.callTool({
    name: 'browser_collect_longtasks',
    arguments: { durationMs: 1 },
  });
  const result = parseResponse(perfResponse, testInfo.outputPath()).result || '{}';
  const parsedResult = JSON.parse(result);
  expect(parsedResult.durationMs).toBe(1);
  expect(typeof parsedResult.count).toBe('number');
  expect(typeof parsedResult.totalBlockingTimeMs).toBe('number');
});
