# 英语跟读练习（PWA）

成人日常口语跟读练习：**听原声 → 跟读录音 → 语音识别打分 → 回听自己的声音 → 每日打卡**。

零依赖静态站点（原生 HTML/CSS/ES 模块，无构建步骤），部署到 GitHub Pages 后，安卓手机用
Chrome 打开并「添加到主屏幕」，即可像 App 一样全屏使用。数据全部存在手机本地，无账号、无后端。

## 目录结构

```
outputs/
├── index.html              应用入口
├── styles.css              全部样式（移动端优先）
├── manifest.webmanifest    PWA 清单（名称/图标/独立窗口）
├── sw.js                   Service Worker：离线缓存
├── icons/                  192 / 512 / maskable 图标
├── package.json            仅用于标记 ESM 与测试脚本，不影响页面
├── .nojekyll               让 GitHub Pages 原样发布，不走 Jekyll
└── js/
    ├── app.js              路由、视图渲染、交互
    ├── data.js             内置句库（6 场景 × 10 句）
    ├── score.js            跟读打分（纯函数）
    ├── speech.js           朗读 / 录音 / 语音识别封装与降级
    └── store.js            本地数据层（localStorage）
```

## 本地预览

```bash
node work/tools/serve.mjs 5173     # 打开 http://localhost:5173/
```

电脑上可以完整体验：听原声、跟读录音、打分、记录、导入导出。

> 手机通过局域网 IP 访问时**麦克风会被浏览器阻止**（非 HTTPS 不是安全上下文），
> 所以真机体验必须部署到 HTTPS 地址。

## 部署到 GitHub Pages

1. 在 GitHub 新建一个仓库，例如 `english-shadowing`。
2. 把 `outputs/` 里的全部文件推到仓库根目录（`main` 分支）：

   ```bash
   cd outputs
   git init -b main
   git add .
   git commit -m "英语跟读练习 PWA"
   git remote add origin https://github.com/<你的用户名>/english-shadowing.git
   git push -u origin main
   ```

3. 仓库 **Settings → Pages**，Source 选 `Deploy from a branch`，分支选 `main`、目录选 `/ (root)`。
4. 等 1–2 分钟，访问 `https://<你的用户名>.github.io/english-shadowing/`。
5. 手机用 Chrome 打开该地址 → 右上角菜单 → **添加到主屏幕**，之后从桌面图标进入。

站点所有资源都用相对路径，因此放在仓库子路径下也能正常工作。

> 推送需要凭证：本机没有 `gh` CLI 和 SSH 密钥，使用 HTTPS 推送时需要 GitHub
> Personal Access Token（或先配置 SSH key）。没有凭证前，成品可在本地正常使用。

## 使用方式

1. 首页选择场景（问候寒暄 / 点餐 / 问路 / 购物 / 打电话 / 工作寒暄，另有「我的句子」）。
2. 点进句子 → **听原声**（语速可选 0.6x / 0.8x / 原速）→ **开始跟读**。
3. 说完自动结束（也可手动点停）：显示分数、逐词着色（绿=读对、红=漏读或读错、划掉=漏读）、
   识别文本，并可**回听自己的录音**。
4. 「记录」页查看连续打卡、每日练习量、平均分和待复习句（低于 60 分可直接点进去重练）。
5. 「我的」页可改每日目标、默认语速、关闭自动打分，维护自己的句子，以及导出/导入 JSON 备份。

## 浏览器能力与限制

| 能力 | 说明 |
| --- | --- |
| 听原声（TTS） | 用系统语音合成，安卓 Chrome 可用；设备需装有英语语音包，否则练习页会给出安装提示 |
| 录音回听 | 需要 HTTPS（或 localhost）与麦克风权限 |
| 语音识别打分 | 依赖 Chrome 的 `webkitSpeechRecognition`，**需要 HTTPS 且联网**（识别在云端完成） |
| 离线使用 | 静态资源与句库已缓存，断网可浏览、练习与回听；TTS/识别按设备与网络情况降级 |

任何能力不可用时，界面都会明确说明原因，不会出现「点了没反应」或假分数。

## 数据与备份

- 单键存储：`localStorage['enshadow.v1']`，结构为
  `{ version, settings, customSentences, history, checkin }`。
- 练习历史最多保留 500 条（超出丢弃最早的记录）。
- 「导出备份」得到 `enshadow-YYYY-MM-DD.json`；「导入备份」按句子 id 与时间戳去重合并，
  打卡取较大值，设置只覆盖文件中明确写出的字段。换手机时用导出/导入迁移。

## 测试

```bash
node work/tests/score.test.mjs    # 打分算法（归一化、缩写展开、漏读/多读/错读、边界）
node work/tests/store.test.mjs    # 数据层（打卡、连续天数、统计、导入导出、清洗、配额）
```

语法检查：

```bash
for f in outputs/js/*.js outputs/sw.js work/tools/serve.mjs; do node --check "$f"; done
```

## 维护提示

- 改内置句库：编辑 `js/data.js`（字段 `id / en / zh / tip`）。
- 改完页面资源后，把 `sw.js` 里的 `CACHE_VERSION` 加一，否则老用户会继续用缓存。
- 重新生成图标：`python work/tools/make_icons.py`。
