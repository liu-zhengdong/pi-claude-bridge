# 关于这个 fork

`liu-zhengdong/pi-claude-bridge`，从 `schuettc/pi-claude-bridge` fork 而来，自行维护。

上游链条是 `elidickinson/pi-claude-bridge` → `schuettc/pi-claude-bridge` → 本仓库。

## 为什么不直接用上游

需要的修复上游还没有。见下面的「本 fork 的改动」。

## 安装

```sh
pi install git:github.com/liu-zhengdong/pi-claude-bridge@<ref>
```

装之前要先卸掉 npm 版，否则两个包会注册同一个 provider。

本仓库不发布到 npm。上游的 `.github/scripts/upstream-sync.sh`（OIDC 发布到 `@schuettc/pi-claude-bridge`）保留在仓库里但不再被任何工作流调用——保留是为了减少后续同步的冲突面。

## 本 fork 的改动

- **#1 / PR #2**：自动重试工具结果续接时，不再被当成孤儿工具结果返回空回复。Pi 的 auto-retry 重发「工具结果之后的模型调用」时，原来会命中为「用户按 ESC 打断工具调用」设计的分支，返回零 token 空消息，Pi 判定重试成功后轮次结束、会话停住。现在按「这条工具结果有没有被交付过」区分，重发的落到 fresh-query 路径继续。

## 上游同步

`.github/workflows/upstream-sync.yml`，整体替换了上游的同名文件。

| 项 | 值 |
|---|---|
| 发布源 | `schuettc/pi-claude-bridge` 的 `schuettc-publish` 分支 |
| 频率 | 每天 03:00 UTC，也可 `workflow_dispatch` 手动触发 |
| 产物 | 指向上游提交的分支 `upstream-sync/<版本>-<短SHA>` + 一个草稿 PR |
| 去重 | 同一版本同一提交只开一次（分支已存在就跳过） |

限制是刻意的：

- **不自动合入。** PR 是草稿，合入由人决定。
- **不发布 npm。**
- **不替换本地安装。** 合入后要更新本机，手动跑一次 `pi install`。
- **不在 CI 里解决冲突。** PR 分支直接指向上游提交，差异和冲突由 PR 界面呈现。

### 两个容易踩的坑

都是实跑才暴露的，改动这个工作流时注意。

**仓库开关。** 需要 Settings → Actions → General 里的「Allow GitHub Actions to create and approve pull requests」，默认是关的。只在 workflow 里声明 `pull-requests: write` 不够，建 PR 会报 `Resource not accessible by integration`。核对：

```sh
gh api repos/liu-zhengdong/pi-claude-bridge/actions/permissions/workflow \
  --jq '.default_workflow_permissions, .can_approve_pull_request_reviews'
# 期望：write / true
```

**`gh` 在 fork 里默认指向父仓库。** `gh pr create` 和 `gh issue create` 不写 `--repo` 的话会去操作 `schuettc/pi-claude-bridge`。工作流里已经显式传了 `--repo "${GITHUB_REPOSITORY}"`。

合入一个同步 PR 之前：审阅差异确认 fork 自有改动没被覆盖 → 处理冲突 → 跑 `npm run test:unit` 和 `npm run typecheck`。

上游那份工作流为什么不能留：它每天把 `schuettc-publish` rebase 到 `elidickinson/main` 并推送，然后发布 npm。在本 fork 上跑会重写我们自己的分支。
