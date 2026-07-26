# ADR-0001：完全自研 Agent Runtime

状态：接受

## 决策

不使用 Claude Agent SDK。Agent 循环、Tool Runtime、权限、上下文、子 Agent 和任务系统全部由本项目实现。

## 原因

- 必须支持 OpenAI 兼容本地模型；
- 必须控制 Windows 沙箱和 PowerShell 行为；
- 不绑定 Anthropic 运行时和协议；
- 需要独立 Tool/Skill 自进化制度。
