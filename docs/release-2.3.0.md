# TraceFind 2.3.0

模型不用再手敲名字了：下拉里直接选，或者从接口拉一份真实列表。

## 新增

- **嵌入模型 / 问答模型改为下拉框**：按接口地址自动给出该服务商的常用模型
  - OpenAI：`text-embedding-3-small` / `text-embedding-3-large`、`gpt-4o-mini` / `gpt-4o` …
  - DeepSeek：`deepseek-chat` / `deepseek-reasoner`
  - 通义千问、智谱、Moonshot、SiliconFlow、Mistral 同样内置常用项
- **从接口获取**：用已保存的 Key 请求 `/models`，把真实可用列表并入下拉（实测 DeepSeek 返回了 `deepseek-flash`、`deepseek-v4-pro`）
- **自定义仍然可用**：下拉最后一项「自定义…」切回输入框
- **服务商识别**：接口地址匹配到已知域名时显示服务商名，否则显示「自定义接口」

## 修复

- 设置页按钮不再竖排换行（`white-space: nowrap`）

## 说明

只读取模型 id，不发送任何本地文件或路径；没有保存 Key 时「从接口获取」会提示先保存。索引与数据格式未变。