# 页面适配

常规换课只需在面板顶部填写课程链接。本页用于默认控件结构无法识别的情况。

通过开发者工具“元素”面板确认真实 DOM，再修改辅助面板 JSON 中的 CSS 选择器。不要把整个页面、测验或考试容器配置为视频练习。

| 字段 | 说明 |
| --- | --- |
| `token` | 本地服务凭证，不是模型 API Key |
| `courseUrl` | 目标链接；可在面板顶部填写，留空使用当前课程 |
| `video` | 唯一可见的 HTML video，默认 `video` |
| `quiz` | 视频内不计分弹题容器 |
| `stem` | 容器内唯一题干元素 |
| `option` | 含 radio / checkbox 和完整选项文字的 label |
| `submit` | 提交按钮，文字需为“提交”“提交答案”或“确定” |
| `continue` | 反馈后的“继续”“继续播放”“继续学习”或“完成”按钮 |
| `nativeAutoNext` | 网站“自动播放下一视频”复选框 |
| `next` | 可选的唯一下一视频按钮，默认使用原生续播或标签回退 |
| `maxRetries` | 播放重试次数，1～5，默认 3 |
| `playbackRate` | 运行期间固定 2；暂停或停止后可自行改速 |

默认识别 `.mooc-video-player__anchor-overlay.is-blocking[role="dialog"]` 弹题容器与 `.rich-text-unit-renderer` 题干。填空识别容器中的普通文本 input 和 textarea，每题最多 10 个字段。已有手动输入与模型结果不同、或超过字段长度时暂停。

`[data-mooc-next-video]` 和 `[data-mooc-continue]` 是自定义或测试页面的占位属性，不代表平台一定存在这些属性。继续选择器同时包含真实弹题按钮；下一视频回退使用同一 tablist 内当前标签之后带 `data-lesson-type-icon="video"` 的标签。

原生续播开启时先等待 5 秒，页面未切换再正常点击下一视频。点击后 20 秒未加载则暂停，不重复点击。本组没有下一视频时需手动选择章节。

自定义选项不含 radio / checkbox、图片题、跨域 iframe 或不同播放器，仅修改选择器可能不够，需要修改适配代码并补充测试。扩大 URL 匹配范围不能解决控件结构差异。
