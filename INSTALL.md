# 安装到另一台电脑（手动包）

这个包**不需要编译**；运行时依赖 `@deepseek-ai/schemastery` 和 DSH 自带的 `ws`，由 profile 解析。把目录放进去、在 profile 里登记一行即可。

## 1. 解压到任意目录

```bash
mkdir -p ~/dsh-plugins
tar xzf dsh-remote-control-0.2.4-20261108.tar.gz -C ~/dsh-plugins
ls ~/dsh-plugins/dsh-remote-control    # index.js client.js bridge.js ... 都在这里
```

路径里有空格也可以，`package.json` 里的名字是 `@stjq12/dsh-remote-control`。

## 2. 让当前 profile 认识它

DSH 的 profile 在 `~/.dsh/profiles/<profile>/`，默认 profile 名是 `web`。
在它的 `node_modules/@local/` 下建一个软链接指向刚解压的目录：

```bash
PROFILE=web
SRC="$HOME/dsh-plugins/dsh-remote-control"
DST="$HOME/.dsh/profiles/$PROFILE/node_modules/@stjq12/dsh-remote-control"
mkdir -p "$(dirname "$DST")"
ln -sfn "$SRC" "$DST"
```

再在 profile 的 `package.json` 里登记成 bundle（用 python 改，避免手抖破坏 JSON）：

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / ".dsh/profiles/web/package.json"
d = json.loads(p.read_text())
bundles = d.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
if "@stjq12/dsh-remote-control" not in bundles:
    bundles.append("@stjq12/dsh-remote-control")
deps = d.setdefault("dependencies", {})
deps.setdefault("@stjq12/dsh-remote-control", "0.2.4")
p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
print("bundles:", bundles)
PY
```

（如果你的 DSH 用别的 profile 名，把两处 `web` 换掉。）

## 3. 重启 DSH 并确认

```bash
dsh web
```

打开界面后左下角应该多一个**「远程控制」**按钮。卡片有两个页签：

- **本机**：填本机已有的 IP 和端口（例如 `192.168.1.10:7400`），刷新/复制凭据，打开开关。
- **远程**：填对端「本机」页显示的 `IP:端口` 和凭据，打开开关；页面会刷新一次，之后使用对端 DSH。

- 两个开关**每次启动都是关闭的**（故意如此：重启后先保证本机可用）。
- 本机开关打开后如果端口被占用，会直接报错并保持关闭，不会自动顺延；请换一个端口。
- 远程开关关闭、删除当前远端预设会立即作用于 live 连接；保存/切换预设只改记录，点开关时才应用（必要时页面自动刷新）。
- 本机第一次打开开关且还没有凭据时会自动生成一个；从卡片复制给对端即可。

> 安全提示：bridge 是明文 `ws://`，token 等价于对端的 owner 权限。请只在 Tailscale / SSH 隧道等
> 已加密链路中使用，不要直接暴露到不可信局域网或公网。

## 4. 对端需要什么

对端安装**同一个插件**，在「本机」页打开开关，把「访问凭据」给这边即可；
不需要再单独运行 remote bridge。

## 5. 卸载

```bash
rm ~/.dsh/profiles/web/node_modules/@stjq12/dsh-remote-control
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / ".dsh/profiles/web/package.json"
d = json.loads(p.read_text())
d.get("dsh", {}).get("profile", {}).get("bundles", []).remove("@stjq12/dsh-remote-control")
d.get("dependencies", {}).pop("@stjq12/dsh-remote-control", None)
p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
PY
```

## 排错

| 现象 | 含义 |
|---|---|
| 左下角没有「远程控制」按钮 | profile 的 `bundles` 没写对，或链接路径错；看 `dsh web` 启动日志里有没有 `remote-control-host` 的报错 |
| 打开开关后连不上 | 地址/端口不对，或对端「本机」开关没打开（`nc -z -v 对端IP 7400` 先测端口） |
| 开关打开后列表还是本机 | 页面没自动刷新时手动刷新一次；确认凭据和对端地址正确 |
| 列表出来了但会话很少 | 对端 bridge 只报它自己启动时的会话/工作区；对端重启 DSH 后新会话才会全量出现 |
| 状态类信息（token 用量、正在生成）不刷新 | 已知限制：对端 bridge 不提供事件流端点，这部分来自对端轮询快照 |
