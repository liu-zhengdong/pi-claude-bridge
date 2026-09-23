# 关于这个 fork

`liu-zhengdong/pi-claude-bridge`，从 `schuettc/pi-claude-bridge` fork 而来，自行维护，**不跟随上游**。

上游链条是 `elidickinson/pi-claude-bridge` → `schuettc/pi-claude-bridge` → 本仓库。分叉点是 `0.7.0-schuettc.12`。

## 安装

```sh
pi install git:github.com/liu-zhengdong/pi-claude-bridge@<tag>
```

装之前要先卸掉 npm 版，否则两个包会注册同一个 provider：

```sh
pi remove npm:@schuettc/pi-claude-bridge
```

本仓库不发布到 npm。

## 不跟随上游

没有自动同步，也没有同步工作流。上游的 `.github/workflows/upstream-sync.yml`（每天 rebase 到 `elidickinson/main` 并用 OIDC 发布 npm）和它调用的 `.github/scripts/upstream-sync.sh` 都已删除——那是上游的发布流程，在这里跑会重写我们自己的分支。

需要看上游有什么变化时手动比：

```sh
git fetch upstream
git log --oneline HEAD..upstream/schuettc-publish
```

要挑某个上游改动就手动 cherry-pick，不做整体合并。

## 本 fork 的改动

- **#1 / PR #2**：自动重试工具结果续接时，不再被当成孤儿工具结果返回空回复。Pi 的 auto-retry 重发「工具结果之后的模型调用」时，原来会命中为「用户按 ESC 打断工具调用」设计的分支，返回零 token 空消息，Pi 判定重试成功后轮次结束、会话停住。现在按「这条工具结果有没有被交付过」区分，重发的落到 fresh-query 路径继续。
- **#12**：其他扩展追加到系统提示的文本（Pi Notes 的默认展开笔记、billion-context-pi 的使用说明）现在会转给 Claude Code。原来只转发 Pi 结构化选项里的 custom / append / 上下文文件 / 技能，追加文本在查找 key 里、不在投影里，每轮都被静默丢掉。现在定位 Pi 自身组装的结尾（`<cwd>` 段及其后新增的自定义段），把之后的内容接在 append 后面；定位不到时写 diag 并提示一次。

## 测试

```sh
npm run test:unit    # 纯单元，不碰网络
npm run typecheck
npm test             # 含集成测试，会真的调 Claude Code
```
