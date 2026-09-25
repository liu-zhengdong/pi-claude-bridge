# AGENTS Evolution

## 2026-09-24 · 区分 fork PR 与上游公开操作

- 发生：用户指出仓库已有自己的 fork，给自己的仓库提 PR 不应一律按“公开互动需单独许可”处理。
- 分析：原条款为避免 `gh` 默认选择上游，连正常的 fork PR 也挡住了；真正要防的是目标误指向上游，及未授权的公开评论。
- 改变：将 GitHub 边界改为已授权开发可直接向 `liu-zhengdong/pi-claude-bridge` 的 `schuettc-publish` 提 PR；继续要求明确指定仓库和目标分支，上游 PR 与公开 issue 评论仍需许可。

## 2026-09-25 · 报错验证走到消费者

- 发生：#202 首轮仅测 `errorMessage` 已映射，却漏掉事故里的 synthetic 助手正文；pi-atrium 的 `text || errorMessage` 仍把原始错误给用户，严正验收退回，Iris 要求纳入自查。
- 分析：原 Tests 只有烟雾测试环境说明，没有报错交付的观察点。上游模型消息与下游提取顺序都会决定用户最终看到什么。
- 改变：在 Tests 段明确按实际 SDK 形态、bridge 输出及消费者提取顺序验证用户可见失败文案；不把单一字段的单测当成完整链路。
