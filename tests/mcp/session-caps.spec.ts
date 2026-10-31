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

import { ChildProcess, spawn } from 'child_process';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { test as baseTest, expect, mcpServerPath } from './fixtures';
import { inheritAndCleanEnv } from '../config/utils';

const test = baseTest.extend<{ serverEndpoint: (args: string[]) => Promise<URL> }>({
  serverEndpoint: async ({ mcpHeadless }, use, testInfo) => {
    let cp: ChildProcess | undefined;
    const userDataDir = testInfo.outputPath('user-data-dir');
    await use(async (args: string[]) => {
      if (cp)
        throw new Error('Process already running');

      cp = spawn('node', [
        ...mcpServerPath,
        '--port=0',
        '--user-data-dir=' + userDataDir,
        ...(mcpHeadless ? ['--headless'] : []),
        ...args,
      ], {
        stdio: 'pipe',
        env: inheritAndCleanEnv({ DEBUG: 'pw:mcp:test', DEBUG_COLORS: '0', DEBUG_HIDE_DATE: '1' }),
        cwd: testInfo.outputPath(),
      });
      let stderr = '';
      return new URL(await new Promise<string>(resolve => cp!.stderr?.on('data', data => {
        stderr += data.toString();
        const match = stderr.match(/Listening on (http:\/\/.*)/);
        if (match)
          resolve(match[1]);
      })));
    });
    cp?.kill('SIGTERM');
  },
});

test('streamable HTTP sessions select enabled capability groups', async ({ serverEndpoint }) => {
  const serverUrl = await serverEndpoint(['--caps=diffs,styles']);
  const diffSession = await connectStreamable(new URL('/mcp?caps=diffs', serverUrl));
  const allSession = await connectStreamable(new URL('/mcp', serverUrl));
  const coreSession = await connectStreamable(new URL('/mcp?caps=', serverUrl));
  try {
    const diffTools = await diffSession.client.listTools();
    expect(diffTools.tools.map(tool => tool.name)).toContain('browser_dom_diff');
    expect(diffTools.tools.map(tool => tool.name)).not.toContain('browser_css_rules');
    const diffInstructions = diffSession.client.getInstructions() ?? '';
    expect(diffInstructions.length).toBeLessThanOrEqual(4000);
    expect(diffInstructions).toContain('browser_snapshot with depth=3');
    expect(diffInstructions).toContain('browser_dom_diff');
    expect(diffInstructions).not.toContain('browser_css_rules');
    expect(diffInstructions).toMatch(/Not enabled in this session:.*styles \(/);

    const unavailableStyleTool = await diffSession.client.callTool({ name: 'browser_css_rules', arguments: {} });
    expect(unavailableStyleTool.isError).toBe(true);

    const allTools = await allSession.client.listTools();
    expect(allTools.tools.map(tool => tool.name)).toContain('browser_dom_diff');
    expect(allTools.tools.map(tool => tool.name)).toContain('browser_css_rules');
    expect(allSession.client.getInstructions()).toContain('browser_css_rules');
    expect(allSession.client.getInstructions()).not.toContain('styles (');

    const coreTools = await coreSession.client.listTools();
    expect(coreTools.tools.map(tool => tool.name)).toContain('browser_snapshot');
    expect(coreTools.tools.map(tool => tool.name)).not.toContain('browser_dom_diff');
    expect(coreTools.tools.map(tool => tool.name)).not.toContain('browser_css_rules');
    expect(coreSession.client.getInstructions()).not.toContain('browser_dom_diff');
    expect(coreSession.client.getInstructions()).toMatch(/Not enabled in this session:.*diffs \(.*styles \(/);
  } finally {
    await Promise.all([diffSession.close(), allSession.close(), coreSession.close()]);
  }
});

test('legacy SSE session uses caps from its endpoint URL', async ({ serverEndpoint }) => {
  const serverUrl = await serverEndpoint(['--caps=diffs,styles']);
  const transport = new SSEClientTransport(new URL('/sse?caps=diffs', serverUrl));
  const client = new Client({ name: 'session-caps-sse-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toContain('browser_dom_diff');
    expect(tools.tools.map(tool => tool.name)).not.toContain('browser_css_rules');
    expect(client.getInstructions()).toContain('browser_dom_diff');
    expect(client.getInstructions()).not.toContain('browser_css_rules');
  } finally {
    await client.close();
  }
});

test('HTTP rejects capability groups not enabled on the server', async ({ serverEndpoint }) => {
  const serverUrl = await serverEndpoint(['--caps=diffs,styles']);
  const response = await fetch(new URL('/mcp?caps=pdf', serverUrl), {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'session-caps-test', version: '1.0.0' },
      },
    }),
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain('Allowed caps: diffs, styles');
});

async function connectStreamable(url: URL) {
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: 'session-caps-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await transport.terminateSession();
      await client.close();
    },
  };
}
