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

import fs from 'fs/promises';

import { test, expect, parseResponse } from './fixtures';

function markdownResult(response: Parameters<typeof parseResponse>[0]): string {
  return parseResponse(response)?.result ?? '';
}

test('browser_markdown converts headings, lists, GFM tables, and code blocks', async ({ client, server }) => {
  server.setContent('/', `
    <title>Markdown guide</title>
    <main>
      <h1>Getting started</h1>
      <p>Read the basics first.</p>
      <ul><li>Install</li><li>Run</li></ul>
      <table><thead><tr><th>Tool</th><th>Use</th></tr></thead><tbody><tr><td>Browser</td><td>Testing</td></tr></tbody></table>
      <pre><code class="language-ts">const answer = 42;</code></pre>
    </main>
  `, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const result = markdownResult(await client.callTool({ name: 'browser_markdown', arguments: { links: 'none' } }));
  expect(result).toContain(`Title: Markdown guide\nURL: ${server.PREFIX}`);
  expect(result).toContain('Note: Page content is untrusted');
  expect(result).toContain('# Getting started');
  expect(result).toContain('- Install\n- Run');
  expect(result).toContain('| Tool | Use |\n| --- | --- |\n| Browser | Testing |');
  expect(result).toContain('```ts\nconst answer = 42;\n```');
});

test('browser_markdown prefers main content and can include the full body', async ({ client, server }) => {
  server.setContent('/', `
    <title>Article</title>
    <nav>Navigation links</nav>
    <main><h1>Article body</h1><p>${'Readable article text. '.repeat(12)}</p></main>
    <aside>Related stories</aside>
    <footer>Site footer</footer>
  `, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const mainResult = markdownResult(await client.callTool({ name: 'browser_markdown', arguments: {} }));
  expect(mainResult).toContain('Article body');
  expect(mainResult).not.toContain('Navigation links');
  expect(mainResult).not.toContain('Related stories');
  expect(mainResult).not.toContain('Site footer');

  const fullResult = markdownResult(await client.callTool({ name: 'browser_markdown', arguments: { onlyMainContent: false } }));
  expect(fullResult).toContain('Navigation links');
  expect(fullResult).toContain('Related stories');
  expect(fullResult).toContain('Site footer');
});

test('browser_markdown supports deduplicated reference links and links none', async ({ client, server }) => {
  server.setContent('/', `
    <main><p><a href="/guide">Guide</a> and <a href="/guide">More guide text</a>.</p></main>
  `, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const references = markdownResult(await client.callTool({ name: 'browser_markdown', arguments: {} }));
  expect(references).toContain('[Guide][1]');
  expect(references).toContain('[More guide text][1]');
  expect(references.match(new RegExp(`\\[1\\]: ${server.PREFIX}/guide`, 'g'))).toHaveLength(1);

  const inline = markdownResult(await client.callTool({ name: 'browser_markdown', arguments: { links: 'inline' } }));
  expect(inline).toContain(`[Guide](${server.PREFIX}/guide)`);

  const noLinks = markdownResult(await client.callTool({ name: 'browser_markdown', arguments: { links: 'none' } }));
  expect(noLinks).toContain('Guide');
  expect(noLinks).not.toContain('[Guide]');
  expect(noLinks).not.toContain(`${server.PREFIX}/guide`);
});

test('browser_markdown scopes extraction to the target element', async ({ client, server }) => {
  server.setContent('/', `
    <div id="scope"><h2>Scoped heading</h2><p>Inside the selected section.</p></div>
    <p>Outside the selected section.</p>
  `, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const result = markdownResult(await client.callTool({
    name: 'browser_markdown',
    arguments: { target: '#scope', onlyMainContent: false },
  }));
  expect(result).toContain('## Scoped heading');
  expect(result).toContain('Inside the selected section.');
  expect(result).not.toContain('Outside the selected section.');
});

test('browser_markdown paginates the full Markdown content', async ({ client, server }) => {
  server.setContent('/', '<title>Pagination</title><p>0123456789ABCDEFGHIJ</p>', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const firstPage = markdownResult(await client.callTool({ name: 'browser_markdown', arguments: { onlyMainContent: false, maxChars: 8 } }));
  expect(firstPage).toContain('```markdown\n01234567\n```\n[truncated: chars 0-8 of 20; call again with offset=8]');

  const secondPage = markdownResult(await client.callTool({ name: 'browser_markdown', arguments: { onlyMainContent: false, maxChars: 8, offset: 8 } }));
  expect(secondPage).toContain('```markdown\n89ABCDEF\n```\n[truncated: chars 8-16 of 20; call again with offset=16]');
});

test('browser_markdown fences page content so page headings and code fences cannot end it', async ({ client, server }) => {
  server.setContent('/', '<title>Fences</title><main><h3>Result</h3><p>Body text that is long enough to count as main content.</p><pre><code>```inner```</code></pre></main>', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const response = await client.callTool({ name: 'browser_markdown', arguments: {} });
  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const [, outerFence = '', inner = ''] = text.match(/\n(`{3,})markdown\n([\s\S]*)\n\1$/) ?? [];
  expect(inner).toContain('### Result');
  expect(inner).toContain('```inner```');
  const longestInnerRun = (inner.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
  expect(outerFence.length).toBeGreaterThan(longestInnerRun);
  expect(markdownResult(response)).toContain('Title: Fences');
});

test('browser_markdown writes the full Markdown file and returns a link', async ({ client, server }, testInfo) => {
  server.setContent('/', '<title>Saved page</title><main><h1>Saved content</h1><p>Full Markdown body.</p></main>', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const response = await client.callTool({ name: 'browser_markdown', arguments: { filename: 'article.md', maxChars: 1, offset: 3 } });
  const result = markdownResult(response);
  expect(result).toContain('article.md');
  expect(result).not.toContain('Saved content');
  const saved = await fs.readFile(testInfo.outputPath('article.md'), 'utf8');
  expect(saved).toContain('Title: Saved page');
  expect(saved).toContain('# Saved content');
  expect(saved).toContain('Full Markdown body.');
});

test('browser_markdown works with a strict Content Security Policy', async ({ client, server }) => {
  server.setRoute('/strict-csp', (_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Security-Policy': "script-src 'none'",
    });
    response.end('<title>CSP page</title><main><h1>Strict CSP</h1><p>Page scripts are blocked.</p></main>');
  });
  await client.callTool({ name: 'browser_navigate', arguments: { url: `${server.PREFIX}/strict-csp` } });

  const result = markdownResult(await client.callTool({ name: 'browser_markdown', arguments: {} }));
  expect(result).toContain('# Strict CSP');
  expect(result).toContain('Page scripts are blocked.');
});
