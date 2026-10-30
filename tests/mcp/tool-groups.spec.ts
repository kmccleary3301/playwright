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

import { test, expect } from './fixtures';

const allCaps = '--caps=config,network,storage,pdf,diffs,styles,scenarios,perf,devtools,vision,testing';

test('tool groups list one tool per family and only name callable tools', async ({ startClient }) => {
  const { client } = await startClient({ args: ['--tool-groups', allCaps] });
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  expect(names).toEqual(expect.arrayContaining(['browser_cookies', 'browser_web_storage', 'browser_storage_state', 'browser_route', 'browser_inspect', 'browser_diff', 'browser_mouse', 'browser_verify', 'browser_tracing', 'browser_recording', 'browser_highlight', 'browser_video', 'browser_video_overlay']));
  for (const member of ['browser_cookie_list', 'browser_localstorage_get', 'browser_set_storage_state', 'browser_unroute', 'browser_css_rules', 'browser_screenshot_diff', 'browser_mouse_click_xy', 'browser_verify_value', 'browser_stop_tracing', 'browser_stop_recording', 'browser_hide_highlight', 'browser_video_chapter', 'browser_video_hide_actions'])
    expect(names).not.toContain(member);

  const cookies = tools.find(tool => tool.name === 'browser_cookies')!;
  expect(cookies.inputSchema.required).toEqual(['action']);
  expect(cookies.inputSchema.properties!.action).toMatchObject({ enum: ['list', 'get', 'set', 'delete', 'clear'] });

  const mentioned = (text: string) => [...text.matchAll(/\bbrowser_[a-z_]+/g)].map(match => match[0]);
  const unlisted = [...mentioned(JSON.stringify(tools)), ...mentioned(client.getInstructions() ?? '')].filter(name => !names.includes(name));
  expect([...new Set(unlisted)]).toEqual([]);
});

test('family tools dispatch by action and area', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--tool-groups'], config: { capabilities: ['storage'] } });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.EMPTY_PAGE } });

  await client.callTool({ name: 'browser_cookies', arguments: { action: 'set', name: 'testCookie', value: 'testValue' } });
  expect(await client.callTool({ name: 'browser_cookies', arguments: { action: 'get', name: 'testCookie' } })).toHaveResponse({
    result: expect.stringContaining('testCookie=testValue'),
  });

  await client.callTool({ name: 'browser_web_storage', arguments: { area: 'local', action: 'set', key: 'shared', value: 'local' } });
  expect(await client.callTool({ name: 'browser_web_storage', arguments: { area: 'local', action: 'get', key: 'shared' } })).toHaveResponse({
    result: expect.stringContaining('shared=local'),
  });
  expect(await client.callTool({ name: 'browser_web_storage', arguments: { area: 'session', action: 'get', key: 'shared' } })).toHaveResponse({
    result: expect.stringContaining(`sessionStorage key 'shared' not found`),
  });
});

test('family tools validate arguments against the chosen action', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--tool-groups'], config: { capabilities: ['storage'] } });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.EMPTY_PAGE } });

  expect(await client.callTool({ name: 'browser_cookies', arguments: { action: 'list', value: 'x' } })).toHaveResponse({
    isError: true,
    error: 'Invalid arguments for browser_cookies action=list: "value" is not used by this action. It takes list(domain?, path?).',
  });
  expect(await client.callTool({ name: 'browser_cookies', arguments: { action: 'get' } })).toHaveResponse({
    isError: true,
    error: expect.stringMatching(/^Invalid arguments for browser_cookies action=get:\n[^]*at name/),
  });
  expect(await client.callTool({ name: 'browser_cookies', arguments: { action: 'purge' } })).toHaveResponse({
    isError: true,
    error: 'Invalid arguments for browser_cookies: "action" must be one of "list", "get", "set", "delete", "clear".',
  });
  expect(await client.callTool({ name: 'browser_web_storage', arguments: { action: 'list' } })).toHaveResponse({
    isError: true,
    error: 'Invalid arguments for browser_web_storage: "area" must be one of "local", "session".',
  });
  expect(await client.callTool({ name: 'browser_cookie_list', arguments: {} })).toHaveResponse({
    isError: true,
    error: 'Tool "browser_cookie_list" is not listed in this session. Call browser_cookies action=list instead.',
  });
});

test('family actions follow the enabled capabilities', async ({ startClient }) => {
  const actionsOf = async (capability: 'diffs' | 'styles') => {
    const { client } = await startClient({ args: ['--tool-groups'], config: { capabilities: [capability] } });
    const { tools } = await client.listTools();
    const actions = (name: string) => {
      const action = tools.find(tool => tool.name === name)?.inputSchema.properties?.action;
      return action && typeof action === 'object' && 'enum' in action ? action.enum : undefined;
    };
    return { inspect: actions('browser_inspect'), diff: actions('browser_diff') };
  };
  expect(await actionsOf('styles')).toEqual({ inspect: ['style', 'layout', 'css_rules'], diff: ['style', 'layout'] });
  expect(await actionsOf('diffs')).toEqual({ inspect: ['dom'], diff: ['dom', 'aria', 'screenshot'] });
});

test('tool results name the family instead of a hidden member', async ({ startClient, server }, testInfo) => {
  const scenario = testInfo.outputPath('empty-scenario.md');
  await fs.promises.writeFile(scenario, '# Empty scenario\n');
  const { client } = await startClient({ args: ['--tool-groups'], config: { capabilities: ['devtools', 'scenarios'] } });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.EMPTY_PAGE } });
  await client.callTool({ name: 'browser_tracing', arguments: { action: 'start' } });

  const result = await client.callTool({ name: 'browser_run_scenario', arguments: { file: scenario, mode: 'debug' } });
  expect(result).toHaveResponse({
    isError: true,
    error: expect.stringContaining('Stop the active trace with browser_tracing action=stop'),
  });
  expect(JSON.stringify(result)).not.toContain('browser_stop_tracing');
});

test('instructions map every listed tool and name disabled capabilities', async ({ startClient }) => {
  for (const args of [[allCaps], ['--tool-groups', allCaps]]) {
    const { client } = await startClient({ args });
    const { tools } = await client.listTools();
    const instructions = client.getInstructions() ?? '';
    expect(instructions.length).toBeLessThanOrEqual(4000);
    expect(tools.map(tool => tool.name).filter(name => !new RegExp(`\\b${name}\\b`).test(instructions))).toEqual([]);
    expect(instructions).not.toContain('Not enabled in this session');
  }

  const { client } = await startClient();
  expect(client.getInstructions()).toMatch(/Not enabled in this session: network \(.*\), storage \(.*\), diffs \(.*\), styles \(.*\), scenarios \(.*\), perf \(.*\), pdf \(.*\), config \(.*\), devtools \(.*\), vision \(.*\), testing \(.*\)\./);
});

test('parameters with defaults are optional in the listed schema', async ({ startClient }) => {
  const { client } = await startClient({ args: [allCaps] });
  const { tools } = await client.listTools();
  const required = (name: string) => tools.find(tool => tool.name === name)!.inputSchema.required ?? [];
  expect(required('browser_markdown')).toEqual([]);
  expect(required('browser_console_messages')).not.toContain('level');
  expect(required('browser_css_rules')).toEqual(['target']);
  expect(tools.filter(tool => '$schema' in tool.inputSchema).map(tool => tool.name)).toEqual([]);
});

test('every tool carries a search hint and only core tools load eagerly', async ({ startClient }) => {
  for (const args of [[allCaps], ['--tool-groups', allCaps]]) {
    const { client } = await startClient({ args });
    const { tools } = await client.listTools();
    expect(tools.filter(tool => typeof tool._meta?.['anthropic/searchHint'] !== 'string').map(tool => tool.name)).toEqual([]);
    expect(tools.filter(tool => tool._meta?.['anthropic/alwaysLoad'] === true).map(tool => tool.name).sort()).toEqual(['browser_click', 'browser_markdown', 'browser_navigate', 'browser_snapshot', 'browser_type']);
  }
});
