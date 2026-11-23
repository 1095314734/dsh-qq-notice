/**
 * 插件配置 Schema。
 *
 * 设计约束一：凭据与收件人默认留空，此时插件去读 im-qqbot 的配置——
 * 一台机器只有一个机器人，不该让人配两遍（ADR-0003）。
 *
 * 设计约束二：**每个可编辑字段都必须 `.volatile()`**。DSH 的设置页只列出
 * 「至少有一个 volatile 字段」的插件（`dsh-settings` 的 `volatileForm()` 碰到
 * 没有 volatile 字段的 schema 会返回 undefined，整条记录被跳过）。volatile
 * 字段在运行时不是普通值，而是带 `.get()` 的引用对象，所以 lib/index.js 里
 * 统一用 `unwrap()` 解引用后再 normalize。
 *
 * 设计约束三：schema 是"可选增强"。本机开发时插件常以 `file:` 依赖装进 profile，
 * pnpm 建符号链接、Node 按真实路径解析，`@deepseek-ai/schemastery` 可能解析不到
 * （需要给插件建一条指向 profile 的目录联接）。那种情况下宁可不校验也不能让插件
 * 加载失败——normalize() 会补齐所有缺省值。
 */
let ConfigSchema;
/** 加载失败的原因（诊断用；Normal 情况下为 undefined） */
let ConfigSchemaError;

try {
  const { default: Schema } = await import('@deepseek-ai/schemastery');

  const SmtpSchema = Schema.object({
    host: Schema.string().default('').volatile().description('SMTP 主机，例如 smtp.qq.com'),
    port: Schema.number().default(465).volatile().description('端口：465 = SSL（目前只支持这个）'),
    secure: Schema.boolean().default(true).volatile().description('true = SMTP over TLS（465）'),
    user: Schema.string().default('').volatile().description('登录账号（QQ 邮箱地址）'),
    passwordRef: Schema.string().default('SMTP_PASSWORD').volatile()
      .description('ctx.credentials 里的密码引用名；password 留空时才用它'),
    password: Schema.string().default('').role('secret').volatile()
      .description('SMTP 授权码；留空则用上面的 passwordRef（推荐放凭据里）'),
    from: Schema.string().default('').volatile().description('发件人；留空则取 user'),
  }).default({
    host: '',
    port: 465,
    secure: true,
    user: '',
    passwordRef: 'SMTP_PASSWORD',
    password: '',
    from: '',
  }).description('漏发汇总的邮件出口；收件人固定为登录账号自己');

  ConfigSchema = Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('总开关'),
    targets: Schema.array(Schema.string()).default([]).volatile()
      .description('通知目标（c2c:<openid> / group:<openid>）；留空则取 im-qqbot 私聊白名单'),
    qq: Schema.object({
      appId: Schema.string().default('').volatile().description('QQ 机器人 AppID；留空复用 im-qqbot'),
      appSecret: Schema.string().default('').role('secret').volatile()
        .description('QQ 机器人 AppSecret；留空复用 im-qqbot'),
    }).default({ appId: '', appSecret: '' }).description('可选的独立机器人凭据'),
    events: Schema.object({
      approval: Schema.boolean().default(true).volatile().description('审批请求'),
      choice: Schema.boolean().default(true).volatile().description('待选择'),
      completion: Schema.boolean().default(true).volatile().description('任务完成 / 异常结束'),
    }).default({ approval: true, choice: true, completion: true }).description('按事件源开关'),
    commandClip: Schema.number().default(800).volatile().description('审批命令原文最大字符数'),
    approvalIntervalMs: Schema.number().default(20000).volatile()
      .description('你点过允许/拒绝后多久内不再推审批通知（毫秒）；0 = 不限制'),
    approvalReminderMs: Schema.number().default(60000).volatile()
      .description('审批推送后超过这么久仍未处理，再补一条提醒（毫秒）；0 = 不提醒'),
    lastOutputChars: Schema.number().default(150).volatile().description('完成通知里最后输出的最大字符数'),
    mergeWindowMs: Schema.number().default(8000).volatile().description('同一会话连续 turn 的合并窗口（毫秒）'),
    perTargetPerMinute: Schema.number().default(10).volatile().description('每个收件人每分钟条数上限'),
    mutedCwds: Schema.array(Schema.string()).default([]).volatile()
      .description('静音的 cwd 模式（支持 * 通配）'),
    skipCwds: Schema.array(Schema.string()).default([]).volatile()
      .description('额外跳过的 cwd（例如机器人自己的工作目录）'),
    digest: Schema.object({
      enabled: Schema.boolean().default(true).volatile()
        .description('发送失败的通知是否进入汇总邮件'),
      intervalMinutes: Schema.number().default(60).volatile().description('汇总周期（分钟）'),
      dir: Schema.string().default('').volatile().description('队列目录；留空 = ~/.dsh-qq-notice'),
      smtp: SmtpSchema,
    }).default({
      enabled: true,
      intervalMinutes: 60,
      dir: '',
      smtp: {
        host: '',
        port: 465,
        secure: true,
        user: '',
        passwordRef: 'SMTP_PASSWORD',
        password: '',
        from: '',
      },
    }).description('漏发汇总'),
  });
} catch (err) {
  // 没有 schema：配置不校验、设置页无表单，交给 normalize() 兜底
  ConfigSchema = undefined;
  ConfigSchemaError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export { ConfigSchema, ConfigSchemaError };
export default ConfigSchema;
