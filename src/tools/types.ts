import type { z } from 'zod'
import type { GatewayClient } from '../gateway/client.js'
import type { Envelope } from './envelope.js'

export interface ToolContext {
  gateway: GatewayClient
  accessToken: string
  userLabel: string
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  inputShape: Shape
  uiResourceUri?: string // 有值 → 走 registerAppTool，面板綁此 ui:// 資源
  outputShape?: z.ZodRawShape // structuredContent 的 outputSchema（MCP 規範需宣告）
  handler(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<Envelope>
}
