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

import * as zod from 'zod';
import type { z } from 'zod';
import type * as mcpServer from './server';

export type ToolSchema<Input extends z.Schema> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  type: 'input' | 'assertion' | 'action' | 'readOnly';
  _meta?: Record<string, unknown>;
};

export function toMcpTool(tool: ToolSchema<any>): mcpServer.Tool {
  const readOnly = tool.type === 'readOnly' || tool.type === 'assertion';
  // Input mode lists parameters that have a default as optional, which is what a caller may omit.
  const inputSchema = zod.toJSONSchema(tool.inputSchema, { io: 'input' }) as mcpServer.Tool['inputSchema'];
  delete inputSchema.$schema;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
    annotations: {
      title: tool.title,
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      openWorldHint: true,
    },
    ...(tool._meta ? { _meta: tool._meta } : {}),
  };
}

export function defineToolSchema<Input extends z.Schema>(tool: ToolSchema<Input>): ToolSchema<Input> {
  return tool;
}
