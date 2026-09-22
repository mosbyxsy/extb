# extb

`extb` 是面向 Chrome、Edge、Firefox 等 WebExtension 的依赖感知型打包工具。它从 `manifest.json` 出发分析插件真正依赖的文件，压缩 HTML、CSS、JavaScript，并可选执行 JavaScript 深度混淆、ES5 转译和 ZIP 归档。

## 目录

- [特性](#特性)
- [安装](#安装)
- [快速开始](#快速开始)
- [默认配置](#默认配置)
- [查看默认配置](#查看默认配置)
- [查看最终配置](#查看最终配置)
- [压缩与混淆等级](#压缩与混淆等级)
- [文件收集规则](#文件收集规则)
- [CLI](#cli)
- [构建预演与输出控制](#构建预演与输出控制)
- [CLI 与配置文件对应关系](#cli-与配置文件对应关系)
- [配置文件](#配置文件)
- [Node.js API](#nodejs-api)
- [兼容性说明](#兼容性说明)
- [License](#license)

## 特性

- 递归发现唯一的 `manifest.json`，也可以显式指定。
- manifest 扫描自动忽略默认或自定义输出目录，以及残留的构建临时/备份目录。
- 只打包 manifest 入口及其递归依赖，不复制 `.git`、`.idea`、源码备注等无关文件。
- 追踪 HTML 资源、CSS `url()`/`@import`、ES modules、Worker、`importScripts()`、`runtime.getURL()`、DNR 规则和 Web Accessible Resources。
- 默认安全压缩 HTML、CSS 和 JavaScript，不改变文件名、目录结构及资源 URL。
- HTML、CSS、JavaScript 分别支持 `none`、`safe`、`aggressive` 三级压缩。
- JavaScript 压缩与标识符混淆独立配置，混淆同样支持三级强度。
- 可选使用 Babel 将箭头函数、class、可选链等 ES6+ 语法降级到 ES5。
- 在同级临时目录完成构建；失败时保留原有输出。
- 支持零写入构建预演、依赖文件清单和静默模式。
- 提供 CLI 和 Node.js API，要求 Node.js 20 或更高版本。

## 安装

全局安装：

```bash
npm install -g @mosbydev/extb
extb --help
```

安装为项目开发依赖：

```bash
npm install -D @mosbydev/extb
npx extb ./extension
```

不安装、直接执行指定包：

```bash
npx --package @mosbydev/extb extb ./extension
```

`extb` 是完整命令名，`eb` 是等价的短命令：

```bash
extb ./extension
eb ./extension
```

## 快速开始

在扩展项目目录执行：

```bash
extb .
```

默认只生成可直接加载的目录，不生成 ZIP：

```text
dist/
├─ manifest.json
└─ ...插件运行所需文件
```

需要商店上传用 ZIP 时显式启用：

```bash
extb . --zip
```

此时 ZIP 位于输出目录中，默认名称为：

```text
dist/<manifest所在目录名>-<manifest.version>.zip
```

找到多个 manifest 时必须明确指定：

```bash
extb . --manifest ./extensions/example/manifest.json
```

自定义输出目录：

```bash
extb ./extension --out-dir ./release
```

## 默认配置

不传参数执行 `extb` 时，等价于以下核心配置：

```ts
defineConfig({
  root: process.cwd(),
  outDir: '<root>/dist',

  include: [],
  transformExclude: [],

  minify: {
    level: 'safe',
    html: 'safe',
    js: 'safe',
    css: 'safe',
    exclude: [],
  },

  obfuscate: {
    level: 'none',
    exclude: [],
    reservedNames: [],
  },

  transpile: {
    target: 'modern',
    exclude: [],
  },

  zip: {
    enabled: false,
  },
});
```

工具还会默认排除版本库目录、`node_modules`、`extb.config.*`、系统临时文件、日志文件以及 extb 构建临时/备份目录。

## 查看默认配置

输出当前安装版本的完整内置默认配置：

```bash
extb --defaults
```

`eb --defaults` 完全等价。该选项以格式化 JSON 输出配置后立即退出，不加载当前项目的 `extb.config.*`，也不会查找 `manifest.json`、启动构建或写入文件，因此可以安全地在任意目录执行。路径使用可复制的相对形式：`root` 为 `.`，`outDir` 为 `./dist`。

Node.js API 使用者也可以调用 `loadConfig({ configFile: false })` 获取经过归一化的默认值；API 返回的路径是绝对路径。

## 查看最终配置

查看应用配置文件和 CLI 参数后的最终配置：

```bash
extb ./extension --show-config
```

也可以同时指定配置文件和覆盖参数，用于检查配置优先级：

```bash
extb ./extension \
  --config ./configs/release.ts \
  --show-config \
  --target es5 \
  --zip
```

输出是经过补全和归一化的 JSON，路径字段为实际使用的绝对路径。该选项会加载配置文件并应用 CLI 覆盖，但不会查找或读取 `manifest.json`，也不会执行构建或写入输出目录。配置优先级仍为“内置默认值 < 配置文件 < CLI 参数”。

## 压缩与混淆等级

需要把压缩和混淆设置为相同等级时，可以使用聚合参数：

```bash
extb ./extension --optimize aggressive
```

它等价于 `--minify aggressive --obfuscate aggressive`。裸 `--optimize` 使用 `safe`，`--no-optimize` 同时把两者设置为 `none`。聚合参数总是先应用，随后再应用具体选项，因此可以安全覆盖，并且与参数书写顺序无关：

```bash
extb ./extension --optimize aggressive --obfuscate safe --no-minify-css
```

上例最终为 HTML/JS 压缩 `aggressive`、CSS 压缩 `none`、JS 混淆 `safe`。注意 `--optimize safe` 会开启安全混淆，而项目默认配置仍然是“安全压缩、关闭混淆”。

HTML、JavaScript 和 CSS 可以统一设置，也可以分别覆盖：

```bash
extb ./extension --minify aggressive --minify-html safe --no-minify-css
```

配置采用固定的“总等级先应用，分项等级随后覆盖”规则。上面的最终结果为 HTML `safe`、JavaScript `aggressive`、CSS `none`。

| 等级 | HTML | JavaScript | CSS |
| --- | --- | --- | --- |
| `none` | 不压缩 | 不压缩 | 不压缩 |
| `safe` | 保守折叠空白、删除普通注释 | 删除普通注释和多余格式，不执行 `compress` | CleanCSS Level 1 |
| `aggressive` | 额外清理属性引号、冗余类型属性等 | 三轮 Terser `compress`，保持 `unsafe: false` | CleanCSS Level 1 + Level 2 |

裸开关的等级为 `safe`：

```bash
extb ./extension --minify
```

`--no-minify` 和各分项 `--no-minify-*` 等价于对应等级 `none`。当等级参数写在 root 前面时，推荐使用等号形式消除阅读歧义：

```bash
extb --minify=aggressive ./extension
```

JavaScript 混淆与压缩完全独立：

```bash
# 只做深度压缩，不改写标识符
extb ./extension --minify-js aggressive --no-obfuscate

# 保守压缩，但允许顶层标识符改名
extb ./extension --minify-js safe --obfuscate aggressive
```

混淆等级含义：

- `none`：不混淆，是默认值。
- `safe`：只重命名局部标识符，保留顶层、函数和类名称。
- `aggressive`：允许改写顶层变量、函数名、类名和 `Function.name`。

代码通过字符串、反射或外部接口使用某个名称时，可以重复使用 `--keep-name`：

```bash
extb ./extension --obfuscate aggressive \
  --keep-name publicApi \
  --keep-name messageHandler
```

将 ES6+ 语法转译为 ES5：

```bash
extb ./extension --target es5
```

组合使用深度压缩、混淆和 ES5 输出：

```bash
extb ./extension --minify-js aggressive --obfuscate aggressive --target es5
```

## 文件收集规则

extb 以 manifest 所在目录为源码根目录，只收集插件静态依赖。运行时拼接出来的资源路径无法可靠静态分析，应使用可重复的 `--include` 补充：

```bash
extb ./extension \
  --include "data/**" \
  --include "dynamic/page.html"
```

从扩展包中完全排除文件：

```bash
extb ./extension \
  --exclude "vendor/debug/**" \
  --exclude "**/*.map"
```

如果文件必须打包，但不应压缩、混淆或转译，请使用：

```bash
extb ./extension --no-transform "vendor/**"
```

如果 manifest 或已发现文件静态引用的资源不存在、越过源码根目录或被排除，构建会直接失败，不会生成残缺扩展包。

## CLI

执行以下命令查看包含默认值说明的完整帮助：

```bash
extb --help
```

参数摘要：

```text
Usage: extb [options] [root]

压缩并打包浏览器扩展源码目录

Arguments:
  root                   查找 manifest.json 的根目录（默认：当前目录）

通用选项：
  -v, --version          显示版本号
  --defaults             以 JSON 显示内置默认配置并退出
  --show-config          以 JSON 显示合并后的最终配置并退出
  -h, --help             显示帮助信息

输入选项：
  -c, --config <file>    指定 extb 配置文件（默认：自动发现）
  --no-config            禁用配置文件自动发现和加载（默认：启用）
  -m, --manifest <file>  指定 manifest.json 路径（默认：递归查找唯一文件）

输出选项：
  -o, --out-dir <dir>    输出目录（默认：<root>/dist）
  --zip                  生成 ZIP（默认：关闭）
  --no-zip               不生成 ZIP，用于覆盖配置文件
  --zip-name <name>      自定义并生成 ZIP（文件名必须以 .zip 结尾）

代码处理选项：
  --optimize [level]      同时设置压缩和混淆等级（省略：safe）
  --no-optimize           同时禁用压缩和混淆，等价于 --optimize=none
  --minify [level]       设置全部压缩等级：none、safe、aggressive（省略：safe）
  --no-minify            禁用全部压缩，等价于 --minify=none
  --minify-html [level]  设置 HTML 压缩等级（省略：safe）
  --no-minify-html       禁用 HTML 压缩
  --minify-js [level]    设置 JavaScript 压缩等级（省略：safe）
  --no-minify-js         禁用 JavaScript 压缩
  --minify-css [level]   设置 CSS 压缩等级（省略：safe）
  --no-minify-css        禁用 CSS 压缩
  --obfuscate [level]    设置 JS 混淆等级：none、safe、aggressive（省略：safe；默认：none）
  --no-obfuscate         禁用 JavaScript 混淆，等价于 --obfuscate=none
  --target <target>      JavaScript 输出目标：modern 或 es5（默认：modern）
  --keep-name <name>     混淆时保留标识符名称，可重复使用

资源选择选项：
  --exclude <glob>       从扩展包中完全排除文件，可重复使用（默认：无）
  --include <glob>       强制加入静态分析无法发现的资源，可重复使用（默认：无）
  --no-transform <glob>  打包文件但保持内容不变，可重复使用（默认：无）

报告选项：
  --dry-run             完整预演构建但不写入文件（默认：关闭）
  --list-files          输出最终打包文件列表（默认：关闭）
  --quiet               成功时不输出任何内容（默认：关闭）
  --json                 以 JSON 输出构建结果（默认：可读文本）

```

`root` 默认为当前目录。CLI 路径相对当前工作目录；显式 CLI 参数优先于配置文件。裸 `--optimize`、`--minify*` 和 `--obfuscate` 使用 `safe` 等级；`--target es5` 启用转译，`--target modern` 保持现代语法并覆盖配置文件中的 ES5 转译。

在 CI 中可以只输出机器可读的 `BuildResult`：

```bash
extb ./extension --json
```

需要忽略项目配置文件、完全使用默认值和 CLI 参数时：

```bash
extb ./extension --no-config
```

## 构建预演与输出控制

完整执行 manifest 解析、依赖收集、压缩、混淆和转译验证，但不创建或修改任何输出文件：

```bash
extb ./extension --dry-run
```

即使同时指定 `--zip`，dry-run 也只显示计划生成的 ZIP 路径，不会创建归档。已有输出目录不会被替换或清理。

查看最终依赖闭包中的文件列表：

```bash
extb ./extension --dry-run --list-files
```

`--list-files` 也可以用于真实构建，并且只列出进入扩展包的相对路径，不包含 ZIP 本身。
使用 `--json` 时，结果中的 `includedFiles` 始终包含同一份文件列表，无需额外指定 `--list-files`；两者同时使用会报参数冲突。

成功时不输出任何终端信息：

```bash
extb ./extension --quiet
```

quiet 不会隐藏错误，失败时仍返回非零退出码并输出错误信息。为避免含义冲突，`--quiet` 不能和 `--json`、`--list-files` 同时使用。

## CLI 与配置文件对应关系

### 构建参数

| CLI 参数 | 配置文件字段 | 行为 |
| --- | --- | --- |
| `[root]` | `root` | manifest 搜索根目录 |
| `-m, --manifest <file>` | `manifest` | 显式指定 manifest |
| `-o, --out-dir <dir>` | `outDir` | 设置输出目录 |
| `--include <glob>` | `include[]` | 强制加入静态分析无法发现的资源 |
| `--exclude <glob>` | `exclude[]` | 从扩展包中完全排除资源 |
| `--no-transform <glob>` | `transformExclude[]` | 文件仍打包，但跳过全部文本转换 |
| `--optimize [level]` | `minify.level` + `obfuscate.level` | 同时设置压缩和混淆等级，省略等级时为 `safe` |
| `--no-optimize` | 两个 `level` 均为 `'none'` | 同时关闭压缩和混淆 |
| `--minify [level]` | `minify.level` | 设置全部压缩等级，省略等级时为 `safe` |
| `--no-minify` | `minify.level: 'none'` | 关闭全部压缩 |
| `--minify-html [level]` | `minify.html` | 设置 HTML 压缩等级 |
| `--no-minify-html` | `minify.html: 'none'` | 关闭 HTML 压缩 |
| `--minify-js [level]` | `minify.js` | 设置 JavaScript 压缩等级 |
| `--no-minify-js` | `minify.js: 'none'` | 关闭 JavaScript 压缩 |
| `--minify-css [level]` | `minify.css` | 设置 CSS 压缩等级 |
| `--no-minify-css` | `minify.css: 'none'` | 关闭 CSS 压缩 |
| `--obfuscate [level]` | `obfuscate.level` | 设置混淆等级，省略等级时为 `safe` |
| `--no-obfuscate` | `obfuscate.level: 'none'` | 关闭混淆 |
| `--keep-name <name>` | `obfuscate.reservedNames[]` | 保留指定标识符，可重复使用 |
| `--target es5` | `transpile.target: 'es5'` | 启用转译并输出 ES5 语法 |
| `--target modern` | `transpile.target: 'modern'` | 不执行语法降级，保持现代语法 |
| `--zip` | `zip.enabled: true` | 生成 ZIP |
| `--no-zip` | `zip.enabled: false` | 不生成 ZIP |
| `--zip-name <name>` | `zip.fileName` | CLI 中同时启用 ZIP 并设置文件名 |
| `--dry-run` | `BuildOptions.dryRun: true` | 完整预演，但不写入输出目录或 ZIP |

### 仅属于 CLI 或加载上下文的参数

| CLI 参数 | 内部对应 | 行为 |
| --- | --- | --- |
| `-c, --config <file>` | `BuildOptions.configFile` | 指定配置文件 |
| `--no-config` | `BuildOptions.configFile: false` | 禁用配置文件加载 |
| `--json` | 无配置字段 | 只改变构建结果的终端输出格式 |
| `--list-files` | 无配置字段 | 输出最终依赖闭包中的文件列表 |
| `--quiet` | 无配置字段 | 隐藏成功输出，错误不受影响 |
| `--defaults` | 无配置字段 | 显示内置默认配置并退出，不加载项目配置或启动构建 |
| `--show-config` | 无配置字段 | 显示默认值、配置文件和 CLI 参数合并后的最终配置并退出 |
| `-v, --version` | 无配置字段 | 显示包版本 |
| `-h, --help` | 无配置字段 | 显示帮助 |

### 只能在配置文件或 Node.js API 中设置

以下字段没有独立 CLI 参数：

```ts
defineConfig({
  minify: {
    exclude: ['vendor/already-minified/**'],
  },
  obfuscate: {
    exclude: ['vendor/**'],
  },
  transpile: {
    exclude: ['modern/**'],
  },
});
```

`--no-transform` 会统一追加到以上三个转换排除列表。`--keep-name` 会追加到 `obfuscate.reservedNames`。

### 合并与路径规则

配置优先级：

```text
内置默认值 < 配置文件 < CLI 参数或 build() 参数
```

- 所有规则数组都会在不同配置层之间累加并去重，包括 `include`、`exclude`、`transformExclude` 以及三个处理器各自的 `exclude`。
- `minify.level` 先统一设置三个资源类型，再由同一层的 `html`、`js`、`css` 分项覆盖。
- `obfuscate.reservedNames` 与 `--keep-name` 会累加并去重。
- `minify.exclude`、`obfuscate.exclude`、`transpile.exclude` 分别控制对应处理器，并与 `transformExclude` 合并。
- CLI 路径相对当前工作目录；配置文件路径相对配置文件所在目录。
- 所有 glob 都相对 `manifest.json` 所在目录，并使用 POSIX `/` 分隔符。

## 配置文件

extb 会在 root 目录中自动发现唯一的以下文件：

```text
extb.config.ts  extb.config.mts  extb.config.cts
extb.config.js  extb.config.mjs  extb.config.cjs
extb.config.json
```

推荐使用 TypeScript 配置：

```ts
import { defineConfig } from '@mosbydev/extb';

export default defineConfig({
  root: './extension',
  outDir: './release',

  // 静态分析无法发现时强制包含，并继续追踪这些文件的依赖。
  include: ['data/**'],
  exclude: ['tests/**', '**/*.map'],

  // 文件仍会打包，但跳过全部文本转换。
  transformExclude: ['vendor/**'],

  minify: {
    level: 'safe',
    html: 'safe',
    js: 'aggressive',
    css: 'safe',
    exclude: ['vendor/**'],
  },

  obfuscate: {
    level: 'safe', // none、safe 或 aggressive
    exclude: ['vendor/**'],
    reservedNames: ['publicApiName'],
  },

  transpile: {
    target: 'es5',
    exclude: ['vendor/modern-only.js'],
  },

  // ZIP 默认关闭；需要时显式开启。
  zip: {
    enabled: true,
    fileName: 'extension-release.zip',
  },
});
```

配置文件内的路径相对配置文件目录。发现多个配置文件时会报错，可使用 `--config` 明确指定。

压缩和混淆只接受等级字符串；布尔值、`minify.enabled`、`obfuscate.enabled` 和 `obfuscate.mode` 不再支持。关闭时请显式使用 `level: 'none'`。转译由 `target` 单独决定，`transpile.enabled` 也不再支持：`modern` 表示不降级，`es5` 表示启用转译。

## Node.js API

```ts
import { build, defineConfig, loadConfig } from '@mosbydev/extb';

const config = defineConfig({
  root: './extension',
  outDir: './release',
  transpile: { target: 'es5' },
});

const resolved = await loadConfig({ overrides: config });
const result = await build(config);

console.log(result.outDir);
console.log(result.zipPath); // ZIP 未启用时为 undefined
console.log(result.files);
console.log(resolved.minify);
```

预演构建同样可以通过 API 使用：

```ts
const preview = await build({
  root: './extension',
  zip: true,
  dryRun: true,
});

console.log(preview.dryRun);         // true
console.log(preview.includedFiles);  // 最终包内相对路径
console.log(preview.plannedZipPath); // 计划路径，文件不会实际生成
console.log(preview.zipPath);        // undefined
```

公开 API：

```ts
build(options?: BuildOptions): Promise<BuildResult>
loadConfig(options?: LoadConfigOptions): Promise<ResolvedConfig>
defineConfig(config: ExtbConfig): ExtbConfig
```

## 兼容性说明

- `--obfuscate aggressive` 可能改写跨文件共享的全局变量、函数名、类名以及 `Function.name`。使用 `obfuscate.reservedNames` 保留公开名称，或通过 `obfuscate.exclude` 排除依赖反射、`eval` 和源码字符串的文件。
- `--minify-js aggressive` 会执行深度压缩，即使没有混淆也可能内联或删除可证明无用的声明。
- `onclick` 等 HTML 事件属性最多只做文本压缩，不执行混淆或 ES5 转译。
- `--minify-css aggressive` 启用 CleanCSS Level 2，可能合并规则和重组选择器；复杂样式应进行页面回归测试。
- 对象属性名不会被混淆，Terser 的 `unsafe` 优化保持关闭。
- ES5 转译不会自动注入 `Promise`、`Map`、`Set` 等运行时 polyfill。
- 为保持浏览器原生模块路径和加载方式，`import`/`export` 不会转成 CommonJS；模块内部的现代语法仍会降级。
- extb 不编译 TypeScript、JSX、Sass，也不执行 JavaScript bundling。

建议在启用激进混淆或 ES5 转译后，分别在目标浏览器中回归测试后台脚本、内容脚本、弹窗页面和动态资源加载。

## License

[MIT](./LICENSE)
