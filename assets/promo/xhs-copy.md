# 小红书发布素材 / Xiaohongshu kit

## 说明

这是一版更平实的文案。目标是把“是什么、怎么用、注意什么”说清楚，不堆情绪词。

## 推荐标题

- **远程使用另一台电脑的 DSH**（推荐）
- 一个 DeepSeek Harness 远程控制插件
- 两台电脑之间使用同一个 DSH
- 把另一台电脑的 DSH 接到当前窗口

## 正文

两台电脑都安装这个插件，就可以在当前窗口使用另一台电脑上的 DeepSeek Harness。

本机页：选择本机已有的 IP 和端口，打开开关，复制访问凭据。
远程页：填写对端地址和凭据，打开开关；页面刷新后生效。

远程连接存在时，权限确认和 AI 提问由远程端回答。远程下载可以在本机页限制目录。

注意事项：
- bridge 使用明文 `ws://` 和 token，只应在 Tailscale、SSH、WireGuard 等可信链路内使用。
- token 具有完整控制权限，不要截图或发到公开聊天；泄露后立即轮换。
- 不建议长期开启，优先使用有限时长，用完关闭。
- 下载策略只控制下载，不控制预览；预览仍可能通过 RPC 读取文件。目录只给需要的范围。

代码已准备开源。GitHub 链接放在评论区，正文和图片里不直接放完整 URL。

## 标签

#DeepSeekHarness #DSH插件 #开源项目 #远程控制 #程序员 #AI工具 #效率工具 #Tailscale #本地部署

## 图片顺序

1. `xiaohongshu-01-cover.png` — 封面
2. `xiaohongshu-02-features.png` — 功能说明
3. `xiaohongshu-03-ui.png` — 实际界面截图
4. `xiaohongshu-04-usage.png` — 使用步骤
5. `xiaohongshu-05-security.png` — 使用注意事项

## 置顶评论

> 项目：dsh-remote-control（DeepSeek Harness 插件）
> GitHub 地址发布后补充。使用前请先看 README 的安全说明。
> 只在自己的设备或可信网络中使用。

## 发布注意

- 不写“零风险”“绝对安全”“一键无脑”等承诺。
- 不伪造 star、用户量或评价。
- 截图不放 token、内网地址和个人路径。
- 图片里只放仓库 ID（例如 `stjq12/dsh-remote-control`），不要放完整 `https://` 链接或二维码。
