# wechat-mp：公众号搜索、追踪、下载

一个给 Claude Code 等 AI 助手用的 skill，也可以单独当命令行用。它通过微信读书的公众号功能，帮你搜索公众号和文章、追踪一批号的新文章，并把正文和图片下载成本地 Markdown。

访问微信读书用的是自带的客户端（只读）：登录和请求部分取自开源项目 [weread-omni](https://github.com/teng-lin/weread-omni)，已经并入本工具，不用另外安装。主要特点：

- **本地数据库**：搜过的号、拉过的文章列表、下载状态都存在 SQLite 里，不会重复请求。
- **完整正文**：从文章页的正文区域提取正文和图片，保存成带文件头的 Markdown；视频、语音留下占位，表格尽量还原。
- **不漏文**：微信读书的文章列表按群发分页，一次群发可能有好几篇；本工具按群发次数翻页，研报号这类一次发多篇的号多页同步也不会漏。
- **防风控节奏**：请求之间自动放慢，遇到微信读书的人机验证、限流或微信的验证页会立刻停下，不会重试。

## 需要什么

| 必需 | 说明 |
|---|---|
| Node.js ≥ 22.13 | 唯一要装的软件，装法见下文“安装 Node.js”。数据存在 Node 自带的 SQLite 里，不用另装数据库 |
| 微信账号 | `wxmp login` 在终端显示二维码，用手机微信扫码登录微信读书。不需要会员：公众号文章免费，付费文章只能拿到试读部分 |
| 手机上的微信读书 App | 新设备第一次搜索常会触发人机验证（`-2041`），要在 App 里随便搜一下完成验证。没用过微信读书的，建议先在 App 里用微信登录一次 |
| 网络 | 能访问微信读书和公众号文章页（`mp.weixin.qq.com`）；加 `--images` 下载图片时还要访问微信图片 CDN（`mmbiz.qpic.cn`） |

**不用安装任何东西**：除了 Node.js 本身，用到的组件都已经放在 `scripts/vendor/` 里（HTML 转 Markdown 的 turndown 和它的表格插件、HTML 解析器 domino，在终端显示登录二维码的 qrcode-terminal，以及微信读书的登录和请求模块，一共不到 1 MB）。复制或克隆文件夹就能用，不用 npm，也不联网装包。

**不需要**：公众号后台账号、任何 API Key、Python、浏览器。Claude Code 等支持 skill 的 AI 助手是可选的，命令行可以单独用。

## 安装 Node.js

wxmp 只需要 Node.js 22.13 或更高（装 LTS 长期支持版即可），这是唯一要装的东西。先在终端里看看有没有、版本够不够：

```bash
node --version     # 显示 v22.13.0 或更高就可以，跳过本节
```

没有或版本太旧时，按系统选一种方式装：

| 系统 | 安装方式 |
|---|---|
| Windows 10 / 11 | 在 PowerShell 里运行 `winget install OpenJS.NodeJS.LTS`；或者到 [nodejs.org 下载页](https://nodejs.org/zh-cn/download) 下载 Windows 安装包（选 LTS，`.msi`），双击后一路“下一步” |
| macOS | 装了 [Homebrew](https://brew.sh) 的运行 `brew install node`；否则到 [nodejs.org 下载页](https://nodejs.org/zh-cn/download) 下载 macOS 安装包（选 LTS，`.pkg`），双击安装 |
| Linux | 发行版自带的 `nodejs` 软件包常常低于 22.13，建议按 [nodejs.org 下载页](https://nodejs.org/zh-cn/download) 给出的命令先装 nvm，再运行 `nvm install --lts` |

装完要**关掉终端重新打开一个**（新装的 `node` 在新终端里才找得到），再运行 `node --version` 确认。国内从 nodejs.org 下载慢时，可以从镜像 [npmmirror.com/mirrors/node](https://npmmirror.com/mirrors/node/) 下载同样的安装包：进入 LTS 版本号的目录，Windows 选文件名以 `-x64.msi` 结尾的，macOS 选 `.pkg`。

wxmp 只用 Node.js 本身，不用 npm 装任何包。还没装 Node 就运行 `wxmp`，启动脚本会提示怎么装。

## 安装

1. **Node.js ≥ 22.13**：见上一节。版本不够时 wxmp 会直接提示。
2. **放置 skill：** 把本仓库放到 AI 助手的 skills 目录，文件夹名用 `wechat-mp`，例如 Claude Code 是 `~/.claude/skills/wechat-mp`（没有 `skills` 文件夹的话 `git clone` 会自动建）：

   ```bash
   # macOS / Linux
   git clone <本仓库地址> ~/.claude/skills/wechat-mp
   ```

   ```powershell
   # Windows（PowerShell）
   git clone <本仓库地址> "$env:USERPROFILE\.claude\skills\wechat-mp"
   ```

   不用 git 的话，在仓库页面下载 ZIP，解压后把文件夹改名为 `wechat-mp` 放进去。只当命令行用的话放哪里都行。复制完就能用，不用安装依赖。

   下面的 `wxmp` 指这个文件夹里的启动脚本，命令都在这个文件夹里运行：macOS / Linux 是 `./wxmp`（提示 Permission denied 时先运行一次 `chmod +x wxmp`）；Windows 的 PowerShell 里是 `.\wxmp.cmd`，cmd 里是 `wxmp.cmd`。任何系统都可以用 `node scripts/wxmp.mjs` 代替（详见下一节）。

3. **登录：** 在自己的终端里运行

   ```bash
   wxmp login        # macOS / Linux：./wxmp login；Windows PowerShell：.\wxmp.cmd login
   ```

   终端会显示二维码，用手机微信扫码确认。这会在你的微信读书账号上登记一台“墨水屏设备”，登录凭证以明文保存在 `~/.config/weread`。每个人用自己的微信登录，不要拷贝别人的这个目录。没扫成或二维码过期，重新运行 `wxmp login` 即可。

4. **自检：** `wxmp doctor`，全部 `[ OK ]` 就可以用了；有 `[FAIL]` 的行会写明怎么处理。在 AI 助手里直接说“搜一下某某公众号”“追踪这几个号”“把这篇文章下载下来”即可。

**更新**：在 `wechat-mp` 文件夹里 `git pull`，或用新下载的文件夹整个替换它。数据在单独的数据目录里（见下文“数据放在哪”），替换文件夹不会动它；登录也不用重来。

## 在终端里直接用 `wxmp`

- **Windows PowerShell**：`& "$env:USERPROFILE\.claude\skills\wechat-mp\wxmp.cmd" status`，在这个文件夹里就是 `.\wxmp.cmd status`。**命令里有文章链接时改用 `node scripts\wxmp.mjs`**，例如 `node scripts\wxmp.mjs fetch "链接"`：PowerShell 调用 `.cmd` 时会经过 cmd.exe，链接里 `&` 之后的部分会被截掉（`fetch` 发现链接不完整会提示）。
- **Windows cmd**：`%USERPROFILE%\.claude\skills\wechat-mp\wxmp.cmd status`；链接要加双引号。想直接敲 `wxmp`，把这个目录加进 PATH。
- **macOS / Linux**：`ln -s ~/.claude/skills/wechat-mp/wxmp ~/.local/bin/wxmp`（`~/.local/bin` 要在 PATH 里；启动脚本会顺着软链接找到 skill 目录）。
- 任何系统都可以直接 `node --no-warnings <skill 目录>/scripts/wxmp.mjs <命令>`。

## 常用命令

下面的 `MP_WXS_1234567890`、`某某研究所`、`量化择时` 都是示例，换成自己的号 ID（用 `search account` 结果里的）、库里的公众号名称和搜索词。

```bash
wxmp login                                # 第一次：微信扫码登录
wxmp search account 某某研究所            # 搜公众号（模糊匹配，自己确认 ID）
wxmp watch add MP_WXS_1234567890          # 加入本地关注（示例 ID）
wxmp watch add "https://mp.weixin.qq.com/s?__biz=..."   # 或者给一篇该号的文章链接
wxmp sync                                 # 拉关注号的新文章（首次回看 30 天）
wxmp sync --account MP_WXS_1234567890 --days 1   # 只看某个号最近一天（一般 1 页）
wxmp list --account 某某研究所 --top 5     # 看最新几篇
wxmp download --account 某某研究所 --limit 10 --images   # 下载正文和图片
wxmp fetch "https://mp.weixin.qq.com/s?..."              # 按链接下载一篇
wxmp search article 量化择时               # 搜文章；要下载其中一篇：wxmp download --review <文章ID>
wxmp export --since 2026-08-01            # 导出 CSV
wxmp status                               # 总览
```

完整说明见 [SKILL.md](SKILL.md)，或运行 `wxmp help`。

退出码：`0` 全部成功；`1` 参数错误、有部分没处理成功、已有任务在运行、`doctor` 有检查没通过，或 `login` 没有完成；`2` 联网命令碰到风控、登录失效或微信读书接口不正常，已经停下（按提示处理，不要马上重试）。

同一个数据目录同时只能跑一个会联网或改文件的命令（search / sync / download / fetch / refix / import），第二个会提示后退出，避免重复请求触发风控。查看类命令（list / status / export）不受影响。

各版本的改动见 [CHANGELOG.md](CHANGELOG.md)。

## 数据放在哪

数据目录默认是 `~/wechat-mp-data`；设了环境变量 `WXMP_HOME` 就用它指定的目录。运行 `wxmp doctor` 可以看到实际用的是哪个。

- `wxmp.db`：数据库（文章索引、关注列表、搜索记录）
- `articles/<公众号>/`：正文 Markdown（文件名里是发布日期），`assets/` 里是图片
- `raw/`：正文区域的原始 HTML（压缩），用于离线重新提取
- `exports/`：导出的 CSV

数据库里存的是相对路径，整个目录可以搬到别处，设好 `WXMP_HOME` 就能继续用。所有时间都是北京时间。

## 导入已有数据

另外装了 [weread-omni](https://github.com/teng-lin/weread-omni) 命令行的人，可以把它的命令加 `--json` 重定向到文件，再用 `wxmp import` 导入。注意 weread-omni 0.1.2 自己翻文章列表会漏（见 [SKILL.md](SKILL.md) 的“导入”一节），要完整的列表请用 `wxmp sync`：

```bash
weread-omni search books 关键词 --scope 2 --json > s.json          # 搜号结果
weread-omni public-accounts articles MP_WXS_123 --json > l.json      # 文章列表
weread-omni public-accounts read-article "<文章链接>" --json > a.json # 单篇正文
weread-omni public-accounts export MP_WXS_123 --out ./exp            # 导出目录
wxmp import s.json l.json a.json ./exp
```

## 限制与风险

- **非官方接口**：本工具用的是微信读书的非公开接口（以墨水屏阅读器的身份登录），随时可能失效，也可能被风控。请低频、个人使用。
- **风控**：新设备第一次搜索常会要求人机验证（`-2041`），在手机微信读书 App 里随便搜一下、完成验证即可。遇到限流（`-2010`）要等几个小时。
- **太早的文章拿不到**：`sync`（包括用 `--since` 回补）是顺着微信读书里这个号的文章列表往前追溯的，而这个列表只有最近约 500 次群发（10 页）：实测日更的号能回到约 20 个月前，新华社这种每天群发十几次的号只能回到不到一个月前。比列表末尾更早的文章用这个方法获取不到，`--since` 设得再早、`--max-pages` 设得再大也没用。只能用 `wxmp search article <号名或文中的一句话>` 一篇篇搜，搜到再按文章 ID 下载；搜索结果有上限，没法把更早的历史列全。
- **数据不全**：微信读书是否收录了某个号的全部文章无法保证；搜文章不返回发布时间；有的号列表时间是收录批次时间，不是发文时间。
- **版权**：文章版权归原作者。下载内容仅供个人学习研究，不要转载或公开发布。
- **只读**：本工具只调用读取类的接口（搜索、文章列表、文章信息、按链接查文章），不会修改你的书架、笔记或订阅。登录凭证明文保存在 `~/.config/weread`；在 Windows 上这个目录的权限沿用用户目录的设置，共用电脑时请自己收紧。

## 开发与测试

```bash
npm test          # 等同于 node --no-warnings --test "tests/*.test.mjs"
```

测试完全离线：`tests/mock-weread.mjs` 模拟微信读书客户端的命令和输出，`tests/fake-weread.mjs` 在本机模拟微信读书的接口和文章页（用来测内置客户端），`tests/fixtures/` 是虚构的公众号和文章，不含任何真实文章内容。每个测试都在临时目录里运行，登录目录也是临时的，不会碰你的真实数据和真实登录。

环境变量（一般都不用设）：

| 变量 | 作用 |
|---|---|
| `WXMP_HOME` | 数据目录 |
| `WXMP_WEREAD_ROOT` | 改用外部的 weread-omni：设成它的安装目录后，wxmp 运行它的命令行而不是内置客户端（内置客户端出问题时的退路） |
| `WXMP_TIMEOUT_MS` | 单次请求的超时（默认 90 秒，读原文页 60 秒） |
| `WEREAD_CONFIG_DIR` | 登录凭证所在的目录（默认 `~/.config/weread`，和 weread-omni 通用）；有多个账号时用 `WEREAD_ACCOUNT` 选一个 |

只给测试用、平时不要设的：`WXMP_WEREAD_CLI`（用另一个 JS 文件代替微信读书客户端）、`WXMP_WEREAD_API` 和 `WXMP_WEREAD_ARTICLE_ORIGIN`（把接口和文章页指到本机的模拟服务）。

已测试环境：Windows 11、Node 24。macOS / Linux 只用到了跨平台的 Node API，但还没有实机测试。

## 致谢与许可

- 作者：Pengfei Wang。以 MIT 许可发布，见 [LICENSE](LICENSE)。
- 登录、令牌刷新和请求层取自 [weread-omni](https://github.com/teng-lin/weread-omni) 0.1.2（Teng Lin，MIT），放在 `scripts/vendor/weread-omni/`（只去掉了每个文件末尾的 sourceMappingURL 注释行，见该目录的 README），许可证在同一目录；读原文页的链接校验和跳转处理也参照了它。
- 随附的第三方组件（放在 `scripts/vendor/`，各自的许可证在对应目录，来源和版本见 [scripts/vendor/README.md](scripts/vendor/README.md)）：[turndown](https://github.com/mixmark-io/turndown) 7.2.5 和 [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) 1.0.2（MIT）、turndown 用的 HTML 解析器 [domino](https://github.com/mixmark-io/domino) 2.2.0（BSD-2-Clause）、[qrcode-terminal](https://github.com/gtanner/qrcode-terminal) 0.12.0（Apache-2.0）。
- 与微信、微信读书、腾讯无关。
