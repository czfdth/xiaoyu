# 绘图失败后的换路

`qq_draw` 先检查 ComfyUI `/system_stats`，连不上时不会先花时间调用翻译模型。主服务生成失败、超时或返回非图片内容时，最多切换一次 CPU 本地插画，不停止 TTS，也不自动开通其他付费服务。

返回值包含 `requestedProvider`、实际 `provider`、`degraded` 和每次尝试的原因；尝试记录保存在本机 `state/drawing-attempts.jsonl`。本地插画通过现有 Pillow 渲染器生成，支持书桌、鲸鱼、猫、月亮等有限场景，不能代替任意描述的模型绘图。可用 `fallbackTemplate` 明确选场景，用 `caption` 写短标题。配置 `socialV2.draw.fallback=false` 可禁用备用。

生成草稿不传 `key`；关联到页面后实际查看图片，自检通过才能归档，再用 `qq_send_image` 发送。交付登记仍须核对作品哈希和真实 QQ 消息回执；服务接单、文件存在或自检通过都不等于交付。

三次失败后停止自动重试。QQ 用户的新指令或带控制台认证的操作员明确授权才能恢复，操作员授权独立标记为 `authenticated_operator`，不伪造 QQ 消息，模型的 `operatorReason` 字段不能自行授权。

2026-10-26 本机诊断：ComfyUI 8188 未监听，TTS 占用大部分显存。本次恢复依靠 CPU 备用，不代表 ComfyUI 服务已经恢复。原配置、人格、记忆与历史作品保留，部署工具对保护文件做哈希校验并创建本机备份。
