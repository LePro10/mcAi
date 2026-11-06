// Tool registry for the mcai MCP server (ARCHITECTURE §7).

import type { ToolDef } from './common.ts';
import { perceptionTools } from './perception.ts';
import { buildingTools } from './building.ts';
import { clipboardTools } from './clipboard.ts';
import { controlTools } from './control.ts';

export function allTools(): ToolDef[] {
  return [...perceptionTools, ...buildingTools, ...clipboardTools, ...controlTools];
}

export type { ToolDef, ToolEnv, ToolCtx, ToolOutput } from './common.ts';
