# Pocket Casts for MyGo Music

在 [MyGo Music](https://github.com/egoist/mygo-music) 里听 Pocket Casts 播客：订阅、搜索、节目简介、收藏，以及 HE-AAC 单集的自动转码播放。

Unofficial Pocket Casts source plugin for MyGo Music — subscriptions, search, show notes and HE-AAC playback.

> 不是 Pocket Casts 官方插件，使用网页端当前的非官方接口。接口变化时可能需要更新。

## 功能

- 登录：在 MyGo 内嵌窗口里走 Pocket Casts 自己的网页登录，支持邮箱密码、Google 或 Apple 登录。
- 账号：显示邮箱和 Pocket Casts 同款 Gravatar 头像。
- 发现：热门播客、趋势播客；登录后显示最新节目和进行中的节目。
- 订阅：读取订阅列表，支持订阅/取消订阅。
- 搜索：搜索播客和单集，输入时给出建议。
- 节目简介：单集带上 show notes（HTML 转纯文本），播放器「简介」标签直接可读。
- 收藏与历史：读取收藏和历史记录，支持收藏/取消收藏单集。
- 播放：MP3、AAC-LC 直接播放；HE-AAC 单集用 ffmpeg 转 96 kbps MP3 串流播放。
- 会话：访问令牌过期时自动用刷新令牌续期。

## 安装

需要 MyGo Music `0.1.21` 或更高版本。

在 MyGo Music 的「设置 → 插件」中点 `+`，填入仓库名：

```text
louisgreen0726/mygo-music-pocket-casts
```

或者直接打开安装链接：

```text
mygo-music://install-plugin?repo=louisgreen0726/mygo-music-pocket-casts
```

安装后在「设置 → 插件 → Pocket Casts」登录即可。

### HE-AAC 需要 ffmpeg

部分播客（例如从喜马拉雅分发的节目）使用 HE-AAC 编码，MyGo Music 内置解码器只支持 AAC-LC。遇到这类单集时插件会调用本机 `ffmpeg` 边解码边播放，需要先安装：

```powershell
winget install Gyan.FFmpeg
```

装好后在「设置 → 插件 → Pocket Casts」点一次「允许启动程序」；没有 ffmpeg 时，这类单集仍然会报解码错误，其余单集不受影响。

## 登录与隐私

- 登录走 Pocket Casts 自己的网页，插件只读取 `auth` cookie 里的访问令牌和刷新令牌，不接触账号密码。
- 令牌保存在本机 MyGo Music 的插件数据目录（`plugin-data/pocket-casts/storage.json`）。
- 「退出登录」只删除本机令牌；要终止服务端会话，请到 Pocket Casts 的登录设备管理中退出。
- 插件只访问以下主机：`api.pocketcasts.com`、`podcast-api.pocketcasts.com`、`lists.pocketcasts.com`、`pocketcasts.com`、`play.pocketcasts.com`、`static.pocketcasts.com`、`podcasts.pocketcasts.com`、`www.gravatar.com`。

## 已知限制

- 视频播客不播放，单集会标记为不可用。
- 播放进度暂时不能写回 Pocket Casts：MyGo 的插件接口没有进度回调（`played` 只给单集 ID），需要上游先加钩子。
- Pocket Casts 的 Playlists 是规则型筛选（未听完、已听完、全部播客等），暂未接入。
- 章节、转录文本、评分、书签、文件夹和收听统计暂未接入。
- 转码的 HE-AAC 单集从 0 开始串流，拖动到很靠后的位置要等 ffmpeg 转码到那里；播放过一次进入缓存后就正常了。
- 未登录也能浏览热门、趋势、搜索和节目页。

## 开发

```powershell
npm run check       # JavaScript 语法检查
npm test            # 离线测试，不需要 Pocket Casts 账号
npm run test:live   # 访问公开接口，搜索、节目页和播放地址
npm run package     # 生成 dist/plugin.zip
npm run install:dev # 安装到本机 MyGo Music
```

离线测试使用 `tests/harness.mjs` 里的模拟 `host` 和 `fetch`，覆盖登录 cookie、搜索、订阅、收藏、刷新令牌、账号头像、节目简介、播放地址和 HE-AAC 转码分支。联网测试不登录，只验证公开接口。

```text
plugin.json          插件清单、权限和侧栏
index.js             单文件插件入口
locales/zh-CN.json   简体中文翻译
tests/harness.mjs    模拟 MyGo host 的 Node 加载器
tests/smoke.test.mjs 离线接口与数据形状测试
tests/live.mjs       无登录的公开接口联网测试
scripts/             本地安装与打包脚本
```

MyGo Music 按 `plugin.json` 的 `main` 加载一个 JavaScript 或 TypeScript 模块，这里保持单文件实现，不依赖打包器。

## 接口说明

- `https://pocketcasts.com`：在 MyGo 的内嵌窗口中完成登录，读取 `auth` cookie。
- `https://api.pocketcasts.com`：账号、订阅、最新节目、进行中、收藏、历史、刷新令牌和收藏操作。
- `https://podcast-api.pocketcasts.com`：播客搜索、完整节目数据和单集节目简介（`/episode/show_notes/{uuid}`）。
- `https://lists.pocketcasts.com`：热门（`popular.json`）和趋势（`trending.json`）播客列表。
- `https://static.pocketcasts.com`：播客封面。
- `https://www.gravatar.com`：账号头像。

登录后的请求使用 `Authorization: Bearer <accessToken>`。网页登录的 cookie 里只有令牌，没有昵称、邮箱和头像，所以登录后会用刷新接口返回的 `email` 和 `uuid` 补全账号信息，并按邮箱的 Gravatar 哈希显示头像。

## 许可

[MIT](LICENSE)

Pocket Casts 是 Automattic 的商标。本项目与 Pocket Casts、Automattic 无关联。
