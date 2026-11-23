# dsh-qq-notice

把 DSH 的三类时机推到 QQ：**等授权**、**等你选**、**跑完了**。发不出去的落本地队列，每小时汇总成一封邮件。

```
🔐 需要授权 · qq-notify · 3f2a91
目录 D:/work/SennCloud/qq-notify
工具 bash · 原因：需要执行命令
$ pnpm install --frozen-lockfile
```

```
❓ 待你选择 · qq-notify · 3f2a91
1) 迁移策略选哪个？
     停机迁移
     双写过渡
```

```
✅ 完成（合并 3 轮） · qq-notify · 3f2a91
耗时 4m12s · 2 轮 · 23 次工具调用
最后输出：TypeScript 编译通过，改动 3 个文件…
```

## 设计边界（改代码前先读）

- **只旁听，不接管**：审批与提问都是 waterfall，本插件看一眼就 `next()` 交回宿主。QQ 里只能看，不能点。→ [ADR-0001](../docs/adr/0001-listen-only-not-takeover.md)
- **零 LLM**：文案全是模板拼装，不调用模型、不产生 token。→ [ADR-0002](../docs/adr/0002-zero-llm-link.md)
- **只走 HTTP，不连 gateway**：不复用 `im-qqbot` 的 WebSocket，只借它的 appId/appSecret 发消息。→ [ADR-0003](../docs/adr/0003-http-only-no-gateway.md)
- **邮件只做漏发汇总**：不是逐条转发，是每小时一封。→ [ADR-0004](../docs/adr/0004-email-digest-only.md)
- **审批间隔按你的作答计时**，超时没处理再补一条提醒。→ [ADR-0005](../docs/adr/0005-approval-throttle-anchored-on-decision.md)

## 安装

```powershell
# 从 npm（推荐：依赖按常规方式解析，不需要本地 junction）
dsh plugin --profile web add dsh-qq-notice
```

在 DSH 里也可以用 `plugin_manager` 的 `install_bundle`，`target` 填包名或本地目录。

装完需要重启 `dsh web`（或触发一次 profile 重组）才会生效——HMR 只监听 patch 与 profile 的 `package.json`，改插件 `.js` 不会立即热更。

## 配置

两处都能改，改完立即生效（volatile 字段，不需要重载）：

- **DSH 设置页**：设置 → 插件 → `qq-notify`（按 profile entry id 显示）
- **profile 的 `cordis.patch.yml`**：`- id: qq-notify` 那条的 `config`

默认值见 [cordis.patch.yml](./cordis.patch.yml)。**装好即用**：`targets` 留空时自动取 `im-qqbot` 私聊白名单，凭据也直接复用，不需要配第二遍。

| 配置                                    | 作用                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `targets`                               | `c2c:<openid>` / `group:<openid>`；空 = 用 im-qqbot 的白名单                                            |
| `events.approval / choice / completion` | 按事件源关开关                                                                                          |
| `commandClip`                           | 审批通知里命令原文上限（默认 800 字，**不脱敏**）                                                       |
| `lastOutputChars`                       | 完成通知里最后输出上限（默认 150 字）                                                                   |
| `mergeWindowMs`                         | 同一会话连续 turn 的合并窗口（默认 8s）                                                                 |
| `approvalIntervalMs`                    | **你点过允许/拒绝之后**这段时间内不再推审批通知（默认 20000ms = 20s）；被压的计数并入下一封；0 = 不限制 |
| `approvalReminderMs`                    | 审批推送后超过这么久仍没处理，补一条提醒（默认 60000ms = 60s，只提醒一次）；0 = 不提醒                  |
| `perTargetPerMinute`                    | 每个收件人每分钟条数上限（默认 10）                                                                     |
| `mutedCwds` / `skipCwds`                | 按 cwd 模式静音；支持 `*` 通配与子串                                                                    |

### 审批通知的三条规则

1. **推**：一条审批进来就发一条——除非你刚刚点过（见 2）。
2. **压**：你点完「允许/拒绝」之后的 `approvalIntervalMs`（默认 20s）内，审批通知一条都不推，只计数，跟着下一条真正发出去的通知报「另有 N 条」。
   锚点是**你的作答时刻**，不是上次推送的时刻：宿主那条审批 promise 一结算，窗口就重新开始。
3. **补**：任何一条审批超过 `approvalReminderMs`（默认 60s）还没人处理，补一条「⏰ 还在等你授权」，只补一次。

第 3 条是第 2 条的兜底：被压掉的那条如果一直没人管，等待就变隐形了，而这恰好是本插件存在的理由。所以提醒**不走节流窗口**——被节流吞掉就白做了。→ [ADR-0005](../docs/adr/0005-approval-throttle-anchored-on-decision.md)

## 邮件兜底

**只发给自己**：收件人固定是 SMTP 登录账号本身，没有抄送、没有多收件人（少一个能填错的字段）。

1. 密码存进 DSH 凭据，不要写进配置（`cordis.patch.yml` 是明文落盘的）。凭据文件是
   `C:\Users\Senn\.dsh\.credentials.yaml`，在 `refs:` 下加一行即可（ref 名与配置里的
   `passwordRef` 一致，默认 `SMTP_PASSWORD`）：

   ```yaml
   version: 1
   refs:
     SMTP_PASSWORD: <邮箱的授权码 / 应用专用密码>
   ```

   插件启动后会用 `ctx.credentials.resolve('SMTP_PASSWORD')` 读取，读不到才回退到同名环境变量。

2. 设置页填 `SMTP 主机 / 端口 / 账号`（QQ 邮箱是 `smtp.qq.com` + 授权码）。
3. 点「**发送测试邮件**」立刻验证通不通——它会直接走一遍真实 SMTP，不等汇总周期。
4. **只支持 465（SMTP over TLS）**；`secure: false` 会明确报错，不会静默失败。
5. 没配 SMTP 时通知照常入队，队列在 `~/.dsh-qq-notice/pending.jsonl`，配好之后下一轮汇总自动发出。

## 不通知谁

- **QQ 来源会话**（cwd 等于 im-qqbot 的工作目录）：人已经在 QQ 里，再推一遍是重复。
- **子代理会话**（`header.origin === 'subagent'`）：一个任务会派出十几个子代理，不拦就是轰炸。

## 测试

```powershell
cd dsh-qq-notice
node --test "test/*.test.mjs"
```

纯函数（文案、turn 跟踪、限流、SMTP 报文组装、漏发队列）都有单测；事件接线依赖宿主，只能靠真实触发验证。

## 已知限制

- QQ **主动消息**受平台额度限制，官方 SDK 文档原话是"不要把它当推送系统用"；超限的会进漏发汇总。
- 被动回复窗口（C2C 30 分钟）用不上——单向推送没有 `msg_id`。
- **不能在 QQ 里作答，也不能在 QQ 里发指令静音**：本插件不连 gateway，收不到消息（ADR-0003）。
- 审批通知里的命令原文靠按 `callId` 回查会话快照；会话已不在内存时只能发"拿不到命令原文"。
