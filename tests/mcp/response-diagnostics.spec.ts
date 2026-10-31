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

import { test, expect } from './fixtures';
import type { CompatibilityCallToolResult } from '@modelcontextprotocol/sdk/types.js';

type TextContent = { type: 'text', text: string };

function isTextContent(content: unknown): content is TextContent {
  if (typeof content !== 'object' || content === null || !('type' in content) || content.type !== 'text')
    return false;
  return 'text' in content && typeof content.text === 'string';
}

function responseText(response: CompatibilityCallToolResult): string {
  if (!('content' in response) || !Array.isArray(response.content))
    throw new Error('Tool call result did not include content');
  return response.content.filter(isTextContent).map(content => content.text).join('\n');
}

test('new console, page, and HTTP errors are shown inline while successful activity is omitted', async ({ client, server }) => {
  server.setContent('/', `
    <title>Diagnostics</title>
    <button>Run</button>
    <script>
      document.querySelector('button').addEventListener('click', () => {
        console.log('successful console log');
        console.error('console failure');
        fetch('/successful');
        fetch('/failed');
        setTimeout(() => { throw new Error('uncaught page failure'); }, 0);
      });
    </script>
  `, 'text/html');
  server.setRoute('/successful', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  server.setRoute('/failed', (_req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('failed');
  });

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const output = responseText(await client.callTool({
    name: 'browser_click',
    arguments: { target: 'e2', element: 'Run button' },
  }));

  expect(output).toContain('### New errors');
  expect(output).toContain('- Console errors:');
  expect(output).toContain('console failure');
  expect(output).toContain('- Uncaught page errors:');
  expect(output).toContain('uncaught page failure');
  expect(output).toContain('- Failed requests:');
  expect(output).toContain('/failed => [500]');
  expect(output).not.toContain('successful console log');
  expect(output).not.toContain('/successful');
});

test('inline diagnostics truncate each category after ten entries', async ({ client, server }) => {
  server.setContent('/', `
    <button>Run</button>
    <script>
      document.querySelector('button').addEventListener('click', () => {
        for (let i = 0; i < 12; i++)
          console.error('diagnostic ' + i);
      });
    </script>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const output = responseText(await client.callTool({
    name: 'browser_click',
    arguments: { target: 'e2', element: 'Run button' },
  }));

  expect(output.match(/  - diagnostic \d+/g)).toHaveLength(10);
  expect(output).toContain('  - (+2 more)');
});

test('inline diagnostics are reported only once', async ({ client, server }) => {
  server.setContent('/', `
    <button>Run</button>
    <script>
      document.querySelector('button').addEventListener('click', () => {
        if (!window.didEmitError) {
          window.didEmitError = true;
          console.error('one-shot error');
        }
      });
    </script>
  `, 'text/html');

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const first = responseText(await client.callTool({
    name: 'browser_click',
    arguments: { target: 'e2', element: 'Run button' },
  }));
  const second = responseText(await client.callTool({
    name: 'browser_click',
    arguments: { target: 'e2', element: 'Run button' },
  }));

  expect(first).toContain('one-shot error');
  expect(second).not.toContain('one-shot error');
});

test('browser_navigate waitUntil load waits for delayed resources', async ({ client, server }) => {
  test.slow();
  server.setRoute('/delayed.js', (_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end("document.querySelector('p').textContent = 'delayed resource loaded';");
    }, 6000);
  });
  // An async script delays the load event but not DOMContentLoaded.
  server.setContent('/', `
    <title>Delayed resource</title>
    <p>Waiting for the script</p>
    <script async src="/delayed.js"></script>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX, waitUntil: 'load' },
  });

  const state = responseText(await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: `() => document.querySelector('p').textContent` },
  }));
  expect(state).toContain('delayed resource loaded');
});

test('browser_wait_for loadState networkidle waits for pending fetches', async ({ client, server }) => {
  server.setContent('/', `
    <script>
      fetch('/delayed-fetch').then(() => {
        document.body.textContent = 'fetch completed';
      });
    </script>
  `, 'text/html');
  server.setRoute('/delayed-fetch', (_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('done');
    }, 1000);
  });

  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const output = responseText(await client.callTool({
    name: 'browser_wait_for',
    arguments: { loadState: 'networkidle' },
  }));

  expect(output).toContain("await page.waitForLoadState('networkidle');");
  const state = responseText(await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.body.textContent' },
  }));
  expect(state).toContain('fetch completed');
});
