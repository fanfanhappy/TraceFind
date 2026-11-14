/**
 * 常见服务商的模型预设：按接口地址识别，设置页用它填下拉框。
 * 只是建议值，用户仍可选「自定义」手填，或从 /models 拉取真实列表。
 */
export interface ProviderPreset {
  /** 用于匹配接口地址的关键字 */
  host: string
  label: string
  embeddings: string[]
  chat: string[]
}

const PRESETS: ProviderPreset[] = [
  {
    host: 'api.openai.com',
    label: 'OpenAI',
    embeddings: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
    chat: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
  },
  {
    host: 'api.deepseek.com',
    label: 'DeepSeek',
    embeddings: [],
    chat: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    host: 'dashscope.aliyuncs.com',
    label: '通义千问',
    embeddings: ['text-embedding-v3', 'text-embedding-v2'],
    chat: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  },
  {
    host: 'open.bigmodel.cn',
    label: '智谱',
    embeddings: ['embedding-3'],
    chat: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'],
  },
  {
    host: 'api.moonshot.cn',
    label: 'Moonshot',
    embeddings: [],
    chat: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  {
    host: 'api.siliconflow.cn',
    label: 'SiliconFlow',
    embeddings: ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5'],
    chat: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'],
  },
  {
    host: 'api.mistral.ai',
    label: 'Mistral',
    embeddings: ['mistral-embed'],
    chat: ['mistral-small-latest', 'mistral-large-latest'],
  },
]

export function presetFor(baseUrl: string): ProviderPreset | null {
  const value = baseUrl.trim().toLowerCase()
  if (!value) return null
  return PRESETS.find((preset) => value.includes(preset.host)) ?? null
}

export type ModelKind = 'embedding' | 'chat'

/** 预设 + 远端拉取 + 当前值，去重后给下拉框用 */
export function modelOptions(baseUrl: string, kind: ModelKind, remote: string[], current: string): string[] {
  const preset = presetFor(baseUrl)
  const presetList = preset ? (kind === 'embedding' ? preset.embeddings : preset.chat) : []
  const out: string[] = []
  const push = (value: string) => {
    const trimmed = value.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  push(current)
  presetList.forEach(push)
  remote.forEach(push)
  return out
}

/** 给下拉框加一句来源说明 */
export function describeProvider(baseUrl: string): string {
  const preset = presetFor(baseUrl)
  return preset ? preset.label : '自定义接口'
}
