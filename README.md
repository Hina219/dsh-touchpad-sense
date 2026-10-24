# DSH Touchpad Sense

A Windows plugin for DeepSeek Harness (DSH) that reads a Precision Touchpad HID digitizer collection and makes recent activity available to an AI session. It can wake an idle session and ask for a short response when activity arrives. This is software event sensing, not physical touch or haptic feedback.

## Requirements

- Windows x64 and .NET 8 SDK to build the collector.
- A DSH installation that supports local Cordis plugins and client settings extensions.
- A touchpad whose HID digitizer collection is exposed to Windows Raw Input. Some Precision Touchpad drivers reserve these reports, so compatibility is device dependent.

## Install

1. Clone this repository and build the collector:

   ```powershell
   dotnet build .\collector\TouchpadCollector.csproj -c Release
   ```

2. Link the repository into the DSH plugin directory (adjust both paths):

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\plugins\dsh-touchpad-sense" -Target "C:\path\to\dsh-touchpad-sense"
   ```

3. Restart DSH. In Settings > 触控板, enable **采集输入** and optionally **AI 自动回应**. Capture is off by default.

The default device-name filter is `BLTP785`. To use another model, set `DSH_TOUCHPAD_DEVICE_FILTER` in the environment that launches DSH to a substring of its HID device name, then restart DSH. Set it to `*` to accept every device in the touchpad HID digitizer collection (Usage Page `0x0D`, Usage `0x05`). Prefer an exact device-name substring if several compatible devices are present.

## DSH tools and data

`touchpad_start` and `touchpad_stop` control capture. `touchpad_status` reports collector readiness, sample count, and errors; `touchpad_events` shows recent events. `touchpad_wake_sessions` lists eligible desktop sessions, and `touchpad_wake_config` selects a target session or changes the reply cooldown (default: 30 seconds).

Settings persist in `~/.dsh/touchpad-sense-config.json`; captured events remain in memory for up to one minute and are not written to disk. Auto replies go only to an active, idle session in the default DSH desktop workspace. A busy target can be retried for up to 15 seconds. The event is delivered as a `touchpad-sense` message, and DSH generates the reply in that session.

## Limits

- `ready: true` means the HID collection was registered, not that Windows is delivering reports. If `totalSamples` stays at zero while using the touchpad, this driver or device may not expose digitizer reports through Raw Input. Window-scoped `WM_POINTER` and `RegisterTouchWindow` messages do not provide background touchpad reports.
- When a contact count is exposed, the plugin may distinguish a tap or long press after confirmed release. Other reports indicate activity only. It does not promise finger tracking, pressure sensing, or physical haptics.
- The touchpad still controls the system pointer. Windows application-level APIs used here do not provide exclusive capture while continuing to read Precision Touchpad reports. The settings page displays this limitation.

## 中文说明

此插件通过 Windows Raw Input 读取触控板的 HID 数字化仪集合，向 DSH 提供短时事件，并可在触控活动出现时唤醒默认桌面工作区中的空闲会话，让 AI 简短回应。它不具备真实触觉或振动反馈。先用 .NET 8 SDK 构建 `collector/TouchpadCollector.csproj`，将仓库链接到 `~/.dsh/plugins/dsh-touchpad-sense`，重启 DSH，再在设置页开启「采集输入」。

默认匹配 `BLTP785`。其他设备可在启动 DSH 的环境中设置 `DSH_TOUCHPAD_DEVICE_FILTER` 为 HID 设备名的一部分；`*` 表示接受所有相应数字化仪集合。采集默认关闭，最近一分钟的事件仅存于内存，设置保存在 `~/.dsh/touchpad-sense-config.json`。若状态显示 `ready: true` 但 `totalSamples` 一直为零，通常是驱动未向应用开放数字化仪 Raw Input。插件不能阻止触控板继续控制系统指针。

## License

MIT. See [LICENSE](LICENSE).
