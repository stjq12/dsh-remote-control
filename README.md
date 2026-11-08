# Remote Control for DeepSeek Harness

A DeepSeek Harness plugin that establishes remote control between two computers, letting one computer operate a DeepSeek Harness instance running on another computer.

[简体中文](README.zh-CN.md)

## Use cases

- Continue a DSH session, workspace or files from a laptop while the actual Host runs on a desktop or server.
- Put a machine reachable only through Tailscale, SSH or WireGuard into the current browser window.
- Temporarily let another device view or operate this machine's DSH, then close the bridge immediately.

Both computers install the **same plugin**. The controlled machine uses the **Local** tab; the controller uses the **Remote** tab.

## How it works

```
Controller page
  │  /api, $events and other page traffic
  ▼
A-side plugin ── plain WebSocket (/bridge, bearer token) ──> B-side plugin ──> B's DSH
```

- **Local tab (B side):** starts a token-authenticated `/bridge` WebSocket and exposes this Host's RPC, live streams and broadcast events to authenticated controllers.
- **Remote tab (A side):** a page hook redirects this window's `/api` calls and `$events` stream to the bridge. Settings and attachments that belong to the local Host stay local.
- Both sides share one JSON state record (presets, switches, download policy, service lifetime); the state file is `0600`.
- Approval and question waterfalls are answered by the remote side while a controller is attached. The last controller gets a 10-second grace period, after which the request fails closed.
- Diagnostics are off by default. Set `DSH_REMOTE_CONTROL_TRACE=1` explicitly if you need a diagnostic file.

## Security and disclaimer

**This is full-control remote control, not a read-only viewer.**

- The bridge uses plaintext `ws://` and a bearer token. The token is equivalent to full control on the controlled Harness, including file reads and other high-risk operations. Use it only over Tailscale, SSH, WireGuard or another encrypted tunnel. Do not expose port 7400 (or your chosen port) to an untrusted LAN or the public internet.
- Use a strong token. Do not screenshot it, paste it into public chats, or commit it. Rotate it from the Local tab immediately if it may have leaked.
- **Do not leave permanent service enabled.** Prefer a bounded lifetime from 5 minutes to 24 hours and turn the switch off when finished. The Permanent option still ends when DSH exits; it is not a reboot-persistent service.
- **The file download policy is not a complete file-access boundary.** `off` only disables the download button; DSH preview may still read files through RPC. `shared` and `home` control the download channel only. Do not point the download root at `/`, an entire home directory, or a broad shared folder; grant the narrowest directory that contains the files you need.
- Do not give the token to an untrusted controller. Once connected, it can exercise full control over this DSH.
- This plugin is provided as-is, without warranty. You are responsible for network exposure, token custody, file permissions and any operation performed by a remote controller. Test in a controlled environment first.

## Usage

### Local tab (controlled machine)

1. Choose one concrete IP this machine already has (LAN, Tailscale or another interface) and a port at 1024 or higher.
2. Turn the switch on. An occupied port is reported as an error and stays off; the plugin does not shift ports.
3. On first use a token is generated. Copy it to the controller. Rotating it invalidates the old token immediately and drops old connections.
4. Set the Remote file download policy and service lifetime as needed. The file policy affects downloads, not previews.

### Remote tab (controller)

1. Enter the address and token shown on the other machine's Local tab.
2. Turn the switch on; the page reloads once and then uses the remote DSH.
3. Turning it off, or a failed connection, returns this window to the local Host. A failure shows one notice and falls back automatically.

### Save and presets

- **Save** only stores the address, port, token and name. It does not bind a port or move the live connection.
- **The switch** applies the target: the Local tab rebinds the listener; the Remote tab switches transport.
- **Selecting a preset** fills the form with that preset's address and token. It is not applied until the switch is turned on.
- Deleting the active preset turns the corresponding switch off. The last controller disconnect follows the grace rule.
- Both switches start off after every DSH start; the Local listener also does not resume across a DSH restart automatically.

### Known limitations

- The bridge supports `ws://` only, not WSS/TLS. Use an encrypted tunnel when needed.
- Remote file upload is not supported.
- Byte RPC results are capped at 64 MB; ordinary file downloads use 256 KB chunks and are not subject to that cap.
- Approvals/questions are shown only on the remote side when a controller is attached (a one-shot DSH waterfall limitation).

## Install

See [INSTALL.md](./INSTALL.md). Install the same plugin on both machines. Host-side code loads only when DSH starts; fully quit and restart DSH after replacing it.

## Repository

The GitHub URL will be added after the public release. The local profile currently uses the `@local/dsh-remote-control` alias; a public release should use `dsh-remote-control` (or `@scope/dsh-remote-control`).
