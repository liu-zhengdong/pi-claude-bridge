# AGENTS Evolution

## 2026-09-24 · 区分 fork PR 与上游公开操作

- 发生：用户指出仓库已有自己的 fork，给自己的仓库提 PR 不应一律按“公开互动需单独许可”处理。
- 分析：原条款为避免 `gh` 默认选择上游，连正常的 fork PR 也挡住了；真正要防的是目标误指向上游，及未授权的公开评论。
- 改变：将 GitHub 边界改为已授权开发可直接向 `liu-zhengdong/pi-claude-bridge` 的 `schuettc-publish` 提 PR；继续要求明确指定仓库和目标分支，上游 PR 与公开 issue 评论仍需许可。
