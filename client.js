window.__ModuleLoader__.load({
  id: '@stjq12/dsh-remote-control',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * Remote Control — browser half (footer button + dialog).
     *
     * The footer button opens a dialog with the switch, the bridge address and
     * the access token, and writes the Host transport setting.
     *
     * This half must never break page boot: optional modules are read inside
     * `apply`, every failure only logs, and the contributed components guard
     * themselves against missing props.
     */
    const NS = 'dsh-remote-control'
    // The Host may mount the card under a different marker; the page hook exposes
    // the effective value before this bundle loads.
    const BASE = (typeof window !== 'undefined' && typeof window.__remoteControlBase === 'string' && window.__remoteControlBase !== '')
      ? window.__remoteControlBase
      : '/remote-control'
    const MARKER = { 'x-dsh-remote-control': '1' }
    const apiPrefix = `${BASE}/api`

    function rewriteApiUrl(url) {
      const text = String(url)
      if (/(^|\/)api(\/|$)/.test(text)) return text.replace(/(^|\/)api(\/|$)/, (_match, lead, tail) => `${lead}${apiPrefix.slice(1)}${tail}`)
      return `${apiPrefix}/${text.replace(/^\/+/, '')}`
    }

    function createBridgeFetch(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers ?? (typeof input === 'object' && !(input instanceof URL) ? input.headers : undefined))
      headers.set('x-dsh-remote-control', '1')
      return fetch(rewriteApiUrl(url), { ...(init ?? {}), headers })
    }

    /**
     * API-socket factory: a browser cannot attach a credential to a WebSocket,
     * so the marker socket carries a first-frame hello and the Host transport
     * connects on to the bridge (or the local Host) with the credential it owns.
     */
    function createBridgeWebSocket(url, base) {
      const SocketCtor = globalThis.WebSocket
      const absolute = new URL(url, document.baseURI)
      absolute.pathname = rewriteApiUrl(absolute.pathname)
      absolute.search = ''
      absolute.hash = ''
      absolute.protocol = absolute.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new SocketCtor(absolute.href)
      let hello = false
      return {
        get readyState() {
          return socket.readyState
        },
        send(data) {
          if (!hello && socket.readyState === 1) {
            hello = true
            socket.send(JSON.stringify({ 'remote-control/hello': base }))
            socket.send(String(data))
            return
          }
          socket.send(String(data))
        },
        close(code, reason) {
          try {
            socket.close(code, reason)
          } catch {
            socket.close()
          }
        },
        addEventListener(event, listener, options) {
          if (event === 'message') {
            socket.addEventListener('message', (message) => {
              const text = typeof message.data === 'string' ? message.data : ''
              if (text.startsWith('{"remote-control/')) return
              listener({ data: message.data })
            }, options)
            return
          }
          socket.addEventListener(event, options?.once === true ? () => listener({}) : listener)
        },
        removeEventListener(event, listener) {
          socket.removeEventListener(event, listener)
        },
      }
    }

    /**
     * Read the Host transport snapshot (the controlling half's own state).
     *
     * Named distinctly from the preset `readState` below: two same-named
     * declarations were silently shadowing each other, which made the footer
     * button read the wrong endpoint.
     * @returns {Promise<object>} transport snapshot.
     */
    async function readTransportState() {
      const response = await fetch(`${BASE}/transport`, { headers: MARKER, cache: 'no-store' })
      if (!response.ok) throw new Error(`state request failed (HTTP ${response.status})`)
      return response.json()
    }

    async function postAsync(body) {
      const response = await fetch(`${BASE}/transport`, {
        method: 'POST',
        headers: { ...MARKER, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      })
      return response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
    }

    /**
     * Loopback management routes of the being-controlled half. They live on the
     * Host web server (registered by `lib/bridge-host.js`), not under the marker
     * prefix, so this page calls them with same-origin credentials directly.
     */
    const BRIDGE = {
      status: '/rbr/status',
      toggle: '/rbr/toggle',
      token: '/rbr/token',
      port: '/rbr/port',
    }

    async function readBridgeStatus(signal) {
      const response = await fetch(BRIDGE.status, { credentials: 'same-origin', cache: 'no-store', headers: MARKER, signal })
      if (!response.ok) throw new Error(`bridge status failed (HTTP ${response.status})`)
      return response.json()
    }

    async function postBridgeStatus(path, body, signal) {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { ...MARKER, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.message ?? payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    /** Session-storage key holding this tab's transport decision. */
    const FLAG = 'dsh-remote-control/switch'

    /**
     * @param {object} ctx - plugin context.
     * @returns {object | undefined} the Host transport service when present.
     */
    function hostTransport(ctx) {
      return ctx.get('bridgeProxy')
    }

    /**
     * @param {{ state?: string }} snapshot - Host transport snapshot.
     * @returns {{ want: boolean, switchState: string, address: string }} this tab's decision.
     */
    function decisionOf(snapshot) {
      return {
        want: snapshot?.state === 'ready',
        switchState: typeof snapshot?.state === 'string' ? snapshot.state : 'off',
        address: typeof snapshot?.address === 'string' ? snapshot.address : '',
      }
    }

    function readFlags() {
      try {
        const raw = globalThis.sessionStorage?.getItem(FLAG)
        return { [FLAG]: raw === null || raw === undefined ? undefined : JSON.parse(raw) }
      } catch {
        return {}
      }
    }

    function writeFlag(key, value) {
      try {
        globalThis.sessionStorage?.setItem(key, JSON.stringify(value))
      } catch {}
    }

    /**
     * Whether this window is the remote-controller side.
     *
     * The download affordances belong to the remote window only: the local
     * window keeps DSH's own open/download controls, and `performDownload`
     * intentionally does nothing there.
     * @returns {boolean} true when the page hook has switched this tab to remote.
     */
    function remoteWindow() {
      try {
        return typeof globalThis.__remoteControlWant === 'function' && globalThis.__remoteControlWant() === true
      } catch (error) {
        return false
      }
    }

    /**
     * Record the saved switch for this tab and reload the page into it.
     * @param {object} payload - the Host's save answer.
     */
    /**
     * Record the transport decision for this tab, tell the live page script, and
     * reload.
     *
     * The reload is what the old Apply button did, and it is kept deliberately:
     * the page script flips new requests immediately, but views that already
     * subscribed over the old transport keep their old streams until the page is
     * rebuilt, which reads as "the switch did nothing".
     * @param {object} payload - the Host's transport snapshot.
     */
    function applyAndReload(payload, t) {
      const decision = decisionOf(payload)
      const previous = readFlags()[FLAG]
      writeFlag(FLAG, { ...decision, probedFrom: previous?.probedFrom ?? 'local' })
      // Coming back from the remote Host deserves a word, so the window does not
      // appear to have changed itself. It is left for the next load to show, for the
      // same reason the failure notice is: this load is about to be replaced.
      if (previous?.want === true && decision.want !== true) leaveNotice('normal', t('notice.local'))
      if (typeof globalThis.__remoteControlWant === 'function') globalThis.__remoteControlWant(decision.want === true)
      globalThis.location.reload()
    }

    /**
     * Leave a sentence for the load that follows.
     * @param {'normal'|'error'} kind - `normal` for an operator-driven switch-off.
     * @param {string} message - what to show.
     */
    function leaveNotice(kind, message) {
      try {
        globalThis.sessionStorage?.setItem(NOTICE_KEY, JSON.stringify({ kind, message, at: Date.now() }))
      } catch (error) { /* the notice is nice to have */ }
    }

    /**
     * Keep this tab's switch decision in step with the Host.
     *
     * The page script reads it before the shell starts, so it must be written
     * synchronously by the dialog. This check covers the other direction: a page
     * opened while the Host switch says something else reloads once.
     * @param {object | undefined} transport - Host transport service.
     */
    function syncDecision(transport) {
      if (transport === undefined || typeof transport.snapshot !== 'function') return
      // A pending notice means this load *is* the fallback: the previous load wrote
      // the decision and reloaded, and the sentence has not been shown yet. Syncing
      // now would overwrite that decision with the Host's older answer and could
      // reload again, which is what made the notice appear only sometimes.
      let pending
      try { pending = globalThis.sessionStorage?.getItem(NOTICE_KEY) } catch (error) { pending = null }
      if (pending !== null && pending !== undefined) return
      const snapshot = transport.snapshot()
      const decision = decisionOf(snapshot)
      const previous = readFlags()[FLAG]
      writeFlag(FLAG, { ...decision, probedFrom: previous?.probedFrom ?? 'host' })
      // Apply the Host decision to this page's live switch. Reload only when the
      // page booted on the other side (a restart forces the switch off), so the
      // view is rebuilt on the transport that is actually active.
      if (typeof globalThis.__remoteControlWant === 'function') globalThis.__remoteControlWant(decision.want === true)
      if (previous === undefined || previous.want !== decision.want) globalThis.location.reload()
    }

    const styles = `
/* Same box as the document preview's own tool buttons, copied from the rule DSH
   ships so this control needs no knowledge of its CSS-module hash. */
.rrcTool{width:28px;height:28px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer;background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:6px;line-height:1;display:inline-flex}
.rrcTool:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.rrcTool svg{width:15px;height:15px}
.rrcTool:disabled,.rrcTool[aria-disabled="true"]{opacity:.35;cursor:not-allowed}
.rrcOverlay{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32))}
.rrcDialog{box-sizing:border-box;width:min(640px,100%);height:min(760px,calc(100vh - 32px));overflow:hidden;border-radius:var(--dsw-radius-panel,16px);border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24));background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:var(--dsw-elevation-prominent,0 20px 60px rgba(0,0,0,.22));padding:20px;display:flex;flex-direction:column;gap:14px}
.rrcHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none}
.rrcHeaderActions{display:flex;align-items:center;gap:2px;flex:none}
.rrcHeading{margin:0;font-size:16px;font-weight:600}
.rrcClose{width:28px;height:28px;border:none;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1}
.rrcClose:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rrcHelp{display:flex;flex-direction:column;gap:14px;padding-right:4px}
.rrcHelpIntro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.rrcHelpSection{display:flex;flex-direction:column;gap:7px}
.rrcHelpTitle{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}
.rrcHelpList{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:7px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.rrcHelpList li::marker{color:var(--dsw-alias-label-tertiary)}
.rrcHelpGithub{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24));padding-top:12px}
.rrcHelpGithub a{color:var(--dsw-alias-brand-primary);text-decoration:none;overflow-wrap:anywhere}
.rrcHelpDisclaimer{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.rrcTabs{display:flex;gap:4px;flex:none}
.rrcTab{flex:1;text-align:center;cursor:pointer;border:0;padding:12px 14px;border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;transition:background .14s ease}
.rrcTab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.rrcTab[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-active,#e8ecf2);color:var(--dsw-alias-label-primary);font-weight:600}
.rrcTabBody{display:flex;flex-direction:column;gap:14px;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;overflow-anchor:none;padding-right:2px}
.rrcRow{justify-content:space-between;align-items:center;gap:16px;display:flex}
.rrcRowText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.rrcTitle{font-size:13px;font-weight:500;line-height:20px}
.rrcDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.rrcDesc[data-invalid=true]{color:#d93a3a}
.rrcField[data-invalid=true] .rrcLabel{color:#d93a3a}
.rrcField{display:flex;flex-direction:column;gap:6px}
.rrcLabel{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);line-height:16px}
.rrcSwitch{position:relative;flex:none;width:40px;height:24px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2);cursor:pointer;background:var(--dsw-alias-bg-layer-2);transition:background .15s ease,border-color .15s ease;padding:0}
.rrcSwitch[aria-checked=true]{background:var(--dsw-alias-state-success-primary,#2fb171);border-color:transparent}
.rrcSwitch:disabled{opacity:.45;cursor:not-allowed}
.rrcKnob{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.rrcSwitch[aria-checked=true] .rrcKnob{transform:translateX(15px)}
.rrcSelectRow{display:flex;gap:8px;align-items:center}
.rrcSelect{box-sizing:border-box;flex:1;min-width:0;height:32px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24));border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1,Canvas));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 8px;cursor:pointer}
.rrcSelect:disabled{opacity:.5;cursor:not-allowed}
.rrcDurationSelect{flex:0 0 112px;width:112px}
.rrcIconBtn{box-sizing:border-box;flex:0 0 32px;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24));border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;line-height:0}
.rrcIconBtn svg{display:block;flex:none}
.rrcIconBtn[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rrcIconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rrcIconBtn:disabled{opacity:.4;cursor:not-allowed}
.rrcTargetRow{display:flex;gap:8px;align-items:center}
.rrcInput{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24));border-radius:var(--dsw-radius-md);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1,Canvas));color:var(--dsw-alias-label-primary);padding:0 10px;font-size:13px;line-height:22px;appearance:none;-webkit-appearance:none;transition:border-color .14s ease,box-shadow .14s ease}
.rrcInput:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}
.rrcInput:focus-visible{outline:none}
.rrcInput:disabled{opacity:.55;cursor:not-allowed}
.rrcInput[data-invalid=true]{border-color:#d93a3a;box-shadow:inset 0 0 0 1px #d93a3a}
.rrcInput[data-invalid=true]:focus{border-color:#d93a3a;box-shadow:inset 0 0 0 1px #d93a3a}
.rrcInputRow{display:flex;gap:8px;align-items:center}
.rrcCode{flex:1;min-width:0;box-sizing:border-box;height:32px;display:block;padding:0 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1,Canvas));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:32px;user-select:all;white-space:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
.rrcCode::-webkit-scrollbar{height:0}
.rrcCodeMasked{letter-spacing:2px;color:var(--dsw-alias-label-tertiary);overflow:hidden}
.rrcHint{color:#d93a3a;font-size:11px;line-height:16px}
.rrcActions{display:flex;justify-content:flex-end;gap:8px;flex:none;border-top:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24));padding-top:12px}
.rrcPrimary{box-sizing:border-box;border-radius:var(--dsw-radius-md);height:34px;font:inherit;cursor:pointer;justify-content:center;align-items:center;padding:0 18px;font-size:13px;line-height:20px;display:inline-flex;border:none;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
.rrcPrimary:disabled{opacity:.5;cursor:not-allowed}
.rrcSecondary{box-sizing:border-box;border-radius:8px;height:34px;font:inherit;cursor:pointer;justify-content:center;align-items:center;padding:0 14px;font-size:13px;line-height:20px;display:inline-flex;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24));color:var(--dsw-alias-label-primary);background:0 0}
.rrcSecondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.rrcSecondary:disabled{opacity:.5;cursor:not-allowed}
.rrcStatus{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0;min-height:18px;display:flex;align-items:center;gap:6px;flex:none}
.rrcStatus[data-tone=ok]{color:var(--dsw-alias-label-secondary)}
.rrcStatus[data-tone=error]{color:#d93a3a}
.rrcDot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;opacity:.7}
.rrcModalOverlay{position:fixed;inset:0;z-index:9100;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32))}
.rrcModal{box-sizing:border-box;width:min(400px,100%);border-radius:var(--dsw-radius-panel,16px);border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24));background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary);box-shadow:0 16px 48px rgba(0,0,0,.28);padding:20px;display:flex;flex-direction:column;gap:14px}
.rrcModalHeading{margin:0;font-size:15px;font-weight:600}
.rrcRadio{display:flex;flex-direction:column;gap:8px}
.rrcRadioLabel{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
.rrcRadioLabel input{cursor:pointer;margin:0}
`

    /**
     * Append the dialog stylesheet once per document.
     *
     * Guarded by a data attribute rather than a module flag so a second copy of
     * this bundle in the same page cannot stack duplicate rules.
     */
    function injectStyle() {
      const tagId = '@stjq12/dsh-remote-control/dialog.css'
      if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = '@stjq12/dsh-remote-control'
      tag.dataset.pluginCss = tagId
      tag.textContent = styles
      document.head.appendChild(tag)
    }

    // ── Shared state ─────────────────────────────────────────────────────────
    // Both tabs are the same form over a different section of one record; only
    // the copy, the token affordances and which host the switch drives differ.

    /** Prefix serving the preset record (see `installStateRoutes`). */
    const STATE = `${BASE}/state`
    /** Where the page script leaves the sentence to show after a fallback. */
    const NOTICE_KEY = 'dsh-remote-control/notice'

    /** Repository URL shown in the help page. */
    const GITHUB_URL = 'https://github.com/stjq12/dsh-remote-control'

    async function readState(signal) {
      const response = await fetch(STATE, { credentials: 'same-origin', cache: 'no-store', headers: MARKER, signal })
      if (!response.ok) throw new Error(`state request failed (HTTP ${response.status})`)
      return response.json()
    }

    async function postState(body) {
      const response = await fetch(STATE, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { ...MARKER, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload?.ok !== true) {
        const error = new Error(payload?.error ?? `HTTP ${response.status}`)
        error.code = typeof payload?.code === 'string' ? payload.code : undefined
        error.field = typeof payload?.field === 'string' ? payload.field : undefined
        throw error
      }
      return payload
    }

    /**
     * Turn the remote transport off after its link failed.
     *
     * Called by the page script, which is the only place a dead link is visible.
     * It uses the same `toggle` action the card's own switch uses, so the state, the
     * dot and the saved credentials end up exactly as if the operator had clicked
     * it — the address and token are read back from the Host rather than resent
     * blind.
     * @param {{ kind?: string, message?: string }} [detail] - what failed.
     * @returns {Promise<boolean>} whether the Host accepted the change.
     */
    async function failBackToLocal(detail) {
      try {
        // Turning off needs no target: the Host only validates host, port and token
        // when the switch is being turned on, and the saved preset is left alone.
        const answer = await postState({
          section: 'remote',
          action: 'toggle',
          enabled: false,
          host: '',
          port: 0,
          token: '',
        })
        const decision = decisionOf(answer?.transport)
        writeFlag(FLAG, decision)
        if (typeof globalThis.__remoteControlWant === 'function') globalThis.__remoteControlWant(false)
        return true
      } catch {
        return false
      }
    }

    /** Host part of a `host:port` preset name. */
    function formatTarget(host, port) {
      return host === '' ? '' : `${host}:${port}`
    }

    /**
     * Join a host and a port into the single field the card edits, in the form
     * every other tool uses: `host:port`, with IPv6 bracketed so the colons in
     * the address cannot be mistaken for the separator.
     * @param {string} host - IP literal.
     * @param {number|string} port - port number.
     * @returns {string} the combined text.
     */
    function joinTarget(host, port) {
      if (host === '') return ''
      const shown = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
      return `${shown}:${port}`
    }

    /**
     * Whether one host is a concrete IPv4 literal suitable for a bind.
     * @param {string} host - candidate host.
     * @returns {boolean} true for four decimal octets in range.
     */
    function isIPv4(host) {
      const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
      if (match === null) return false
      return match.slice(1).every((part) => (part === '0' || !part.startsWith('0')) && Number(part) <= 255)
    }

    /**
     * Whether one host is an IPv6 literal. The URL parser is the browser's own
     * IPv6 grammar, so this accepts the same compressed/mapped forms DSH does
     * without maintaining a second hand-written regex.
     * @param {string} host - candidate host, without brackets.
     * @returns {boolean} true for a valid IPv6 literal.
     */
    function isIPv6(host) {
      if (!host.includes(':')) return false
      try {
        const bare = host.includes('%') ? host.slice(0, host.indexOf('%')) : host
        return new URL(`http://[${bare}]/`).hostname !== ''
      } catch (error) {
        return false
      }
    }

    /**
     * Whether a host is a concrete IP literal, not a hostname or wildcard.
     * @param {string} host - candidate host.
     * @returns {boolean} true for IPv4/IPv6.
     */
    function isIpLiteral(host) {
      return isIPv4(host) || isIPv6(host)
    }

    /**
     * Whether a host is a wildcard bind address (rejected by the server).
     * @param {string} host - candidate host.
     * @returns {boolean} true for 0.0.0.0 / :: and their spellings.
     */
    function isWildcardHost(host) {
      const bare = String(host ?? '').includes('%') ? String(host).slice(0, String(host).indexOf('%')) : String(host ?? '')
      const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare)
      if (v4 !== null) return v4.slice(1).every((part) => Number(part) === 0)
      let text = bare.toLowerCase()
      const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text)
      if (tail !== null) {
        const octets = tail[1].split('.').map(Number)
        if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
        text = `${text.slice(0, -tail[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
      }
      const halves = text.split('::')
      if (halves.length > 2) return false
      const head = halves[0] === '' ? [] : halves[0].split(':')
      const rest = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
      let groups
      if (halves.length === 2) {
        const fill = 8 - head.length - rest.length
        if (fill < 0) return false
        groups = [...head, ...Array.from({ length: fill }, () => '0'), ...rest]
      } else {
        groups = head
      }
      if (groups.length !== 8) return false
      const numbers = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN))
      if (numbers.some((part) => Number.isNaN(part))) return false
      if (numbers.every((part) => part === 0)) return true
      return numbers[0] === 0 && numbers[1] === 0 && numbers[2] === 0 && numbers[3] === 0 && numbers[4] === 0 && numbers[5] === 0xffff && numbers[6] === 0 && numbers[7] === 0
    }

    /**
     * Split one `host:port` field into its parts.
     *
     * Accepts `host:port` and `[v6]:port`; a bare host (no colon) reports a
     * missing port rather than guessing one, because silently defaulting would
     * save a preset the operator never typed.
     * @param {string} text - the field's current value.
     * @returns {{ host?: string, port?: number, error?: 'host' | 'port' | 'range' | 'privileged' }}
     */
    function splitTarget(text, defaultPort = 0) {
      const raw = String(text ?? '').trim()
      if (raw === '') return { error: 'host' }
      let host = ''
      let portText = ''
      if (raw.startsWith('[')) {
        const close = raw.indexOf(']')
        if (close === -1) return { error: 'host' }
        host = raw.slice(1, close)
        portText = raw.slice(close + 1).replace(/^:/, '')
      } else {
        const at = raw.lastIndexOf(':')
        if (at === -1) {
          if (defaultPort > 0) return { host: raw, port: defaultPort }
          return { host: raw, error: 'port' }
        }
        host = raw.slice(0, at)
        portText = raw.slice(at + 1)
      }
      host = host.trim()
      if (host === '') return { error: 'host' }
      if (portText === '') {
        if (defaultPort > 0) return { host, port: defaultPort }
        return { host, error: 'port' }
      }
      const port = Number(portText)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { host, error: 'range' }
      if (port < 1024) return { host, port, error: 'privileged' }
      return { host, port }
    }

    const SERVICE_DURATION_OPTIONS = [
      [5 * 60_000, 'duration.5m'],
      [30 * 60_000, 'duration.30m'],
      [60 * 60_000, 'duration.1h'],
      [3 * 60 * 60_000, 'duration.3h'],
      [12 * 60 * 60_000, 'duration.12h'],
      [24 * 60 * 60_000, 'duration.24h'],
      [0, 'duration.permanent'],
    ]

    /**
     * One tab: switch, preset picker, address, port, token, save.
     *
     * The switch is an action — it commits on click and never needs Save. Save
     * exists to record the form as a preset, and only asks for a name once the
     * form validates; without a name it uses `host:port`.
     * @param {object} props - `{ section, copy, t, onStatusChange, onAfterSave }`.
     * @returns the tab body.
     */
    function PresetTab({ section, copy, t, onStatusChange }) {
      const [state, setState] = React.useState(undefined)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      // One text field holds `host:port`; `splitTarget` derives the parts whenever
      // the form is read, so the card never keeps two sources of truth in sync.
      const [target, setTarget] = React.useState('')
      const [token, setToken] = React.useState('')
      const [fileRoot, setFileRoot] = React.useState('')
      const [fileMode, setFileMode] = React.useState('off')
      const [durationValue, setDurationValue] = React.useState(60 * 60_000)
      const [reveal, setReveal] = React.useState(false)
      const [invalid, setInvalid] = React.useState({})
      const [naming, setNaming] = React.useState(undefined)
      const [copied, setCopied] = React.useState(false)

      const view = state?.[section]
      const active = view?.active
      const live = view?.status
      const transport = state?.transport

      // Adopt the selected preset into the form whenever the record changes.
      //
      // With no preset left the form clears, because there is nothing to point at.
      // The local section keeps its token: that string identifies this machine and
      // survives deleting the endpoint it was stored with, so an already-paired
      // controller does not have to re-pair after a cleanup.
      // The endpoint and the credential adopt separately: rotating the token keeps the
      // preset id and address, so re-running the address half would overwrite an IP
      // the operator was still typing.
      React.useEffect(() => {
        if (active === undefined) {
          setTarget('')
          setInvalid({})
          return
        }
        setTarget(active.host === '' ? '' : joinTarget(active.host, active.port))
        setInvalid({})
      }, [active?.id, active?.host, active?.port, view?.activeId])

      React.useEffect(() => {
        // With no preset the local machine still keeps its credential, so show the
        // section-level token instead of clearing the field. While the local
        // listener is actually up, show the token it is using: selecting another
        // preset updates only the record, and copying the selected preset's token
        // would hand the peer a credential the live listener does not accept.
        const liveToken = section === 'local' && live?.listening === true && typeof live.token === 'string'
          ? live.token
          : undefined
        setToken(liveToken ?? (active === undefined ? (section === 'local' ? (view?.token ?? '') : '') : (active.token ?? '')))
      }, [active?.id, active?.token, view?.activeId, view?.token, section, live?.token, live?.listening])

      React.useEffect(() => {
        setFileMode(view?.fileRead?.mode ?? 'off')
        setFileRoot(view?.fileRead?.root ?? '')
      }, [view?.fileRead?.mode, view?.fileRead?.root, view?.activeId])

      React.useEffect(() => {
        setDurationValue(view?.durationMs ?? 60 * 60_000)
      }, [view?.durationMs, view?.activeId])

      React.useEffect(() => {
        if (state !== undefined) return undefined
        const controller = new AbortController()
        readState(controller.signal).then(
          (next) => {
            if (!controller.signal.aborted) setState(next)
          },
          (reason) => {
            if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
          },
        )
        return () => controller.abort()
      }, [state])

      // The card can stay open while a listener dies or another tab changes a
      // preset; refresh on focus instead of polling on a timer.
      React.useEffect(() => {
        let stopped = false
        let controller
        const refresh = () => {
          controller?.abort()
          controller = new AbortController()
          readState(controller.signal).then((next) => {
            if (!stopped && !controller.signal.aborted) setState(next)
          }, () => {})
        }
        window.addEventListener('focus', refresh)
        return () => {
          stopped = true
          controller?.abort()
          window.removeEventListener('focus', refresh)
        }
      }, [])

      const enabled = view?.enabled === true
      const transportAddress = section === 'remote' && enabled === true && typeof transport?.address === 'string' && transport.address !== ''
        ? transport.address
        : undefined
      const endpoint = transportAddress ?? (active === undefined
        ? ''
        : (section === 'local' && live?.listening === true ? joinTarget(live.host, live.port) : joinTarget(active.host, active.port)))
      const liveError = section === 'local' && enabled && typeof live?.error === 'string' ? live.error : ''
      const targetMessage = invalid.target !== null && typeof invalid.target === 'object'
        ? String(invalid.target.message ?? '')
        : copy.addressDesc

      React.useEffect(() => {
        if (typeof onStatusChange !== 'function' || state === undefined) return
        const problem = error !== '' ? error : liveError
        const listening = section !== 'local' || live === undefined || live.listening === true
        const onText = section === 'local' && !listening
          ? t('being.notListening')
          : `${copy.on}: ${endpoint}`
        onStatusChange({
          tone: problem !== '' ? 'error' : enabled ? 'ok' : 'plain',
          text: problem !== '' ? problem : enabled ? onText : copy.off,
        })
      }, [state, error, enabled, endpoint, liveError, live?.listening, onStatusChange, copy, section, t])

      const apply = (next) => setState(next)

      /**
       * POST one mutation and adopt its answer.
       * @param {object} body - action payload.
       * @returns {Promise<object | undefined>} the answer, or undefined on failure.
       */
      const runAction = async (body) => {
        setBusy(true)
        setError('')
        try {
          const answer = await postState(body)
          apply(answer)
          // The footer badge and any other local surface refresh when this
          // section changes, so a manual close and a timer close look identical.
          if (section === 'local' && typeof window !== 'undefined') {
            try { window.dispatchEvent(new Event('remote-control/state-changed')) } catch {}
          }
          return answer
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason)
          const code = reason && typeof reason === 'object' ? reason.code : undefined
          const field = reason && typeof reason === 'object' ? reason.field : undefined
          if (field === 'target') {
            // Sentence 1 (the field description) turns red for every target
            // error. Only the two bind outcomes get an extra sentence below it.
            const target = code === 'EADDRINUSE'
              ? { message: t('error.portInUse') }
              : code === 'EADDRNOTAVAIL'
                ? { message: t('error.ipNotLocal') }
                : true
            setInvalid({ target })
            setError('')
          } else if (field === 'token') {
            setInvalid({ token: message })
            setError('')
          } else {
            setError(message)
          }
          return undefined
        } finally {
          setBusy(false)
        }
      }

      const toggle = async () => {
        if (view === undefined || busy) return
        const next = !enabled
        if (next) {
          // Turning on runs the same validation Save does, minus the naming step:
          // an unusable target must not silently start listening.
          const problems = validate()
          if (Object.keys(problems).length > 0) {
            setInvalid(problems)
            return
          }
        }
        const parts = splitTarget(target, section === 'remote' ? 7400 : 0)
        const answer = await runAction({
          section,
          action: 'toggle',
          enabled: next,
          host: parts.host,
          port: parts.port,
          token: token.trim(),
        })
        // The remote switch changes this window's transport, so the page has to be
        // rebuilt on it — same as the old Apply button. The local switch only opens
        // a listener and needs no reload.
        if (answer !== undefined && section === 'remote') applyAndReload(answer.transport, t)
      }

      // A running local listener owns a wall-clock expiry. When this card is
      // open, close it through the same `/state` toggle the manual switch uses
      // (slightly early, so the Host-side fallback timer is cleared by the
      // request). If the card is closed, the Host timer is the only actor.
      React.useEffect(() => {
        if (section !== 'local' || enabled !== true) return undefined
        const expiresAt = live?.expiresAt
        if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return undefined
        let stopped = false
        const closeByTimer = () => {
          if (stopped) return
          void runAction({
            section: 'local',
            action: 'toggle',
            enabled: false,
            host: '',
            port: 0,
            token: '',
          })
        }
        const delay = expiresAt - Date.now() - 250
        if (delay <= 0) {
          closeByTimer()
          return undefined
        }
        const timer = setTimeout(closeByTimer, delay)
        return () => {
          stopped = true
          clearTimeout(timer)
        }
      }, [section, enabled, live?.expiresAt])

      /**
       * Only the remote token is typed/pasted; the local one comes from rotate.
       *
       * Declared before `validate` reads it: `validate` is a hoisted function, so
       * calling it during the first render would hit the temporal dead zone of this
       * `const` and throw, which silently aborted every Save.
       */
      const tokenEditable = section === 'remote'

      /**
       * Validate only the address field. Runs before the switch/Save and on blur,
       * so leaving a bad value shows the red frame before any request is made.
       * @returns {{ target?: true }} target problems.
       */
      function validateTarget(text = target, completeOnly = false) {
        const problems = {}
        const parts = splitTarget(text, section === 'remote' ? 7400 : 0)
        // Any pre-toggle validation failure turns sentence 1 red. The detailed
        // reason is intentionally not another paragraph; only the two bind
        // outcomes below get their own sentence.
        if (parts.error === 'host' || parts.error === 'port') {
          // While typing, wait for a full host:port before flagging a missing
          // separator; blur/switch still validates incomplete values.
          if (!completeOnly) problems.target = true
        } else if (parts.error === 'range' || parts.error === 'privileged') {
          problems.target = true
        } else if (section === 'local') {
          const host = parts.host ?? ''
          if (isWildcardHost(host) || !isIpLiteral(host)) problems.target = true
        }
        return problems
      }

      /** Validate the form; the target field reports address and port problems alike. */
      function validate() {
        const problems = validateTarget()
        // The local token cannot be typed, so an empty one is a state to fix with
        // Rotate, not a validation error on Save.
        if (tokenEditable && token.trim() === '') problems.token = t('error.tokenRequired')
        return problems
      }

      /** Show/clear the target error when focus leaves the address field. */
      const blurTarget = () => {
        const problems = validateTarget()
        setInvalid((current) => ({ ...current, target: problems.target }))
      }

      const requestSave = () => {
        // Save checks the address field, because an existing red frame must block
        // it. The token is intentionally not validated: an empty token is a valid
        // saved preset until the switch is turned on.
        const problems = validateTarget()
        if (problems.target !== undefined || invalid.target !== undefined) {
          setInvalid((current) => ({ ...current, ...problems, target: problems.target ?? current.target }))
          return
        }
        setInvalid({})
        const parts = splitTarget(target, section === 'remote' ? 7400 : 0)
        setNaming({ name: formatTarget(parts.host ?? '', parts.port ?? '') })
      }

      const confirmSave = async ({ name }) => {
        const answer = await runAction({
          section,
          action: 'save',
          name,
          host: splitTarget(target, section === 'remote' ? 7400 : 0).host,
          port: splitTarget(target, section === 'remote' ? 7400 : 0).port,
          token: token.trim(),
        })
        if (answer === undefined) return
        setNaming(undefined)
        // Save is record-only. The switch, not Save, moves the live transport.
      }

      const selectPreset = (id) => {
        if (id === view?.activeId) return
        // Selecting only updates which preset's IP/token the form shows. It must
        // not reload or move the live transport; the switch does that.
        void runAction({ section, action: 'select', id })
      }

      const deleteActive = async () => {
        // No length guard: deleting the last preset is allowed and leaves the
        // section with no target, which the form effect then clears.
        if (active === undefined) return
        if (typeof globalThis.confirm === 'function' && globalThis.confirm(`${t('preset.delete')}?`) !== true) return
        const wasEnabled = enabled
        const answer = await runAction({ section, action: 'delete', id: active.id })
        // Deleting the active remote preset switches the record and the proxy off.
        // Rebuild the page so it stops using the deleted endpoint immediately.
        if (answer !== undefined && section === 'remote' && wasEnabled) applyAndReload(answer.transport, t)
      }

      const copyToken = () => {
        if (token === '') return
        const copied = () => {
          setCopied(true)
          globalThis.setTimeout(() => setCopied(false), 1600)
        }
        const clipboard = globalThis.navigator?.clipboard
        if (clipboard?.writeText !== undefined) {
          void clipboard.writeText(token).then(copied, fallbackCopy)
          return
        }
        // `navigator.clipboard` is unavailable on plain-HTTP LAN origins; the
        // copy button must still work there because that is a common way to open
        // the card from another device.
        function fallbackCopy() {
          try {
            const area = document.createElement('textarea')
            area.value = token
            area.setAttribute('readonly', 'readonly')
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            const ok = document.execCommand('copy')
            area.remove()
            if (ok) copied()
          } catch (error) { /* no clipboard available; leave the token visible */ }
        }
        fallbackCopy()
      }

      const ready = view !== undefined
      // Deleting the last preset is allowed: the section simply ends up with no
      // target, which turns the switch off and clears the form.
      const canDelete = ready && active !== undefined
      const fileRead = view?.fileRead ?? { mode: 'off', root: null }
      const setFileRead = (nextMode, nextRoot = fileRoot) => {
        // Update the control immediately; the Host request is authoritative but
        // must not make the select snap back (and the root field appear only
        // after a round trip) on every change.
        setFileMode(nextMode)
        void runAction({ section: 'local', action: 'file-read', mode: nextMode, root: nextRoot }).then((answer) => {
          if (answer === undefined) setFileMode(view?.fileRead?.mode ?? 'off')
        })
      }
      const commitFileRoot = () => {
        if (fileMode !== 'shared') return
        const next = fileRoot.trim()
        if (next === (fileRead.root ?? '')) return
        setFileRead('shared', next)
      }
      const changeDuration = (next) => {
        setDurationValue(next)
        void runAction({ section: 'local', action: 'duration', durationMs: next }).then((answer) => {
          if (answer === undefined) setDurationValue(view?.durationMs ?? 60 * 60_000)
        })
      }

      return h(
        'div',
        { className: 'rrcTabBody' },
        h(
          'div',
          { className: 'rrcRow' },
          h(
            'div',
            { className: 'rrcRowText' },
            h('span', { className: 'rrcTitle' }, copy.toggle),
            h('span', { className: 'rrcDesc' }, ready ? (enabled ? copy.ready : copy.idle) : t('status.loading')),
          ),
          section === 'local'
            ? h(
                'select',
                {
                  id: 'rrc-duration',
                  className: 'rrcSelect rrcDurationSelect',
                  'aria-label': t('duration.label'),
                  style: { border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.24))' },
                  value: String(durationValue),
                  disabled: !ready || busy,
                  onChange: (event) => changeDuration(Number(event.target.value)),
                },
                SERVICE_DURATION_OPTIONS.map(([value, key]) => h('option', { key: String(value), value: String(value) }, t(key))),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              className: 'rrcSwitch',
              'aria-checked': enabled ? 'true' : 'false',
              'aria-label': copy.toggle,
              disabled: !ready || busy,
              onClick: toggle,
            },
            h('span', { className: 'rrcKnob' }),
          ),
        ),
        h(
          'div',
          { className: 'rrcField' },
          h('label', { className: 'rrcLabel', htmlFor: `rrc-preset-${section}` }, t('preset.label')),
          h(
            'div',
            { className: 'rrcSelectRow' },
            h(
              'select',
              {
                id: `rrc-preset-${section}`,
                className: 'rrcSelect',
                value: view?.activeId ?? '',
                disabled: !ready || busy,
                onChange: (event) => selectPreset(event.target.value),
              },
              (view?.presets ?? []).length === 0
                // An empty list needs a placeholder, otherwise the control renders
                // as a blank box with no explanation.
                ? h('option', { value: '' }, t('preset.empty'))
                : (view?.presets ?? []).map((preset) =>
                    h('option', { key: preset.id, value: preset.id }, `${preset.name}  —  ${preset.host}:${preset.port}`),
                  ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'rrcIconBtn',
                title: t('preset.delete'),
                'aria-label': t('preset.delete'),
                disabled: !canDelete || busy,
                onClick: deleteActive,
              },
              h(
                'svg',
                { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
                h('path', { d: 'M2.5 4.5h11' }),
                h('path', { d: 'M6 4.5V3h4v1.5' }),
                h('path', { d: 'M4 4.5l.7 8.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4.5' }),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'rrcField', 'data-invalid': invalid.target === undefined ? undefined : 'true' },
          h('label', { className: 'rrcLabel', htmlFor: `rrc-target-${section}` }, copy.addressLabel),
          h(
            'div',
            { className: 'rrcTargetRow' },
            h('input', {
              id: `rrc-target-${section}`,
              className: 'rrcInput',
              type: 'text',
              autoComplete: 'off',
              autoCorrect: 'off',
              spellCheck: false,
              inputMode: 'url',
              placeholder: copy.targetPlaceholder,
              value: target,
              'data-invalid': invalid.target === undefined ? undefined : 'true',
              disabled: !ready || busy,
              onChange: (event) => {
                const value = event.target.value
                setTarget(value)
                // Show the red frame while typing once a full host:port is
                // present; incomplete values wait for blur/switch.
                const problems = validateTarget(value, true)
                setInvalid((current) => ({ ...current, target: problems.target }))
              },
              onBlur: blurTarget,
            }),
          ),
          h('span', { className: 'rrcDesc', 'data-invalid': invalid.target === undefined ? undefined : 'true' }, targetMessage),
        ),
        h(
          'div',
          { className: 'rrcField' },
          h('label', { className: 'rrcLabel' }, copy.tokenLabel),
          h(
            'div',
            { className: 'rrcInputRow' },
            // The local token is generated here and must not be hand-edited: the
            // remote page's token is pasted from the other machine. Revealing only
            // changes what is shown, never whether the field accepts typing.
            tokenEditable && reveal
              ? h('input', {
                  className: 'rrcInput',
                  type: 'text',
                  autoComplete: 'off',
                  spellCheck: false,
                  value: token,
                  'data-invalid': invalid.token === undefined ? undefined : 'true',
                  disabled: !ready || busy,
                  onChange: (event) => {
                    setToken(event.target.value)
                    setInvalid((current) => ({ ...current, token: undefined }))
                  },
                })
              : tokenEditable
                ? h('input', {
                    className: 'rrcInput',
                    type: 'password',
                    autoComplete: 'off',
                    spellCheck: false,
                    value: token,
                    'data-invalid': invalid.token === undefined ? undefined : 'true',
                    disabled: !ready || busy,
                    onChange: (event) => {
                      setToken(event.target.value)
                      setInvalid((current) => ({ ...current, token: undefined }))
                    },
                  })
                // Local, read-only: plain text when revealed, a fixed run of dots
                // otherwise. Never a truncated token — a partial secret leaks length
                // and the ends while reading as noise.
                : h(
                    'code',
                    { className: reveal ? 'rrcCode' : 'rrcCode rrcCodeMasked', 'aria-label': reveal ? undefined : t('token.hidden') },
                    token === '' ? '—' : reveal ? token : '•'.repeat(24),
                  ),
            h(
              'button',
              { type: 'button', className: 'rrcIconBtn', title: reveal ? t('token.hide') : t('token.show'), 'aria-label': reveal ? t('token.hide') : t('token.show'), 'aria-pressed': reveal ? 'true' : 'false', onClick: () => setReveal(!reveal) },
              reveal ? iconEyeOff() : iconEye(),
            ),
            h(
              'button',
              { type: 'button', className: 'rrcIconBtn', title: t('token.copy'), 'aria-label': t('token.copy'), disabled: token === '', onClick: copyToken },
              copied ? iconCheck() : iconCopy(),
            ),
            copy.onRotate === undefined
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'rrcIconBtn',
                    title: t('token.rotate'),
                    'aria-label': t('token.rotate'),
                    disabled: !ready || busy,
                    onClick: async () => {
                      if (typeof globalThis.confirm === 'function' && globalThis.confirm(`${t('token.rotate')}?`) !== true) return
                      await runAction({ section, action: 'rotate' })
                    },
                  },
                  iconRefresh(),
                ),
          ),
          invalid.token === undefined ? null : h('span', { className: 'rrcHint' }, invalid.token),
          h('span', { className: 'rrcDesc' }, copy.tokenDesc),
        ),
        section !== 'local'
          ? null
          : h(
              'div',
              { className: 'rrcField' },
              h('label', { className: 'rrcLabel', htmlFor: 'rrc-file-read-mode' }, t('fileRead.label')),
              h(
                'div',
                { className: 'rrcSelectRow' },
                h(
                  'select',
                  {
                    id: 'rrc-file-read-mode',
                    className: 'rrcSelect',
                    style: { border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.24))' },
                    value: fileMode,
                    disabled: !ready || busy,
                    onChange: (event) => setFileRead(event.target.value),
                  },
                  h('option', { value: 'off' }, t('fileRead.off')),
                  h('option', { value: 'shared' }, t('fileRead.shared')),
                  h('option', { value: 'home' }, t('fileRead.home')),
                ),
              ),
              h('span', { className: 'rrcDesc' }, t('fileRead.modeDesc')),
              fileMode !== 'shared'
                ? null
                : h(
                    'div',
                    { className: 'rrcField', style: { marginTop: '6px' } },
                    h('label', { className: 'rrcLabel', htmlFor: 'rrc-file-root' }, t('fileRead.rootLabel')),
                    h('input', {
                      id: 'rrc-file-root',
                      className: 'rrcInput',
                      type: 'text',
                      autoComplete: 'off',
                      spellCheck: false,
                      placeholder: t('fileRead.rootPlaceholder'),
                      value: fileRoot,
                      disabled: !ready || busy,
                      onChange: (event) => setFileRoot(event.target.value),
                      onBlur: commitFileRoot,
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                      },
                    }),
                    h('span', { className: 'rrcDesc' }, t('fileRead.rootDesc')),
                  ),
            ),
        h(
          'div',
          { className: 'rrcActions' },
          h('button', { type: 'button', className: 'rrcPrimary', disabled: !ready || busy, onClick: requestSave }, t('actions.save')),
        ),
        naming === undefined
          ? null
          : h(SavePresetModal, {
              t,
              initialName: naming.name,

              busy,
              onCancel: () => setNaming(undefined),
              onConfirm: confirmSave,
            }),
      )
    }

    /**
     * Name prompt shown before a preset is written.
     *
     * The name doubles as the key: reusing an existing name overwrites that preset,
     * a fresh name creates another one, so no separate overwrite choice is asked.
     */
    function SavePresetModal({ t, initialName, busy, onCancel, onConfirm }) {
      const [name, setName] = React.useState(initialName)
      return h(
        'div',
        { className: 'rrcModalOverlay', role: 'presentation', onClick: onCancel },
        h(
          'div',
          { className: 'rrcModal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('save.title'), onClick: (event) => event.stopPropagation() },
          h('h3', { className: 'rrcModalHeading' }, t('save.title')),
          h(
            'div',
            { className: 'rrcField' },
            h('label', { className: 'rrcLabel', htmlFor: 'rrc-save-name' }, t('save.nameLabel')),
            h('input', {
              id: 'rrc-save-name',
              className: 'rrcInput',
              type: 'text',
              autoFocus: true,
              value: name,
              maxLength: 80,
              disabled: busy,
              onChange: (event) => setName(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') onConfirm({ name: name.trim() === '' ? initialName : name.trim() })
              },
            }),
          ),

          h(
            'div',
            { className: 'rrcActions' },
            h('button', { type: 'button', className: 'rrcSecondary', disabled: busy, onClick: onCancel }, t('actions.cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'rrcPrimary',
                disabled: busy,
                onClick: () => onConfirm({ name: name.trim() === '' ? initialName : name.trim() }),
              },
              t('save.confirm'),
            ),
          ),
        ),
      )
    }

    /**
     * The help view inside the card.
     *
     * Kept in the same dialog so the operator never loses the open card while
     * reading the security notes. The repository link is deliberately blank
     * until the public release; the pending line keeps the row from looking
     * broken.
     * @param {{ t: Function }} props - locale translator.
     * @returns the help body.
     */
    function HelpPage({ t }) {
      const section = (title, items) => h(
        'section',
        { className: 'rrcHelpSection' },
        h('h3', { className: 'rrcHelpTitle' }, title),
        h('ul', { className: 'rrcHelpList' }, items.map((item, index) => h('li', { key: String(index) }, item))),
      )
      return h(
        'div',
        { className: 'rrcHelp rrcTabBody' },
        h('p', { className: 'rrcHelpIntro' }, t('help.intro')),
        h(
          'div',
          { className: 'rrcHelpGithub' },
          h('span', { className: 'rrcLabel' }, t('help.github.label')),
          h('a', { href: GITHUB_URL, target: '_blank', rel: 'noreferrer noopener' }, GITHUB_URL),
        ),
        section(t('help.security.title'), [
          t('help.security.token'),
          t('help.security.network'),
          t('help.security.permanent'),
          t('help.security.file'),
          t('help.security.root'),
          t('help.security.disclaimer'),
        ]),
        section(t('help.usage.title'), [
          t('help.usage.local'),
          t('help.usage.remote'),
          t('help.usage.save'),
          t('help.usage.preset'),
          t('help.usage.duration'),
          t('help.usage.download'),
        ]),
      )
    }

    /**
     * The card: two tabs over one record, with a footer that stays put.
     *
     * Both tabs are the same `PresetTab` over a different section, so the outer
     * box never changes size when the tab changes — only the scrolling body does.
     * @param {object} props - `{ open, onClose, t, ctx }`.
     * @returns the overlay element or null.
     */
    function RemoteControlDialog({ open, onClose, t, ctx }) {
      const [tab, setTab] = React.useState('local')
      const [footer, setFooter] = React.useState({ tone: 'plain', text: '' })
      const [view, setView] = React.useState('controls')

      // A closed card reopens on the controls, not on whichever help page was
      // last open in a previous visit.
      React.useEffect(() => {
        if (open === true) setView('controls')
      }, [open])

      const copyOf = (section) => ({
        toggle: t(section === 'local' ? 'local.toggle' : 'remote.toggle'),
        ready: t(section === 'local' ? 'local.ready' : 'remote.ready'),
        idle: t(section === 'local' ? 'local.idle' : 'remote.idle'),
        on: t(section === 'local' ? 'local.on' : 'remote.on'),
        off: t(section === 'local' ? 'local.off' : 'remote.off'),
        addressLabel: t(section === 'local' ? 'local.addressLabel' : 'remote.addressLabel'),
        targetPlaceholder: t('address.placeholder'),
        addressDesc: t(section === 'local' ? 'local.addressDesc' : 'remote.addressDesc'),
        portLabel: t('port.label'),
        tokenLabel: t('token.label'),
        tokenDesc: t(section === 'local' ? 'local.tokenDesc' : 'remote.tokenDesc'),
        onRotate: section === 'local' ? () => {} : undefined,
      })

      // PresetTab's status effect depends on `copy`. Rebuilding this object on
      // every parent render made that effect run again and call setFooter, which
      // re-rendered the parent: an update loop. The object only changes with the
      // tab, so keep its identity stable.
      const copy = React.useMemo(() => copyOf(tab), [tab, t])
      const showingHelp = view === 'help'

      if (open !== true) return null

      const body = h(
        'div',
        {
          className: 'rrcDialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': showingHelp ? t('help.title') : t('panel.title'),
          onClick: (event) => event.stopPropagation(),
        },
        h(
          'div',
          { className: 'rrcHeader' },
          h('h2', { className: 'rrcHeading' }, showingHelp ? t('help.title') : t('panel.title')),
          h(
            'div',
            { className: 'rrcHeaderActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'rrcClose',
                title: showingHelp ? t('help.back') : t('help.open'),
                'aria-label': showingHelp ? t('help.back') : t('help.open'),
                onClick: () => setView(showingHelp ? 'controls' : 'help'),
              },
              showingHelp ? '←' : '?',
            ),
            h('button', { type: 'button', className: 'rrcClose', title: t('actions.close'), 'aria-label': t('actions.close'), onClick: onClose }, '×'),
          ),
        ),
        showingHelp
          ? h(HelpPage, { t })
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'rrcTabs', role: 'tablist', 'aria-label': t('panel.title') },
                h(
                  'button',
                  { type: 'button', role: 'tab', className: 'rrcTab', 'aria-selected': tab === 'local' ? 'true' : 'false', onClick: () => setTab('local') },
                  t('tabs.local'),
                ),
                h(
                  'button',
                  { type: 'button', role: 'tab', className: 'rrcTab', 'aria-selected': tab === 'remote' ? 'true' : 'false', onClick: () => setTab('remote') },
                  t('tabs.remote'),
                ),
              ),
              h(PresetTab, {
                key: tab,
                section: tab,
                copy,
                t,
                onStatusChange: setFooter,
              }),
              h(
                'p',
                { className: 'rrcStatus', 'data-tone': footer.tone, role: 'status' },
                footer.text === '' ? null : h('span', { className: 'rrcDot' }),
                footer.text,
              ),
            ),
      )
      const overlay = h('div', { className: 'rrcOverlay', role: 'presentation', onClick: onClose }, body)
      if (typeof document === 'undefined' || document.body === undefined) return overlay
      const { createPortal } = require('react-dom')
      return createPortal(overlay, document.body)
    }

    // ── Icons ────────────────────────────────────────────────────────────────
    // Every token-row action renders through `icon()` so the three buttons share
    // one stroke weight, one box and one optical size. Emoji were neither.

    /**
     * One stroked glyph in the card's icon style.
     * @param {Array} children - SVG child elements.
     * @param {number} size - outer square edge in pixels.
     * @returns the svg element.
     */
    function icon(children, size = 14) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        children,
      )
    }

    /** Open eye: the token is visible. */
    function iconEye() {
      return icon([
        h('path', { key: 'a', d: 'M1.4 8s2.4-4.1 6.6-4.1S14.6 8 14.6 8s-2.4 4.1-6.6 4.1S1.4 8 1.4 8Z' }),
        h('circle', { key: 'b', cx: 8, cy: 8, r: 1.9 }),
      ])
    }

    /** Crossed eye: the token is masked. */
    function iconEyeOff() {
      return icon([
        h('path', { key: 'a', d: 'M6.2 4.1A6.9 6.9 0 0 1 8 3.9c4.2 0 6.6 4.1 6.6 4.1a12.7 12.7 0 0 1-2 2.4' }),
        h('path', { key: 'b', d: 'M9.9 12a6.9 6.9 0 0 1-1.9.1C3.8 12.1 1.4 8 1.4 8a12.7 12.7 0 0 1 2.6-2.9' }),
        h('path', { key: 'c', d: 'M2.2 2.2l11.6 11.6' }),
      ])
    }

    /** Two offset sheets: copy. */
    function iconCopy() {
      return icon([
        h('rect', { key: 'a', x: 5.4, y: 5.4, width: 8.2, height: 8.2, rx: 1.4 }),
        h('path', { key: 'b', d: 'M10.6 5.4V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4v5.3a1.4 1.4 0 0 0 1.4 1.4h1.5' }),
      ])
    }

    /** Check mark: copy succeeded. */
    function iconCheck() {
      return icon([h('path', { key: 'a', d: 'M3 8.4l3.1 3.1L13 4.6' })])
    }

    /** Circular arrow: rotate. */
    function iconRefresh() {
      return icon([
        h('path', { key: 'a', d: 'M13.2 8a5.2 5.2 0 1 1-1.5-3.7' }),
        h('path', { key: 'b', d: 'M13.4 2.6v3.2h-3.2' }),
      ])
    }

    function glyph(size = 16) {
      // The artwork stays inside 0.75..15.25 so the 1.4px stroke, which straddles
      // the path by 0.7px on each side, cannot touch the viewBox edge and be
      // clipped by the button's `overflow: hidden`.
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { key: 'screen', x: 1.3, y: 2.7, width: 7.4, height: 5.8, rx: 1.2 }),
        h('path', { key: 'stand', d: 'M3.6 12.1h3.2' }),
        h('path', { key: 'neck', d: 'M5.2 8.9v3.2' }),
        // Two arcs stacked above the stand, kept clear of the right edge and of the
        // spot where the status dot lands, so neither clips nor overlaps the other.
        // Concentric arcs opening right, like a broadcast signal: a shared centre
        // keeps them visually parallel instead of reading as a lightning bolt.
        h('path', { key: 'wave-1', d: 'M10.2 4.6a4.4 4.4 0 0 1 0 6.2' }),
        h('path', { key: 'wave-2', d: 'M12.4 2.9a7.4 7.4 0 0 1 0 9.6' }),
      )
    }

    /**
     * Status ring drawn on the footer glyph when either direction is on.
     *
     * A dot rather than a colour change: the glyph keeps the sidebar's inherited
     * colour, so one indicator works in both themes without a second palette.
     * @param {object} props - `{ size, on }`.
     * @returns the absolutely-positioned dot, or null when nothing is on.
     */
    function glyphBadge({ size, on }) {
      if (on !== true) return null
      const d = Math.max(6, Math.round(size * 0.42))
      return h('span', {
        'aria-hidden': 'true',
        style: {
          position: 'absolute',
          right: -1.5,
          bottom: -1.5,
          width: d,
          height: d,
          borderRadius: '50%',
          background: 'var(--dsw-alias-state-success-primary,#2fb171)',
          boxShadow: '0 0 0 1.5px var(--dsw-alias-bg-layer-2,Canvas)',
          pointerEvents: 'none',
        },
      })
    }

    /**
     * Footer row: opens the dialog and shows the live transport state.
     * `wide` is the sidebar's own prop (the foot hands it to every action); the
     * collapsed rail shows the glyph alone.
     * @param props - locale seat, the sidebar's wide flag, and unused caller props.
     */
    function RemoteControlButton({ t, wide, ctx }) {
      const [open, setOpen] = React.useState(false)
      // The badge lights for either direction, so it reads both sections of the
      // shared record. Re-read on every open/close: the card is the only writer and
      // closing it is the moment the answer can have changed.
      const [active, setActive] = React.useState(false)
      React.useEffect(() => {
        let live = true
        let timer
        const refresh = () => {
          readState().then(
            (value) => {
              if (!live) return
              setActive(value?.local?.enabled === true || value?.remote?.enabled === true)
              if (timer !== undefined) clearTimeout(timer)
              timer = undefined
              const expiresAt = value?.local?.status?.expiresAt
              if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
                // Refresh just after the local service should have closed. The
                // card normally does the actual close through the switch route;
                // this is the footer-only fallback when the card is closed.
                timer = setTimeout(refresh, Math.max(1000, expiresAt - Date.now() + 500))
              }
            },
            () => {},
          )
        }
        const onStateChanged = () => {
          if (live) refresh()
        }
        refresh()
        window.addEventListener('remote-control/state-changed', onStateChanged)
        return () => {
          live = false
          if (timer !== undefined) clearTimeout(timer)
          window.removeEventListener('remote-control/state-changed', onStateChanged)
        }
      }, [open])
      // Match `dsh-plugin-mobile-gateway`'s footer button exactly — the shipped
      // socket sizes the row from the button's own box, so a CSS-classed chip with
      // its own height/padding lands at a different vertical offset than the other
      // footer actions. Inline geometry in the same shape keeps the two entries on
      // one baseline: 42px full-width with negative side margins when wide, a
      // 36px square when the sidebar is collapsed to its rail.
      const iconSize = wide ? 16 : 18
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            title: t('panel.title'),
            'aria-label': t('panel.button'),
            'aria-pressed': open ? 'true' : 'false',
            onClick: () => setOpen((value) => !value),
            style: {
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              font: 'inherit',
              display: 'flex',
              alignItems: 'center',
              justifyContent: wide ? 'flex-start' : 'center',
              gap: wide ? 8 : 0,
              boxSizing: 'border-box',
              width: wide ? 'calc(100% + 4px)' : 36,
              height: wide ? 42 : 36,
              margin: wide ? '4px -2px' : '3px 0',
              padding: wide ? '0 10px 0 8px' : 0,
              lineHeight: wide ? '22px' : 'normal',
              overflow: 'hidden',
            },
          },
          // The glyph sits in a zero-margin flex box the same size as the svg, so
          // the badge can be positioned against it without changing the row height
          // that mirrors the mobile-gateway footer button.
          h(
            'span',
            {
              'aria-hidden': 'true',
              style: { position: 'relative', display: 'flex', flex: 'none', width: iconSize, height: iconSize },
            },
            glyph(iconSize),
            glyphBadge({ size: iconSize, on: active }),
          ),
          wide
            ? h(
                'span',
                {
                  'aria-hidden': 'true',
                  // One line, clipped with an ellipsis: the sidebar label is a fixed
                  // 42px row and a longer translation (English is wider than the
                  // Chinese) must not wrap onto a second line.
                  // One line that shrinks to fit instead of wrapping: `cqi` is the
                  // button's own inline size, so the label stays at 100% while it
                  // fits and scales down only when the column narrows. `nowrap`
                  // guarantees no second line even if the font can't shrink further.
                  style: {
                    flex: '1 1 auto',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    // A flex item stretches to its row; without this the label sits
                    // centred in that box instead of starting beside the glyph, which
                    // reads as a different alignment from "移动设备" above it.
                    textAlign: 'left',
                    // No `font-size`: the neighbouring footer actions inherit the
                    // sidebar's size, and any scaling here made this label visibly
                    // larger/smaller than "移动设备" beside it. Overflow is handled by
                    // the ellipsis instead of shrinking type.
                  },
                },
                t('panel.button'),
              )
            : null,
        ),
        h(RemoteControlDialog, { open, onClose: () => setOpen(false), t, ctx }),
      )
    }

    return {
      name: 'remote-control-client',
      // Declared services are readable as `ctx.<key>`; naming `locale` here is
      // what makes `ctx.locale` available at all, and `slots` keeps the button
      // seat animated in only after the sidebar can accept registrations.
      inject: ['locale', 'slots'],
      apply(ctx) {
        // The page script is the only place a dead link is visible; this is how it
        // asks the card's own switch to turn off, so state, dot and credentials end
        // up exactly as if the operator had clicked it.
        globalThis.__remoteControlFailBack = failBackToLocal
        // Reconcile this tab's decision with the Host before anything reads it.
        try {
          syncDecision(hostTransport(ctx))
        } catch {
          // The Host state route is unavailable; the card still works from its own reads.
        }
        try {
          injectStyle()
          const t = ctx.locale.bind(NS)
          ctx.effect(() => ctx.locale.register(NS, 'en', {"meta.title": "Remote Control", "meta.description": "Two-way remote control: open this machine to other computers, or point this window at another machine's DSH.", "panel.title": "Remote Control", "panel.intro": "Both directions in one card: the Local tab opens this computer to other devices, the Remote tab makes this window use another computer's DSH.", "panel.sectionDefault": "Remote control", "panel.button": "Remote control", "switch.label": "Use the remote Harness", "switch.description": "Off: this window talks to the Harness on this computer. On: every Remote call and live stream is relayed to the bridge below immediately.", "switch.enabled": "On", "switch.disabled": "Off", "switch.transport": "Use a remote DSH", "switch.transportDesc": "Takes effect on click: this window's Remote calls and live streams switch to the bridge below, and back to the local DSH when turned off.", "address.label": "Bridge address", "address.placeholder": "ip:port", "address.description": "The host:port shown on the other machine's Local tab. The port is optional and defaults to 7400.", "token.label": "Access token", "token.placeholder": "Paste the bridge access credential", "token.description": "The credential shown on the other machine's Local tab. It is stored only in this Harness profile.", "token.show": "Show token", "token.hide": "Hide token", "actions.test": "Test connection", "actions.testing": "Testing…", "actions.save": "Save", "actions.reset": "Reset", "actions.reload": "Reload page", "actions.retry": "Retry", "actions.close": "Close", "actions.saving": "Applying…", "status.loading": "Reading…", "status.off": "Off — this window uses the local Harness.", "status.incomplete": "On, but the address or token is missing, so the local Harness is used.", "status.ready": "On — Remote calls are relayed to {address}.", "status.unsaved": "Address or token changed — press Apply to use them.", "status.saved": "Saved.", "status.savedOff": "Saved: the transport is local again. Reload the page to apply it.", "status.reloading": "Reloading the page…", "status.readFailed": "Could not read the remote-control setting: {error}", "status.proxy": "On — this Harness serves a remote page at http://127.0.0.1:{port} (bridge {address}).", "status.transport": "The switch affects this tab only; the remote page is a separate access path.", "check.ok": "Bridge answered. Protocol {protocol}, principal {principal}, streaming {streams}.", "check.failed": "Test failed: {error}", "check.pending": "Checking the bridge…", "error.empty": "Enter the bridge address and token.", "error.badAddress": "The address is not valid: {error}", "warn.token": "Anyone holding this token can control the other machine's Harness.", "tabs.controlled": "Local", "tabs.control": "Remote", "being.toggle": "Allow remote control", "being.ready": "Bridge port is ready; remote clients can connect", "being.notListening": "Enabled, but the port is not listening", "being.off": "Off; this machine only", "being.loading": "Reading status…", "being.hostLabel": "Bind address", "being.hostDesc": "An IP literal of one of this machine's interfaces. Wildcards and hostnames are refused.", "being.portLabel": "Port", "being.portDesc": "Port 1024 or higher. An occupied port is reported as an error and is not shifted.", "being.apply": "Apply", "being.tokenLabel": "Access token", "being.tokenDesc": "A controller presents this when connecting. Rotating it invalidates the old token immediately and drops connected clients.", "being.copy": "Copy", "being.copied": "Copied", "being.rotate": "Rotate", "being.rotating": "Rotating…", "tabs.local": "Local", "tabs.remote": "Remote", "local.toggle": "Let other devices control this machine", "local.ready": "Other devices can connect to this machine", "local.idle": "Off — only this machine", "local.on": "On — accepting connections", "local.off": "Off — only this machine", "local.addressLabel": "Listen address and port", "local.addressDesc": "The IP and port this machine accepts connections on, e.g. 192.168.1.10:7400. Use an IP this machine already has.", "local.tokenDesc": "A controller presents this when connecting to this machine. Rotate it to revoke the previous token immediately.", "remote.toggle": "Control another machine from this window", "remote.ready": "This window is showing the other machine's DSH", "remote.idle": "Off — this window shows this machine's DSH", "remote.on": "On — using the other machine", "remote.off": "Off — using this machine", "remote.addressLabel": "Target address and port", "remote.addressDesc": "The IP and port shown on the other machine's Local tab.", "remote.tokenDesc": "The token shown on the other machine's Local tab.", "port.label": "Port", "preset.label": "Preset", "preset.delete": "Delete this preset", "preset.deleteBlocked": "At least one preset must remain", "token.copy": "Copy token", "token.rotate": "Rotate token", "actions.cancel": "Cancel", "error.ipInvalid": "Enter a concrete IPv4/IPv6 address of this machine, not a hostname", "error.ipWildcard": "Do not use 0.0.0.0 or ::; enter a concrete IP address", "error.ipNotLocal": "That IP is not on this machine. Enter one of this machine's interface addresses", "error.portInUse": "That port is already in use. Choose another one", "error.hostRequired": "Enter an address and port", "error.portRequired": "Append a port, e.g. 192.168.1.10:7400", "error.portRange": "Port must be between 1 and 65535", "error.portPrivileged": "Ports below 1024 are privileged", "error.tokenRequired": "Enter a token", "save.title": "Save preset", "save.nameLabel": "Name", "save.confirm": "Confirm", "preset.empty": "No presets", "fileRead.label": "Remote file download", "fileRead.off": "Off", "fileRead.shared": "Workspace and specified directory", "fileRead.home": "Home directory (protected paths excluded)", "fileRead.rootLabel": "Specified directory", "fileRead.rootPlaceholder": "/Users/me/Desktop", "fileRead.rootDesc": "One absolute path. Empty allows the workspace only.", "fileRead.modeDesc": "Controls the file range available to remote downloads.", "duration.label": "Service lifetime", "duration.5m": "5 minutes", "duration.30m": "30 minutes", "duration.1h": "1 hour", "duration.3h": "3 hours", "duration.12h": "12 hours", "duration.24h": "24 hours", "duration.permanent": "Permanent", "download.denied": "No permission to download this file under the current settings", "token.hidden": "Token hidden", "help.open": "Help and safety", "help.title": "Help and safety", "help.back": "Back to controls", "help.intro": "A DeepSeek Harness plugin that establishes remote control between two computers, letting one computer operate a DeepSeek Harness instance running on another computer.", "help.usage.title": "Using the two tabs", "help.usage.local": "Local: choose one concrete IP address of this machine and a port at 1024 or higher, open the switch, then copy the access token to the other machine. The bridge listens only on that address.", "help.usage.remote": "Remote: enter the address and token shown on the other machine's Local tab, then open the switch. The page reloads once and starts using the remote DSH.", "help.usage.save": "Save only stores the address, port, token and name. It does not bind a port or move the live connection; the switch applies the saved target.", "help.usage.preset": "Presets: selecting one fills the form, saving adds or updates it, and deleting removes it. A selection is not applied until the switch is turned on.", "help.usage.duration": "Service lifetime: choose 5 minutes to 24 hours, or Permanent. The listener closes automatically at expiry. Permanent still ends when DSH exits; it is not a reboot-persistent service.", "help.usage.download": "Remote downloads follow the Local tab's file policy. Off disables the download button; shared allows the workspace plus one root; home allows the home directory minus protected paths. Narrow roots are safer.", "help.security.title": "Security and disclaimer", "help.security.token": "The bridge uses plaintext ws:// and a bearer token. Anyone who obtains the token can exercise full control over the controlled Harness, including high-risk operations. Use a strong token and rotate it immediately if exposed.", "help.security.network": "Use Remote Control only over Tailscale, SSH, WireGuard or another encrypted tunnel. Do not expose port 7400 (or your chosen port) to an untrusted LAN or the public internet.", "help.security.permanent": "Do not leave permanent service enabled. Prefer a bounded lifetime and turn the switch off when finished, especially on laptops and shared machines.", "help.security.file": "The file setting controls downloads, not all remote file access: DSH preview can still read files through RPC. Do not grant a broad directory, your whole home directory or permanent access unless every controller is fully trusted.", "help.security.root": "A wide download root (for example /, a whole home directory, or a shared team folder) exposes far more than expected. Grant the narrowest directory that contains the files you need.", "help.security.disclaimer": "This plugin is provided as-is, without warranty. You are responsible for network exposure, tokens, file permissions and any operation performed by a remote controller. Test in a controlled environment first.", "help.github.label": "GitHub", "notice.local": "Switched back to this machine", "download.title": "Download to this computer", "download.label": "Download"}), 'remote-control: English copy')
          ctx.effect(() => ctx.locale.register(NS, 'zh', {"meta.title": "远程控制", "meta.description": "双向远程控制：把本机开放给其他电脑，或把本窗口指向另一台电脑的 DSH。", "panel.title": "远程控制", "panel.intro": "两个方向合在一个卡片里：本机页把当前电脑开放给其他设备，远程页让本窗口使用另一台电脑的 DSH。", "panel.sectionDefault": "远程控制", "panel.button": "远程控制", "switch.label": "使用远程 Harness", "switch.description": "关闭：本窗口使用本机的 Harness。开启：所有 Remote 调用与实时流立即转发到下面的桥接地址，无需再次确认。", "switch.enabled": "开启", "switch.disabled": "关闭", "switch.transport": "使用远程 DSH", "switch.transportDesc": "开启即生效：本窗口所有 Remote 调用与实时流立即转发到下面的桥接地址。关闭后立即回到本机 DSH。", "address.label": "桥接地址", "address.placeholder": "IP:端口", "address.description": "对端「本机」页显示的监听地址 host:port，端口可省略，默认 7400。", "token.label": "访问令牌", "token.placeholder": "粘贴桥接的访问凭据", "token.description": "对端「本机」页显示的访问凭据。只保存在本 Harness 的配置目录中。", "token.show": "显示令牌", "token.hide": "隐藏令牌", "actions.test": "测试连接", "actions.testing": "正在测试…", "actions.save": "保存", "actions.reset": "还原", "actions.reload": "重新加载页面", "actions.retry": "重试", "actions.close": "关闭", "actions.saving": "正在应用…", "status.loading": "正在读取…", "status.off": "已关闭 —— 本窗口使用本机 Harness。", "status.incomplete": "已开启，但缺少地址或令牌，因此仍使用本机 Harness。", "status.ready": "已开启 —— Remote 调用转发到 {address}。", "status.unsaved": "地址或令牌有改动，点「应用」使其生效。", "status.saved": "已保存。", "status.savedOff": "已保存：传输已改回本机。请重新加载页面使其生效。", "status.reloading": "正在重新加载页面…", "status.readFailed": "读取远程控制设置失败：{error}", "status.proxy": "已开启 —— 远程页面在 http://127.0.0.1:{port}（桥接 {address}）。", "status.transport": "开关只影响本标签页；远程页面是另一种独立的访问方式。", "check.ok": "桥接有响应。协议 {protocol}，身份 {principal}，流式 {streams}。", "check.failed": "测试失败：{error}", "check.pending": "正在检查桥接…", "error.empty": "请填写桥接地址和令牌。", "error.badAddress": "地址无效：{error}", "warn.token": "持有该令牌的人都能控制对端电脑的 Harness。", "tabs.controlled": "本机", "tabs.control": "远程", "being.toggle": "允许被远程控制", "being.ready": "桥接端口已就绪，远程客户端可以连接", "being.notListening": "已开启，但端口未监听", "being.off": "已关闭，仅本机可用", "being.loading": "正在读取状态…", "being.hostLabel": "监听地址", "being.hostDesc": "填本机某个网卡的 IP，例如局域网地址或 Tailscale 地址。不支持 0.0.0.0 和主机名。", "being.portLabel": "监听端口", "being.portDesc": "端口需为 1024 及以上；被占用会直接报错，不会自动顺延。", "being.apply": "应用", "being.tokenLabel": "访问凭据", "being.tokenDesc": "对端建立连接时需要这串凭据。刷新后旧凭据立即失效，已连接的客户端会被断开。", "being.copy": "复制", "being.copied": "已复制", "being.rotate": "刷新", "being.rotating": "刷新中…", "tabs.local": "本机", "tabs.remote": "远程", "local.toggle": "允许其他设备控制本机", "local.ready": "其他设备可以连接本机", "local.idle": "关闭；仅本机可用", "local.on": "已开启", "local.off": "已关闭；仅本机可用", "local.addressLabel": "监听地址和端口", "local.addressDesc": "本机接受连接的 IP 和端口，例如 192.168.1.10:7400。只填本机已有的 IP。", "local.tokenDesc": "其他设备连接本机时需要这串凭据。刷新后旧凭据立即失效。", "remote.toggle": "在本窗口控制另一台电脑", "remote.ready": "本窗口正在显示对端的 DSH", "remote.idle": "关闭；本窗口显示本机的 DSH", "remote.on": "已开启", "remote.off": "已关闭；使用本机", "remote.addressLabel": "目标地址和端口", "remote.addressDesc": "对端「本机」页显示的 IP 和端口。", "remote.tokenDesc": "对端「本机」页显示的凭据。", "port.label": "端口", "preset.label": "预设", "preset.delete": "删除当前预设", "preset.deleteBlocked": "至少保留一个预设", "token.copy": "复制凭据", "token.rotate": "刷新凭据", "actions.cancel": "取消", "error.ipInvalid": "请填写本机已有的具体 IPv4/IPv6 地址，不要填主机名", "error.ipWildcard": "不能使用 0.0.0.0 或 ::，请填写具体 IP", "error.ipNotLocal": "这个 IP 不在本机网卡上，请填写本机已有的地址", "error.portInUse": "该端口已被占用，请换一个端口", "error.hostRequired": "请填写地址和端口", "error.portRequired": "地址后需要附带端口，例如 192.168.1.10:7400", "error.portRange": "端口需在 1–65535 之间", "error.portPrivileged": "1024 以下为特权端口", "error.tokenRequired": "请填写凭据", "save.title": "保存预设", "save.nameLabel": "名称", "save.confirm": "确认", "preset.empty": "（无预设）", "fileRead.label": "远程文件下载", "fileRead.off": "关闭", "fileRead.shared": "工作区与指定目录", "fileRead.home": "用户主目录（排除受保护路径）", "fileRead.rootLabel": "指定目录", "fileRead.rootPlaceholder": "/Users/me/Desktop", "fileRead.rootDesc": "一个绝对路径；留空时仅允许工作区。", "fileRead.modeDesc": "控制在远程端可下载的文件范围。", "duration.label": "服务时长", "duration.5m": "5 分钟", "duration.30m": "30 分钟", "duration.1h": "1 小时", "duration.3h": "3 小时", "duration.12h": "12 小时", "duration.24h": "24 小时", "duration.permanent": "永久", "download.denied": "当前设置无权限下载该文件", "token.hidden": "凭据已隐藏", "help.open": "帮助与安全", "help.title": "帮助与安全", "help.back": "返回操作界面", "help.intro": "一个 DeepSeek Harness 插件，用于在两台电脑之间建立远程控制，让一台电脑操作另一台电脑上运行的 DeepSeek Harness 实例。", "help.usage.title": "两个页签怎么配合", "help.usage.local": "本机：选择一个本机已有的具体 IP 和 1024 以上端口，打开开关，再把访问凭据复制到另一端。桥接只监听这个地址。", "help.usage.remote": "远程：填写对端「本机」页显示的地址和凭据，打开开关。页面会刷新一次，之后使用对端的 DSH。", "help.usage.save": "保存只记录地址、端口、凭据和名称，不会绑定端口，也不会改变当前连接；真正生效发生在打开开关时。", "help.usage.preset": "预设：选择预设会把地址和凭据填回表单；保存新增或更新预设；删除移除预设。选中预设不会自动应用，打开开关才应用。", "help.usage.duration": "服务时长：可选 5 分钟到 24 小时，或永久。到期会自动关闭监听。永久也会在 DSH 退出时结束，不是重启后继续运行的服务。", "help.usage.download": "远程下载受「本机」页的文件策略控制：关闭时下载键不可用；共享允许工作区加一个指定目录；主目录允许 home 内排除受保护路径后的文件。目录越窄越安全。", "help.security.title": "安全说明与免责声明", "help.security.token": "桥接使用明文 ws:// 和 bearer token。拿到凭据的人可以获得被控端 Harness 的完整控制权限，包括高风险操作。请使用强凭据，泄露后立即轮换。", "help.security.network": "只通过 Tailscale、SSH、WireGuard 等加密隧道使用远程控制。不要把 7400（或你选择的端口）暴露到不可信局域网或公网。", "help.security.permanent": "不建议开启永久服务。优先选择有限时长，用完关闭开关，尤其是在笔记本和共用电脑上。", "help.security.file": "文件设置只控制下载，不控制全部远程文件访问：DSH 预览仍可能通过 RPC 读取文件。除非完全信任所有控制端，不要授权过宽目录、整个主目录或永久访问。", "help.security.root": "过宽的下载根目录（例如 /、整个 home、团队共享目录）会暴露远超预期的文件。只授权包含所需文件的最窄目录。", "help.security.disclaimer": "本插件按现状提供，不附带任何担保。网络暴露、凭据、文件权限以及远程控制端执行的操作由使用者负责。请先在受控环境测试。", "help.github.label": "GitHub", "notice.local": "已切回本机", "download.title": "下载到此电脑", "download.label": "下载"}), 'remote-control: Chinese copy')
          const slots = ctx.get('slots')
          if (slots === undefined || typeof slots.inject !== 'function') return
          /**
           * Say what happened, after the window has already come back.
           *
           * The notice is raised on the load that follows the switch-off, not on the
           * one that performs it: this window is rebuilt anyway, so a message drawn
           * now would be thrown away with the page, and a desktop shell can drop the
           * timer that would have delayed the reload. The page script leaves the
           * sentence in session storage; this reads it once, then forgets it.
           */
          function RemoteFallbackNotice() {
            const [notice, setNotice] = React.useState(undefined)
            React.useEffect(() => {
              let raw
              try { raw = globalThis.sessionStorage?.getItem(NOTICE_KEY) } catch (error) { return undefined }
              if (raw === null || raw === undefined) return undefined
              // One shot: a notice must never survive into a later load.
              try { globalThis.sessionStorage?.removeItem(NOTICE_KEY) } catch (error) {}
              let parsed
              try { parsed = JSON.parse(raw) } catch (error) { return undefined }
              // A marker left behind by a crash long ago is not news.
              if (!Number.isFinite(parsed?.at) || Date.now() - parsed.at > 120_000) return undefined
              setNotice(parsed)
              return undefined
            }, [])
            if (notice === undefined) return null
            const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
            // A switch the operator threw themselves is not a warning: no glyph, and
            // the quiet tone. Only an unexpected drop earns the attention mark.
            const urgent = notice.kind === 'error'
            const Warning = primitives.IconWarningOutlineRegular
            return h(primitives.Toast, {
              text: String(notice.message ?? ''),
              ...(urgent && Warning !== undefined ? { icon: h(Warning, null) } : {}),
              ...(urgent ? {} : { tone: 'neutral' }),
              // Long enough to be read without hurrying: this window just changed
              // transports under the operator, so the sentence carries real news.
              holdMs: urgent ? 8000 : 5000,
              onDone: () => setNotice(undefined),
            })
          }
          slots.inject('shell.overlay', () => slots.register({
            name: 'shell.overlay',
            id: 'remote-control-fallback-notice',
            locale: NS,
          }, () => RemoteFallbackNotice()))
          slots.inject('sidebar.footer.action', () => slots.register({
            name: 'sidebar.footer.action',
            id: 'remote-control',
            // Rows in the footer stack top-down by ascending `order`. 81 is where
            // the standalone bridge sat, so the merged entry keeps that position
            // instead of jumping above the other footer actions.
            order: 81,
            locale: NS,
          }, (props) => RemoteControlButton({ ...props, ctx })))
          /**
           * The download glyph DSH ships, with an inline fallback so the control
           * still renders if the module is renamed by a build.
           * @returns {Function} a component rendering the icon.
           */
          const DownloadIcon = () => {
            try {
              const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
              if (primitives?.IconDownloadOutlineRegular !== undefined) return primitives.IconDownloadOutlineRegular
            } catch (error) { /* falls through to the inline glyph */ }
            return () => h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', 'stroke-width': 1 },
              h('path', { d: 'M8 1.95317V10.0469', stroke: 'currentColor' }),
              h('path', { d: 'M4.25 6.29688L8 10.0469L11.75 6.29688', stroke: 'currentColor' }),
              h('path', {
                d: 'M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469',
                stroke: 'currentColor',
              }))
          }
          /**
           * One right-sidebar download control. It waits for the controlled
           * Host's per-path decision: no value means no button, `false` means a
           * disabled button with the generic "no permission" tooltip, and `true`
           * means the normal download action. The Host remains authoritative at
           * download time.
           */
          const RemoteDownloadButton = ({ absolutePath, variant }) => {
            const [allowed, setAllowed] = React.useState(undefined)
            React.useEffect(() => {
              if (!remoteWindow() || typeof absolutePath !== 'string' || absolutePath === '') {
                setAllowed(undefined)
                return undefined
              }
              const controller = new AbortController()
              setAllowed(undefined)
              fetch(`${BASE}/can-read?path=${encodeURIComponent(absolutePath)}`, {
                credentials: 'same-origin',
                cache: 'no-store',
                headers: MARKER,
                signal: controller.signal,
              }).then(
                (response) => (response.ok ? response.json() : undefined),
                () => undefined,
              ).then((data) => {
                if (controller.signal.aborted) return
                setAllowed(data?.ok === true ? data.allowed === true : undefined)
              }).catch(() => {
                if (!controller.signal.aborted) setAllowed(undefined)
              })
              return () => controller.abort()
            }, [absolutePath])
            if (!remoteWindow()) return null
            if (allowed === undefined) return null
            const title = allowed ? t('download.title') : t('download.denied')
            const onClick = () => {
              if (!allowed) return
              const run = typeof window !== 'undefined' ? window.__remoteControlDownload : undefined
              if (typeof run === 'function') run(absolutePath)
            }
            if (variant === 'icon') {
              return h('button', {
                type: 'button',
                title,
                'aria-label': title,
                'aria-disabled': allowed ? undefined : 'true',
                tabIndex: allowed ? undefined : -1,
                className: 'rrcTool',
                onClick,
              }, h(DownloadIcon(), null))
            }
            return h('button', {
              type: 'button',
              'aria-disabled': allowed ? undefined : 'true',
              tabIndex: allowed ? undefined : -1,
              title,
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '7px 16px',
                borderRadius: '8px',
                cursor: allowed ? 'pointer' : 'not-allowed',
                opacity: allowed ? 1 : 0.4,
                border: '1px solid var(--dsw-alias-border-neutral, rgba(0,0,0,.12))',
                background: 'var(--dsw-alias-bg-elevated, #fff)',
                color: 'var(--dsw-alias-text-primary, #111)',
                font: 'inherit',
                fontSize: '13px',
                lineHeight: 1.3,
              },
              onClick,
            }, h(DownloadIcon(), null), h('span', null, t('download.label')))
          }

          // The document preview header. Icon only, styled as the panel's own tool
          // button; the file card it duplicates already carries a labelled one.
          slots.inject('sidebar.right.tab.document.actions', () => slots.register({
            name: 'sidebar.right.tab.document.actions',
            id: 'remote-control-download',
            order: -1000,
            locale: NS,
          }, (props) => h(RemoteDownloadButton, { absolutePath: props?.absolutePath, variant: 'icon' })))
          // The placeholder a document tab shows when the file has no preview
          // (archives, binaries). It is a standalone button, so it keeps a label.
          slots.inject('sidebar.right.tab.document.unpreviewable', () => slots.register({
            name: 'sidebar.right.tab.document.unpreviewable',
            id: 'remote-control-download',
            order: -1000,
            locale: NS,
          }, (props) => h(RemoteDownloadButton, { absolutePath: props?.absolutePath, variant: 'label' })))
        } catch {
          // Never take the page down with this plugin.
        }
      },
    }
  },
})
