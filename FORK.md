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
- **#14**：扩展注入的消息（ACP 的压缩提醒、`pi.sendMessage` 的自定义消息、context 钩子插入的内容）不再被 CC 说成用户插话。按 `message_end` 记下用户真正发出的消息（以 timestamp 为键），只有这些走插话；其余的附在最后一个工具结果上，写成标明「由 Pi 或其扩展添加，不是用户输入」的 system-reminder，新一轮提示里也这样标注。
- **#16**：ACP 在 context 钩子里压缩历史后，下一轮不再落到空白的 Claude Code 会话。原来用「上下文比 cursor 短」推断是子 Agent，ACP 压缩后的主会话也是这个形状。现在按调用方判断能否使用共享会话（`ownsSharedSession`）：不是旁路请求、没有进行中的顶层查询、并且带着 Pi 当前会话 id 的调用才算主会话；其余调用用自己的一次性会话。主会话历史变短时走重建。
- **#18**：Claude Code 因 safeguards 拒答、换模型重试后，Pi 不再记错模型，也不再留着被拒的半截输出。按 API 消息跟踪块：以 `refusal` 结束、或没到 `message_stop` 就被下一条取代的，从 Pi 消息里删掉；被拒的消息不结束回合，Pi 不会去执行被撤回的工具调用。每条消息记 `message_start` 报告的实际模型。`model_refusal_fallback` 在流守卫之前处理，每个 Claude Code 会话提示一次，不自动切回。

## 测试

```sh
npm run test:unit    # 纯单元，不碰网络
npm run typecheck
npm test             # 含集成测试，会真的调 Claude Code
```
