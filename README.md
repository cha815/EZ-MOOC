# EZ-MOOC

中国大学 MOOC（[icourse163.org](https://www.icourse163.org/)）视频学习辅助工具：填写课程链接，即可在同类新版课程页面中使用自动续播、固定 2 倍速和视频内不计分练习辅助作答。

项目由 **Tampermonkey 用户脚本 + Node.js 本地答题服务**组成。仅播放视频不需要模型 API；自动答题支持 DeepSeek 和 OpenAI。当前版本：**0.9.1**。

## 功能

- **填写链接换课**：在面板保存课程或视频链接，无需修改源码中的课程编号。
- **自动续播**：优先使用网站原生续播，必要时切换当前课时组的下一个视频，跳过文档标签。
- **固定 2 倍速**：运行期间设置并恢复 2 倍速；暂停或停止后可自行调整。
- **倍速验证**：分别显示目标值、播放器读数及实际播放时间测出的速度，未确认时如实提示。
- **练习作答**：识别视频内不计分的单选、判断、多选和普通文本填空，调用模型填写并提交。
- **答错后继续**：选择或填空错误后，记录结果并点击“继续学习”，不改选、不重新提交。升级后已经停留在结果页的练习，也可点击“开始”继续。
- **状态恢复**：同一标签页刷新或切换视频后继续运行，保存播放位置。
- **操作面板**：开始、暂停、停止、课程链接、设置和运行日志。
- **重复提交防护**：提交结果不明时暂停，不自动重交或试选其他答案。

页面适配曾在南京邮电大学《网络技术与应用》中核对，其他课程使用相同页面结构时可复用。**尚未验证所有课程、播放器和跨章节完整流程。**

## 快速上手

### 1. 安装用户脚本

1. 在 Edge / Chrome 安装 [Tampermonkey](https://www.tampermonkey.net/)，按扩展说明开启用户脚本支持。
2. 打开 [用户脚本安装链接](https://raw.githubusercontent.com/cha815/EZ-MOOC/main/mooc-helper.user.js)，在 Tampermonkey 中安装。若只看到源码，请新建用户脚本，粘贴 [mooc-helper.user.js](./mooc-helper.user.js) 全文并保存。
3. 手动登录中国大学 MOOC，打开课程介绍页或学习页，右侧应出现“MOOC 学习辅助”面板。
4. 在面板顶部粘贴课程链接，点击“保存并打开课程”，进入一个视频后点击“开始”。

此时可使用播放和倍速功能。遇到练习但未配置本地服务时，会暂停。

链接示例：

```text
https://www.icourse163.org/course/NJUPT-1001639008
https://www.icourse163.org/mooc/learn/NJUPT-1001639008/content?tid=1488273477
https://www.icourse163.org/mooc/learn/NJUPT-1001639008/content/1278945697?tid=1488273477
```

带 `tid` 的介绍页链接会转到该学期的课件入口；没有 `tid` 时，需在介绍页手动点击“已参加，进入学习”，再选择视频。脚本不猜测学期，也不自动选课或登录。

### 2. 下载并启动答题服务

需要 **Node.js 22 或以上版本**和模型服务 API Key。下载仓库 ZIP 解压，或使用 Git：

```powershell
git clone https://github.com/cha815/EZ-MOOC.git
Set-Location EZ-MOOC
npm.cmd ci
```

Windows PowerShell 中运行以下命令。API Key 使用隐藏输入，不写入源码：

```powershell
$env:AI_PROVIDER = 'deepseek'
$env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'DeepSeek API Key' -AsSecureString)).Password
$env:DEEPSEEK_MODEL = 'deepseek-flash'
$env:ANSWER_MODE = 'knowledge'
npm.cmd start
```

看到 `本地答题服务：http://127.0.0.1:17363` 即表示启动成功，**请保持终端窗口开着**。启动成功不代表密钥、余额和模型请求已经验证；实际请求失败会显示在脚本日志中。

macOS / Linux 可在项目目录使用 Bash：

```bash
npm ci
export AI_PROVIDER=deepseek
read -r -s -p 'DeepSeek API Key: ' DEEPSEEK_API_KEY
echo
export DEEPSEEK_API_KEY
export DEEPSEEK_MODEL=deepseek-flash
export ANSWER_MODE=knowledge
npm start
```

密钥仅存在当前终端环境，换终端后需重新设置。服务不自动读取 `.env`。

### 3. 连接脚本与服务

1. 首次启动后，项目目录会生成 `helper.local.json`，复制其中的 `token` 值。
2. 在课程面板展开“设置 / 页面适配”，将 JSON 中的 `"token": ""` 改为本地 token，保留其他配置，点击“保存设置”。
3. 点击“开始”，遇到可识别的视频练习时会请求模型、填写答案并提交一次。

**本地 token 与模型 API Key 是两回事**：API Key 填在终端，本地 token 填在油猴设置。换课时不需要更换它们。

## 日常操作

| 操作 | 行为 |
| --- | --- |
| 开始 | 播放当前视频，运行期间保持 2 倍速，处理视频内练习 |
| 暂停 / 停止 | 暂停视频，取消尚未应用的异步答案，不再强制倍速 |
| 保存并打开课程 | 保存新链接并跳转，选择视频后再开始 |
| 刷新或切换视频 | 同课程、同学期保留运行状态；手动暂停后不会自动启动 |

运行状态、播放位置和提交尝试保存在当前标签页的 `sessionStorage`，关闭标签页后不保证保留。本组没有可识别的下一视频时会暂停，需要手动选择下一组或章节。

倍速面板中，播放器读数来自实际 `video.playbackRate`；连续播放至少 3 秒后，用进度增量除以真实经过时间估算速度。暂停、缓冲、跳转或切换视频后重新计时。只有目标值或网站菜单文字，并不代表实际 2 倍速已确认。

## 模型与作答模式

### DeepSeek

默认使用 `deepseek-flash`，请求 `https://api.deepseek.com/responses`，通过 JSON Schema 返回答案，并关闭深度思考以减少等待。模型权限以你的 API 账户为准，参见 [DeepSeek 官方文档](https://api-docs.deepseek.com/api/create-response/)。

### OpenAI

按 `Ctrl+C` 停止服务，在原 PowerShell 窗口配置后重启：

```powershell
$env:AI_PROVIDER = 'openai'
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'OpenAI API Key' -AsSecureString)).Password
$env:OPENAI_MODEL = Read-Host '模型名称（需支持 Responses API 和 JSON Schema）'
npm.cmd start
```

请求 `https://api.openai.com/v1/responses`，设置 `store: false`，参见 [OpenAI 官方文档](https://developers.openai.com/api/reference/resources/responses/methods/create)。

### 知识模式与资料模式

| `ANSWER_MODE` | 行为 |
| --- | --- |
| `knowledge`（默认） | 根据模型自身知识返回最可能的答案，不要求资料，不设置信度门槛 |
| `materials` | 必须引用提供的课程资料，引用逐字核对；资料缺失时暂停 |

可将有权使用的讲义或字幕保存为 UTF-8 `.txt` / `.md`，放入 `materials/` 目录。服务启动时自动创建该目录。总内容不超过 12 万字符，每次请求重新读取，更新资料不需要重启。不自动解析 PDF、图片、语音或付费字幕。

切换到资料模式：

```powershell
# 先按 Ctrl+C，再设置模式并重启
$env:ANSWER_MODE = 'materials'
npm.cmd start
```

自动答题会将题干、选项及提供的资料发送给所选 API 服务，并按对应账户计费。API Key 不发送到课程页面；服务只监听 `127.0.0.1`，不保存题目日志。

**模型可能答错，知识模式会直接尝试最佳答案。** 有明确正确或错误反馈时点击“继续学习”并恢复播放；不会改选重试。无可用答案、填写失败、接口异常、提交结果不明或继续按钮不可用时仍会暂停。

## 常见问题

**面板不出现**：检查脚本已启用、浏览器允许用户脚本，以及地址位于 `https://www.icourse163.org/course/` 或 `/mooc/learn/` 下。保存脚本后刷新页面。

**无法连接本地服务**：检查终端仍开着、地址为 `127.0.0.1:17363`，以及 Tampermonkey 允许脚本访问该本地地址。

**token 不匹配**：填入本机 `helper.local.json` 的 token，不是 API Key。

**HTTP 401 / 429 或模型错误**：检查模型密钥、账户权限、余额和限流。脚本不自动重复提交，处理错误后再开始。

**提示没有课程资料**：当前为资料模式。想直接作答时，设置 `ANSWER_MODE=knowledge` 并重启服务。

**填空不处理**：更新脚本和本地服务。支持普通文本 input、textarea，每题最多 10 个字段；图片、拖拽和混合题型不支持。

**切换后停止或没有下一视频**：脚本会恢复同课程运行状态，但只有当前课时组的视频标签回退；组末需选择下一组。特殊页面需要另行适配。

**网站仍显示 1 倍速**：查看辅助面板的播放器读数和实测结果。0.9.0 会迁移旧设置并恢复运行时 2 倍速；暂停 / 停止后不强制修改。未检测到播放器时显示“未确认”。

**PowerShell 禁止 npm.ps1**：使用文档中的 `npm.cmd`。

## 兼容范围

- 面向中国大学 MOOC 的同类新版 HTML5 播放器和视频内**不计分练习**，不在测验、考试或论坛页自动作答。
- 不支持超星、学堂在线等其他网站，也不保证兼容所有 MOOC 课程。
- 不伪造学习记录或完成事件，不调用进度上报接口，不绕过登录、验证码、浏览器隔离或付费权限。
- 可读取同源 iframe；无法访问跨域播放器时暂停。
- 油猴 + 模型的所有课程完整流程尚未全面验证。不同页面结构可能需调整，详见 [页面适配说明](./docs/ADAPTATION.md)。

## 开发与验证

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run check
```

当前 **64 项自动测试**覆盖题目读取、填空事件、提交防重、答错后继续、异步取消、课程范围、视频切换、状态恢复与倍速控制。模型请求使用模拟响应，不代表真实模型正确率或所有课程兼容。

真实浏览器媒体验证：

```powershell
node scripts/verify-speed-server.mjs
```

打开 `http://127.0.0.1:17364/`，页面会生成本地 WebM，验证实际播放速度、倍速恢复和停止后的自由改速，约需 25 秒。结果写入 `logs/speed-verification.local.json`。0.9.0 的 7 项实播检查通过，两次实测约 2.000 倍速；此验证不访问课程、不调用模型。

```text
mooc-helper.user.js             油猴脚本与控制面板
server.mjs                     本地 HTTP 答题服务
solver.mjs                     模型协议与答案校验
test/helper.test.mjs            自动测试
scripts/verify-speed-server.mjs 本地实播验证服务
scripts/speed-fixture.html      真实媒体测试页
docs/ADAPTATION.md              页面适配说明
```

升级时在原油猴条目替换代码并保存，保留已有设置；服务代码变化后，在原终端按 `Ctrl+C` 再重新启动。不要公开 `helper.local.json`、API Key、个人资料或运行日志，这些文件已由 `.gitignore` 排除。

## 许可与反馈

[MIT License](./LICENSE)。欢迎通过 [Issues](https://github.com/cha815/EZ-MOOC/issues) 报告问题，请说明浏览器、脚本版本、页面类型及脱敏错误，不要提交密钥或 token。
