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

import * as z from 'zod';

import { defineTabTool } from './tool';

const collectLongTasks = defineTabTool({
  capability: 'perf',
  schema: {
    name: 'browser_collect_longtasks',
    title: 'Collect long tasks',
    description: 'Record main-thread long tasks over a time window; Chromium only.',
    inputSchema: z.object({
      durationMs: z.number().optional().describe('Observation duration in milliseconds (default 1000).'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const browserName = tab.page.context().browser()?.browserType().name();
    if (browserName !== 'chromium') {
      response.addError(`Long task collection is only supported in Chromium (current browser: ${browserName || 'unknown'}).`);
      return;
    }

    const duration = params.durationMs || 1000;
    const entries = await tab.page.evaluate(async durationMs => {
      if (typeof PerformanceObserver === 'undefined')
        return { supported: false, entries: [] } as const;
      const collected: { startTime: number, duration: number, name: string, attribution?: unknown }[] = [];
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const longTaskEntry = entry as PerformanceEntry & { attribution?: unknown };
          collected.push({
            startTime: longTaskEntry.startTime,
            duration: longTaskEntry.duration,
            name: longTaskEntry.name,
            attribution: longTaskEntry.attribution || [],
          });
        }
      });
      try {
        observer.observe({ entryTypes: ['longtask'] });
      } catch (e) {
        return { supported: false, entries: [] } as const;
      }
      await new Promise(resolve => setTimeout(resolve, durationMs));
      observer.disconnect();
      return { supported: true, entries: collected } as const;
    }, duration);

    if (!entries.supported) {
      response.addError('The Long Task API is not supported in this Chromium context.');
      return;
    }

    let totalBlockingTime = 0;
    let maxDuration = 0;
    for (const entry of entries.entries) {
      if (entry.duration > maxDuration)
        maxDuration = entry.duration;
      if (entry.duration > 50)
        totalBlockingTime += entry.duration - 50;
    }

    response.addTextResult(JSON.stringify({
      durationMs: duration,
      count: entries.entries.length,
      totalBlockingTimeMs: Number(totalBlockingTime.toFixed(2)),
      maxDurationMs: Number(maxDuration.toFixed(2)),
      entries: entries.entries,
    }, null, 2));
  }
});

export default [collectLongTasks];
