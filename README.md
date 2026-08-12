# pi-claw bot runtime

pi 的 GitHub bot 运行时(自研重构版)。基于 pi-routines 的 fork,但**全部源码已
重写为这个 bot 场景需要的极简实现** —— 36 个上游文件 → 7 个文件,每一行都是
自己的代码。

GitHub 消息桥:轮询 `gh api` → 新事件 → 聊天式消息直插 pi 消息队列
(`sendUserMessage(followUp)`),一消息一轮,与 TUI 消息完全同构。
无 webhook、无隧道、无 routine fire 记账(队列/守卫/次数上限都无意义)。

## 结构

```
extensions/index.ts   入口:注册 6 工具 + 生命周期接线
src/types.ts          精简模型:Routine / GithubTrigger / RoutineStore(schemaVersion 3)
src/store.ts          state.json 原子读写($HOME/.pi/agent/extensions/routines/state.json)
src/log.ts            pino JSON Lines → ~/.pi/agent/logs/pi-claw.log($PI_GH_LOG / $PI_GH_LOG_LEVEL)
src/poller.ts         GitHub 消息桥:endpoint 映射 / 事件规范化 / 游标 / 401 刷新 / 退避
src/tools.ts          6 个 LLM 工具:RoutineCreate/List/Delete/SetState/Pause/Resume
src/lifecycle.ts      session_start 载入+arm;session_shutdown 停 timer
```

## 工作流

```
改源码 → npm run typecheck → /reload → 生效   (push 到 HnskNoah/pi-claw-bot-routines)
```

## 关键机制(都是实战验证过的)

- **游标**:一个 trigger 只有 `cursor` 持久化。首轮成功只 seed 不 fire。
- **discussion 游标 = `number:updated_at`**:新评论 bump updated_at,旧游标必然
  从页面消失 → 按 ISO 时间戳比较(这是 discussion 从不 fire 的根因修复)。
- **[bot] 过滤**:评论事件跳过 bot 作者,防自触发环。
- **401 自动刷新**:installation token 每小时过期,401 → `refresh-bot-token.js`
  → 重试一次。
- **退避**:连续失败 2× interval,上限 60s;gh 缺失只记一次日志,不崩。
- **paused 门**:注入绕过 scheduler 的 paused gate,轮询前自检,跳过 gh 调用不烧配额。

## 上游差异

- 删除:全部 slash 命令(commands/*)、pulse/cron/oneoff/hook/api 触发、
  parser/format/guard/suppressor/widget/path-probe/server/tokens/schedule-nl、
  fire 记账、run 历史、模板、API server。
- 保留(重写):6 个同名 LLM 工具接口(LLM 提示词兼容)、state.json 格式
  (schemaVersion 3,数据零迁移)、{githubMessage}/{state} 占位符、quiet/maxTicks/
  maxRunsPerDay/paused、github filter。
- 改动:轮询 tier 化(对话 10s / 通知 60s)、`pollIntervalMs` 下限 10s。

## 部署

- 位置:`~/.pi/agent/extensions/pi-routines/`(pi 自动发现,`/reload` 热重载)。
- 直接加载(self-installed),npm 包(github 已删)不安装。
- 依赖(nanoid / pino / typebox)本地安装,gitignored。
- 提交身份:`hanenoah-bot <315984458+hanenoah-bot[bot]@users.noreply.github.com>`;
  推送经代理 `http://127.0.0.1:6478`(git config http.proxy 已设)。

## License

MIT — 上游 `@davecodes/pi-routines` © 2026 David Creador;fork 维护 © 2026 HnskNoah。
