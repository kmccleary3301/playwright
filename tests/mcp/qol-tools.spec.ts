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

import { test, expect, parseResponse } from './fixtures';

test.skip(({ mcpBrowser }) => mcpBrowser !== 'chrome', 'QoL functional tests only need one installed browser.');

test('diff and style tools compare generated baselines', async ({ startClient, server }, testInfo) => {
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
  });
  const domBaseline = testInfo.outputPath('dom-baseline.html');
  await fs.promises.writeFile(domBaseline, parseResponse(domSnapshotResponse, testInfo.outputPath()).result || '', 'utf8');
  expect(await client.callTool({
    name: 'browser_dom_diff',
    arguments: { baselinePath: domBaseline },
  })).toHaveResponse({
    result: 'DOM snapshot matches baseline.',
  });

  const styleSnapshotResponse = await client.callTool({
    name: 'browser_style_snapshot',
    arguments: {
      targets: [{ ref: buttonRef, element: 'styled button' }],
      properties: ['color'],
      includeText: true,
    },
  });
  const styleBaseline = testInfo.outputPath('style-baseline.json');
  await fs.promises.writeFile(styleBaseline, parseResponse(styleSnapshotResponse, testInfo.outputPath()).result || '', 'utf8');
  expect(await client.callTool({
    name: 'browser_style_diff',
    arguments: {
      baselinePath: styleBaseline,
      targets: [{ ref: buttonRef, element: 'styled button' }],
      properties: ['color'],
      includeText: true,
    },
  })).toHaveResponse({
    result: 'Style snapshot matches baseline.',
  });
});

test('screenshot diff accepts a matching generated baseline', async ({ startClient, server }, testInfo) => {
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
    arguments: { baselinePath: path.join(testInfo.outputPath(), 'baseline.png') },
  })).toHaveResponse({
    result: 'Screenshot matches baseline.',
  });
});

test('scenario and perf tools run through MCP', async ({ startClient, server }, testInfo) => {
  server.setContent('/', `<button>Scenario ready</button>`, 'text/html');
  const scenarioFile = testInfo.outputPath('scenario.md');
  await fs.promises.writeFile(scenarioFile, `
## Steps
1. goto /
2. expect text="Scenario ready"
`, 'utf8');

  const { client } = await startClient({
    args: ['--caps=scenarios,perf'],
  });

  expect(await client.callTool({
    name: 'browser_run_scenario',
    arguments: { file: scenarioFile, baseUrl: server.PREFIX },
  })).toHaveResponse({
    result: expect.stringContaining('Scenario passed.'),
  });

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
