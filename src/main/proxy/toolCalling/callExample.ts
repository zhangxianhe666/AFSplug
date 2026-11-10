import type { ToolProtocolId } from './types.ts'

/**
 * 按协议渲染一个可直接照抄的工具调用示例。
 *
 * 背景（16:02 现场）：纠偏消息里写死的是
 *   `<tool_call>{"name":"write","arguments":{...}}</tool_call>`
 * 而 managed_xml 协议实际要求的是
 *   `<tool_calls><invoke name="write"><parameter name="path">…</parameter></invoke></tool_calls>`
 *
 * 模型照着纠偏里的示例写，解析器一个都认不出来（日志 parsed=0，正文里却带着
 * 完整的调用意图），重开的那一轮就这么白费了。示例格式必须和协议同源。
 */
export function renderCallExample(
  toolName: string,
  args: Record<string, string>,
  protocol?: ToolProtocolId,
): string {
  if (protocol === 'managed_bracket') {
    return `[function_calls][call:${toolName}]${JSON.stringify(args)}[/call][/function_calls]`
  }
  // managed_xml（以及缺省）走通用 XML：与 managedXml 协议的 parse 分支一致。
  const inner = Object.entries(args)
    .map(([key, value]) => `<parameter name="${key}">${value}</parameter>`)
    .join('')
  return `<tool_calls><invoke name="${toolName}">${inner}</invoke></tool_calls>`
}
