// 轻量语法高亮：不引入高亮库，按语言族做一遍词法扫描。
// 只求"看得清结构"，不追求与编辑器完全一致；超过 20 万字符直接放弃高亮。

export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword'
export interface Token {
  text: string
  kind: TokenKind
}

const KEYWORDS: Record<string, string[]> = {
  js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'class', 'extends', 'new', 'this', 'super', 'import', 'from', 'export', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void', 'yield', 'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly', 'static', 'as', 'satisfies'],
  rust: ['fn', 'let', 'mut', 'pub', 'use', 'mod', 'impl', 'trait', 'struct', 'enum', 'match', 'if', 'else', 'for', 'while', 'loop', 'return', 'break', 'continue', 'move', 'async', 'await', 'where', 'self', 'Self', 'crate', 'super', 'dyn', 'ref', 'const', 'static', 'unsafe', 'extern', 'type', 'in', 'as'],
  py: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'lambda', 'yield', 'pass', 'break', 'continue', 'global', 'nonlocal', 'assert', 'del', 'in', 'is', 'not', 'and', 'or', 'None', 'True', 'False', 'async', 'await', 'self'],
  go: ['func', 'package', 'import', 'type', 'struct', 'interface', 'var', 'const', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break', 'continue', 'go', 'defer', 'chan', 'select', 'map', 'nil', 'true', 'false', 'make', 'new'],
  sql: ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'index', 'drop', 'alter', 'add', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having', 'limit', 'offset', 'and', 'or', 'not', 'null', 'as', 'distinct', 'union', 'case', 'when', 'then', 'else', 'end'],
  shell: ['if', 'then', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'exit', 'local', 'export', 'echo', 'cd', 'set', 'unset'],
  css: [],
}

const EXT_LANG: Record<string, string> = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js', vue: 'js', svelte: 'js',
  rs: 'rust',
  py: 'py', pyw: 'py',
  go: 'go',
  sql: 'sql',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'shell', psm1: 'shell', bat: 'shell', cmd: 'shell',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'toml', conf: 'toml',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html',
  java: 'js', kt: 'js', kts: 'js', cs: 'js', cpp: 'js', cc: 'js', c: 'js', h: 'js', hpp: 'js', swift: 'js', dart: 'js',
}

export function languageFor(ext: string): string | null {
  return EXT_LANG[ext.toLowerCase()] ?? null
}

export function tokenize(text: string, family: string): Token[] {
  if (text.length > 200_000) return [{ text, kind: 'plain' }]

  const keywords = new Set(KEYWORDS[family] ?? [])
  const tokens: Token[] = []
  let index = 0

  const push = (value: string, kind: TokenKind) => {
    if (!value) return
    const last = tokens[tokens.length - 1]
    if (last && last.kind === kind) last.text += value
    else tokens.push({ text: value, kind })
  }

  while (index < text.length) {
    const rest = text.slice(index)

    // 块注释
    const block = /^(\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|"""[\s\S]*?"""|'''[\s\S]*?''')/.exec(rest)
    if (block) {
      push(block[0], 'comment')
      index += block[0].length
      continue
    }

    // 行注释
    const line = /^(\/\/[^\n]*|#[^\n]*|--[^\n]*)/.exec(rest)
    if (line && !(family === 'css' && rest.startsWith('#'))) {
      push(line[0], 'comment')
      index += line[0].length
      continue
    }

    // 字符串
    const str = /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/.exec(rest)
    if (str) {
      push(str[0], 'string')
      index += str[0].length
      continue
    }

    // 数字
    const num = /^(0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest)
    if (num) {
      push(num[0], 'number')
      index += num[0].length
      continue
    }

    // 标识符 / 关键字
    const word = /^[A-Za-z_$][\w$]*/.exec(rest)
    if (word) {
      const lower = word[0].toLowerCase()
      const isKeyword = keywords.has(word[0]) || keywords.has(lower)
      push(word[0], isKeyword ? 'keyword' : 'plain')
      index += word[0].length
      continue
    }

    push(text[index], 'plain')
    index += 1
  }

  return tokens
}
