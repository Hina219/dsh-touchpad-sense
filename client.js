window.__ModuleLoader__.load({
  id: 'dsh-touchpad-sense',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/dsh-touchpad-sense'
    const CSS = `
[data-ts-panel]{display:flex;flex-direction:column;gap:18px;padding:8px 2px 24px;color:inherit;}
[data-ts-head]{font-size:16px;font-weight:600;}
[data-ts-row]{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:10px 0;border-bottom:1px solid rgba(127,127,127,.18);}
[data-ts-row] label{display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer;}
[data-ts-row] input[type=checkbox]{width:16px;height:16px;accent-color:#238b70;flex:none;}
[data-ts-row] input:disabled{opacity:.5;cursor:default;}
[data-ts-status]{font-size:12px;opacity:.75;line-height:1.5;}
[data-ts-warning]{font-size:12px;color:#b06035;line-height:1.5;}
[data-ts-error]{font-size:12px;color:#c94e4e;white-space:pre-wrap;overflow-wrap:anywhere;}
`

    function Panel() {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(API + '/state', { cache: 'no-store' })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          setState(await response.json())
        } catch (e) { setError(String(e?.message || e)) }
      }, [])

      React.useEffect(() => {
        load()
        const timer = setInterval(load, 2000)
        return () => clearInterval(timer)
      }, [load])

      const update = async (patch) => {
        setBusy(true)
        setError('')
        try {
          const response = await fetch(API + '/config', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          const result = await response.json()
          if (!response.ok || !result.ok) throw new Error(result.error || '更新失败')
          setState(result)
        } catch (e) { setError(String(e?.message || e)) }
        setBusy(false)
      }

      if (!state) return h('div', { 'data-ts-panel': '' }, '读取中…')
      const capture = Boolean(state.requested)
      return h('div', { 'data-ts-panel': '' },
        h('div', { 'data-ts-head': '' }, '触控板'),
        h('div', { 'data-ts-row': '' },
          h('label', null,
            h('input', { type: 'checkbox', checked: capture, disabled: busy,
              onChange: (event) => update({ captureEnabled: event.target.checked }) }),
            '采集输入')),
        h('div', { 'data-ts-row': '' },
          h('label', null,
            h('input', { type: 'checkbox', checked: Boolean(state.wake?.enabled),
              disabled: busy || !capture,
              onChange: (event) => update({ wakeEnabled: event.target.checked }) }),
            'AI 自动回应')),
        h('div', { 'data-ts-status': '' },
          capture
            ? (state.ready ? `数字化仪已注册 · 收到 ${state.totalSamples || 0} 条报告`
              : '正在等待数字化仪')
            : '采集已关闭'),
        h('div', { 'data-ts-warning': '' }, '系统指针仍可由触控板控制；当前接口不支持独占采集。'),
        (error || state.lastError || state.wake?.lastWakeError)
          ? h('div', { 'data-ts-error': '' }, error || state.lastError || state.wake.lastWakeError)
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-touchpad-sense')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-touchpad-sense: settings style')
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'touchpad-sense', order: 45, label: '触控板' },
          () => h(Panel),
        ))
      },
    }
  },
})
