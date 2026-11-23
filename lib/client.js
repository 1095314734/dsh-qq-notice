window.__ModuleLoader__.load({
  id: 'dsh-qq-notice',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NS = 'qq-notify'

    /** 按点号路径读值 */
    function pick(source, path) {
      let cursor = source
      for (const key of path.split('.')) {
        if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined
        cursor = cursor[key]
      }
      return cursor
    }

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        maxWidth: '660px',
        padding: '4px 0 24px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary, #1f2329)',
      },
      group: {
        padding: '14px 0 4px',
        fontSize: '12px',
        fontWeight: 600,
        letterSpacing: '.04em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-tertiary, #8a8f99)',
      },
      field: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 0',
        borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))',
      },
      label: { flex: '1 1 0', minWidth: 0, lineHeight: '20px' },
      hint: {
        display: 'block',
        marginTop: '2px',
        fontSize: '12px',
        fontWeight: 400,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary, #8a8f99)',
      },
      input: {
        boxSizing: 'border-box',
        width: '260px',
        height: '30px',
        padding: '0 10px',
        border: '0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.4))',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.06))',
        color: 'inherit',
        font: 'inherit',
      },
      wide: { width: '320px', height: '68px', padding: '8px 10px', resize: 'vertical', lineHeight: '1.5' },
      message: { padding: '16px 0', color: 'var(--dsw-alias-label-secondary, #5c6270)' },
      error: { padding: '8px 0', color: 'var(--dsw-alias-state-error-primary, #d9534f)' },
    }

    function apply(ctx) {
      const form = ctx.configForms.get(NS)

      /**
       * 写一个（可能的）嵌套字段。
       * 注意：`form.set(field, v)` 只接受单段路径（内部是 path:[field]），
       * 嵌套字段必须自己拆成路径数组走 mutate，否则会在 namespace 根上写一个
       * 名叫 "digest.smtp.host" 的键，Host 直接拒掉。
       */
      function write(path, value) {
        return form.mutate([{ op: 'set', path: path.split('.'), value }])
      }

      function useSnapshot() {
        return React.useSyncExternalStore(
          React.useCallback((listener) => form.subscribe(listener), []),
          React.useCallback(() => form.getSnapshot(), []),
          React.useCallback(() => form.getSnapshot(), []),
        )
      }

      /** 文本行：本地草稿 + 失焦提交，避免每次按键都写 Host */
      function TextRow({ title, hint, path, placeholder, type }) {
        const snapshot = useSnapshot()
        const current = pick(snapshot.value, path)
        const [draft, setDraft] = React.useState(null)
        const text = draft === null ? (current === undefined || current === null ? '' : String(current)) : draft
        return h('label', { style: styles.field },
          h('span', { style: styles.label }, title, hint ? h('span', { style: styles.hint }, hint) : null),
          h('input', {
            style: styles.input,
            type: type ?? 'text',
            value: text,
            placeholder: placeholder ?? '',
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => setDraft(event.currentTarget.value),
            onBlur: () => {
              if (draft === null) return
              const next = type === 'number' ? Number(draft) : draft
              setDraft(null)
              if (String(current ?? '') === String(draft)) return
              void write(path, type === 'number' ? (Number.isFinite(next) ? next : 0) : next)
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            },
          }),
        )
      }

      /** 多行列表：一行一项，失焦提交为数组 */
      function ListRow({ title, hint, path, placeholder }) {
        const snapshot = useSnapshot()
        const current = pick(snapshot.value, path)
        const currentText = Array.isArray(current) ? current.join('\n') : ''
        const [draft, setDraft] = React.useState(null)
        return h('label', { style: styles.field },
          h('span', { style: styles.label }, title, hint ? h('span', { style: styles.hint }, hint) : null),
          h('textarea', {
            style: { ...styles.input, ...styles.wide },
            value: draft === null ? currentText : draft,
            placeholder: placeholder ?? '',
            spellCheck: false,
            onChange: (event) => setDraft(event.currentTarget.value),
            onBlur: () => {
              if (draft === null) return
              const next = draft.split('\n').map((line) => line.trim()).filter(Boolean)
              setDraft(null)
              if (next.join('\n') === currentText) return
              void write(path, next)
            },
          }),
        )
      }

      /** 秒为单位的字段：配置里存毫秒，界面上填秒 */
      function SecondsRow({ title, hint, path }) {
        const snapshot = useSnapshot()
        const currentMs = Number(pick(snapshot.value, path) ?? 0)
        const currentSeconds = Math.round(currentMs / 1000)
        const [draft, setDraft] = React.useState(null)
        return h('label', { style: styles.field },
          h('span', { style: styles.label }, title, hint ? h('span', { style: styles.hint }, hint) : null),
          h('input', {
            style: styles.input,
            type: 'number',
            value: draft === null ? String(currentSeconds) : draft,
            spellCheck: false,
            onChange: (event) => setDraft(event.currentTarget.value),
            onBlur: () => {
              if (draft === null) return
              const seconds = Number(draft)
              setDraft(null)
              if (!Number.isFinite(seconds) || seconds < 0) return
              if (Math.round(seconds) === currentSeconds) return
              void write(path, Math.round(seconds * 1000))
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            },
          }),
        )
      }

      /** 测试发送：直接打宿主路由，走一遍真实 SMTP */
      function TestMailRow() {
        const [state, setState] = React.useState(null)
        const send = React.useCallback(() => {
          setState({ pending: true })
          void fetch('/qq-notify/mail/test', { method: 'POST' })
            .then(async (response) => {
              const body = await response.json().catch(() => ({}))
              // 405/404 = 宿主还没注册测试路由（插件没重启）；说明白，别只显示状态码
              const fallback = response.status === 405 || response.status === 404
                ? '宿主没有这条测试路由，重启 dsh web 后再试'
                : `HTTP ${response.status}`
              setState({
                pending: false,
                ok: body.ok === true,
                message: body.message ?? fallback,
              })
            })
            .catch((error) => {
              setState({ pending: false, ok: false, message: String(error?.message ?? error) })
            })
        }, [])
        return h('div', { style: styles.field },
          h('span', { style: styles.label },
            '测试发送',
            h('span', { style: styles.hint }, '立刻按当前配置发一封测试邮件给自己（不等汇总周期）'),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('button', {
              type: 'button',
              disabled: state?.pending === true,
              onClick: send,
              style: {
                height: '30px',
                padding: '0 14px',
                borderRadius: '8px',
                border: '1px solid transparent',
                background: 'var(--dsw-alias-label-primary, #1f2329)',
                color: 'var(--dsw-alias-bg-layer-3, #fff)',
                font: 'inherit',
                cursor: state?.pending === true ? 'default' : 'pointer',
                opacity: state?.pending === true ? 0.5 : 1,
              },
            }, state?.pending === true ? '发送中…' : '发送测试邮件'),
            state !== null && state.pending !== true
              ? h('span', {
                style: {
                  fontSize: '12px',
                  maxWidth: '260px',
                  color: state.ok
                    ? 'var(--dsw-alias-label-secondary, #5c6270)'
                    : 'var(--dsw-alias-state-error-primary, #d9534f)',
                },
              }, state.message)
              : null,
          ),
        )
      }

      function SwitchRow({ title, hint, path }) {
        const snapshot = useSnapshot()
        const checked = pick(snapshot.value, path) !== false
        return h('div', { style: styles.field },
          h('span', { style: styles.label }, title, hint ? h('span', { style: styles.hint }, hint) : null),
          h('input', {
            type: 'checkbox',
            checked,
            style: { width: '16px', height: '16px', cursor: 'pointer' },
            onChange: (event) => { void write(path, event.currentTarget.checked) },
          }),
        )
      }

      function Section() {
        const snapshot = useSnapshot()
        if (snapshot.status === 'loading') {
          return h('div', { style: styles.page }, h('div', { style: styles.message }, '正在读取配置…'))
        }
        if (snapshot.status === 'unavailable') {
          return h('div', { style: styles.page },
            h('div', { style: styles.message }, '宿主没有暴露 qq-notify 的配置命名空间（插件未加载或版本不匹配）。'))
        }
        return h('div', { style: styles.page },
          h('div', { style: styles.group }, '通知'),
          h(SwitchRow, { title: '总开关', path: 'enabled', hint: '关掉后三类通知都不发，但插件保持加载' }),
          h(SwitchRow, { title: '审批请求', path: 'events.approval', hint: 'agent 要执行工具、等你点允许时' }),
          h(SwitchRow, { title: '待选择', path: 'events.choice', hint: 'agent 用 ask_user_question 问你时' }),
          h(SwitchRow, { title: '任务完成', path: 'events.completion', hint: '每轮结束（含中断/失败）' }),
          h('div', { style: styles.group }, '收件人与频率'),
          h(ListRow, {
            title: '收件人',
            path: 'targets',
            hint: '一行一个，格式 c2c:openid 或 group:openid；留空则用 im-qqbot 的私聊白名单',
            placeholder: 'c2c:A0ADA1F8…',
          }),
          h(TextRow, { title: '合并窗口（毫秒）', path: 'mergeWindowMs', type: 'number', hint: '同一会话连续多轮合并成一条通知' }),
          h(SecondsRow, {
            title: '审批通知间隔（秒）',
            path: 'approvalIntervalMs',
            hint: '你点过允许/拒绝后，这段时间内不再推审批通知；0 = 不限制',
          }),
          h(SecondsRow, {
            title: '未处理提醒（秒）',
            path: 'approvalReminderMs',
            hint: '审批推送后超过这么久还没处理，补发一条提醒；0 = 不提醒',
          }),
          h(TextRow, { title: '每人每分钟上限', path: 'perTargetPerMinute', type: 'number' }),
          h(ListRow, {
            title: '静音的目录',
            path: 'mutedCwds',
            hint: '一行一个，支持 * 通配',
            placeholder: 'D:/work/scratch-*',
          }),
          h('div', { style: styles.group }, '邮件补发（QQ 失败兜底）'),
          h(SwitchRow, {
            title: '启用邮件通道',
            path: 'digest.enabled',
            hint: '只会发给下面这个 SMTP 账号自己；关掉后漏发记录只进本地队列',
          }),
          h(SwitchRow, {
            title: '发送失败立即补发',
            path: 'digest.immediate',
            hint: 'QQ 发不出去马上用邮件补一条，不等周期汇总',
          }),
          h(TextRow, {
            title: '补发合并窗口（毫秒）',
            path: 'digest.coalesceMs',
            type: 'number',
            hint: '窗口内的多条失败合成一封，避免一次限流刷屏；0 = 逐条立即发',
          }),
          h(TextRow, {
            title: '汇总重试周期（分钟）',
            path: 'digest.intervalMinutes',
            type: 'number',
            hint: '补发邮件也失败时，多久再把队列汇总重试一次',
          }),
          h(TextRow, { title: 'SMTP 主机', path: 'digest.smtp.host', placeholder: 'smtp.qq.com' }),
          h(TextRow, { title: 'SMTP 端口', path: 'digest.smtp.port', type: 'number', hint: '只支持 465（TLS）' }),
          h(TextRow, {
            title: 'SMTP 账号',
            path: 'digest.smtp.user',
            placeholder: 'me@qq.com',
            hint: '收件人也是它自己，不需要另填地址',
          }),
          h(TextRow, {
            title: 'SMTP 密码',
            path: 'digest.smtp.password',
            type: 'password',
            hint: '留空则用 DSH 凭据里的 SMTP_PASSWORD（推荐）',
          }),
          h(TestMailRow, null),
          snapshot.writable === false
            ? h('div', { style: styles.error }, '宿主当前不接受写入（配置文件只读）。')
            : null,
        )
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'qq-notify',
        order: 60,
        label: 'QQ 通知',
      }, Section))
    }

    exports.name = 'qq-notify-client'
    exports.inject = ['slots', 'configForms']
    exports.apply = apply
    return module.exports
  },
})
