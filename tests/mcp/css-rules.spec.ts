/*
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

test.use({ mcpCaps: ['styles'] });
test.skip(({ mcpBrowser }) => !['chrome', 'chromium', 'msedge'].includes(mcpBrowser ?? ''), 'browser_css_rules reads rules over CDP, so it only runs in Chromium');

test('browser_css_rules reports external, inline stylesheet, and element style sources', async ({ client, server }) => {
  const externalCss = '#target { color: rebeccapurple; }\n';
  server.setContent('/styles.css', externalCss, 'text/css');
  server.setContent('/', `<!doctype html>
<html>
<head>
<link rel="stylesheet" href="/styles.css">
<style>
#target { border-color: green; }
</style>
</head>
<body>
<div id="target" style="margin-left: 3px">Target</div>
</body>
</html>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const result = await client.callTool({
    name: 'browser_css_rules',
    arguments: { target: '#target' },
  });
  const stylesheetUrl = new URL('/styles.css', server.PREFIX).href;
  expect(result).toHaveResponse({
    result: expect.stringContaining(`/* ${stylesheetUrl}:1 */`),
  });
  expect(result).toHaveResponse({
    result: expect.stringContaining('/* inline <style>:6 */'),
  });
  expect(result).toHaveResponse({
    result: expect.stringContaining('element.style {\n  margin-left: 3px;\n}'),
  });
});

test('browser_css_rules marks lower-priority declarations overridden', async ({ client, server }) => {
  server.setContent('/styles.css', `#target { color: red; background-color: red; }
.target { color: blue; background-color: blue !important; }
button { background-color: green; }
`, 'text/css');
  server.setContent('/', '<link rel="stylesheet" href="/styles.css"><button id="target" class="target" style="margin-left: 1px; background-color: black">Target</button>', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const result = await client.callTool({
    name: 'browser_css_rules',
    arguments: { target: '#target' },
  });
  expect(result).toHaveResponse({
    result: expect.stringContaining('background-color: blue !important;'),
  });
  expect(result).toHaveResponse({
    result: expect.stringContaining('background-color: red; /* overridden */'),
  });
  expect(result).toHaveResponse({
    result: expect.stringContaining('background-color: black; /* overridden */'),
  });
  expect(result).toHaveResponse({
    result: expect.stringContaining('color: blue; /* overridden */'),
  });
});

test('browser_css_rules includes hover rules only when hover is forced', async ({ client, server }) => {
  server.setContent('/', '<style>#target:hover { color: red; }</style><button id="target">Target</button>', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const defaultResult = await client.callTool({
    name: 'browser_css_rules',
    arguments: { target: '#target' },
  });
  expect(defaultResult).toHaveResponse({ result: expect.not.stringContaining('#target:hover') });

  const hoverResult = await client.callTool({
    name: 'browser_css_rules',
    arguments: { target: '#target', pseudoState: ['hover'] },
  });
  expect(hoverResult).toHaveResponse({ result: expect.stringContaining('#target:hover') });
});

test('browser_css_rules includes custom properties and computed values', async ({ client, server }) => {
  server.setContent('/', '<style>#target { --accent: rgb(1, 2, 3); color: var(--accent); background-color: white; }</style><div id="target">Target</div>', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const result = await client.callTool({
    name: 'browser_css_rules',
    arguments: { target: '#target' },
  });
  expect(result).toHaveResponse({ result: expect.stringContaining('--accent: rgb(1, 2, 3);') });
  expect(result).toHaveResponse({ result: expect.stringContaining('/* computed */') });
  expect(result).toHaveResponse({ result: expect.stringContaining('color: rgb(1, 2, 3);') });
});

test('browser_css_rules applies the property filter to every section', async ({ client, server }) => {
  server.setContent('/', '<style>#target { color: red; background-color: blue; }</style><div id="target">Target</div>', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const result = await client.callTool({
    name: 'browser_css_rules',
    arguments: { target: '#target', properties: ['background-color'] },
  });
  expect(result).toHaveResponse({ result: expect.stringContaining('background-color: blue;') });
  expect(result).toHaveResponse({ result: expect.not.stringContaining('color: red;') });
});

test('browser_css_rules reports missing targets', async ({ client, server }) => {
  server.setContent('/', '<div id="present">Present</div>', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  expect(await client.callTool({
    name: 'browser_css_rules',
    arguments: { target: '#missing' },
  })).toHaveResponse({
    error: expect.stringContaining('#missing'),
    isError: true,
  });
});
