# extb

`extb` 是面向 Chrome、Edge、Firefox 等 WebExtension 的依赖感知型打包工具。它从 `manifest.json` 出发分析插件真正依赖的文件，压缩 HTML、CSS、JavaScript，并可选执行 JavaScript 深度混淆、ES5 转译和 ZIP 归档。

## 目录

- [特性](#特性)
- [安装](#安装)
- [快速开始](#快速开始)
- [默认配置](#默认配置)
- [JavaScript 处理](#javascript-处理)
- [文件收集规则](#文件收集规则)
- [CLI](#cli)
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
- 可选使用 Terser 深度压缩并混淆顶层标识符。
- 可选使用 Babel 将箭头函数、class、可选链等 ES6+ 语法降级到 ES5。
- 在同级临时目录完成构建；失败时保留原有输出。
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
    enabled: true,
    html: true,
    js: true,
    css: true,
    exclude: [],
  },

  obfuscate: {
    enabled: false,
    mode: 'safe',
    exclude: [],
    reservedNames: [],
  },

  transpile: {
    enabled: false,
    target: 'modern',
    exclude: [],
  },

  zip: {
    enabled: false,
  },
});
```

工具还会默认排除版本库目录、`node_modules`、`extb.config.*`、系统临时文件、日志文件以及 extb 构建临时/备份目录。完整运行时默认值可以通过 `loadConfig()` 查看。

## JavaScript 处理

默认模式只移除普通注释和多余格式，不改写标识符，也不执行可能改变副作用顺序的激进优化：

```bash
extb ./extension
```

保守混淆只重命名局部标识符：

```bash
extb ./extension --obfuscate
```

深度压缩会执行多轮 Terser 优化，并混淆局部及顶层标识符：

```bash
extb ./extension --aggressive-js
```

代码通过字符串、反射或外部接口使用某个名称时，可以重复使用 `--keep-name`：

```bash
extb ./extension --aggressive-js \
  --keep-name publicApi \
  --keep-name messageHandler
```

将 ES6+ 语法转译为 ES5：

```bash
extb ./extension --target es5
```

组合使用深度压缩、混淆和 ES5 输出：

```bash
extb ./extension --aggressive-js --target es5
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
Usage: eb [options] [root]

压缩并打包浏览器扩展源码目录

Arguments:
  root                   查找 manifest.json 的根目录（默认：当前目录）

通用选项：
  -v, --version          显示版本号
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
  --minify               启用 HTML、JavaScript 和 CSS 压缩（默认：启用）
  --no-minify            禁用 HTML、JavaScript 和 CSS 压缩
  --minify-html          启用 HTML 压缩（默认：启用）
  --no-minify-html       禁用 HTML 压缩
  --minify-js            启用 JavaScript 压缩（默认：启用）
  --no-minify-js         禁用 JavaScript 压缩
  --minify-css           启用 CSS 压缩（默认：启用）
  --no-minify-css        禁用 CSS 压缩
  --obfuscate            启用保守的 JavaScript 局部标识符混淆（默认：关闭）
  --no-obfuscate         禁用 JavaScript 混淆，用于覆盖配置文件
  --aggressive-js        启用完整 JS 压缩和顶层标识符混淆（可能需要保留名称）
  --target <target>      JavaScript 输出目标：modern 或 es5（默认：modern）
  --keep-name <name>     混淆时保留标识符名称，可重复使用

资源选择选项：
  --exclude <glob>       从扩展包中完全排除文件，可重复使用（默认：无）
  --include <glob>       强制加入静态分析无法发现的资源，可重复使用（默认：无）
  --no-transform <glob>  打包文件但保持内容不变，可重复使用（默认：无）

报告选项：
  --json                 以 JSON 输出构建结果（默认：可读文本）
```

`root` 默认为当前目录。CLI 路径相对当前工作目录；显式 CLI 参数优先于配置文件。`--target es5` 启用转译，`--target modern` 保持现代语法并覆盖配置文件中的 ES5 转译。

在 CI 中可以只输出机器可读的 `BuildResult`：

```bash
extb ./extension --json
```

需要忽略项目配置文件、完全使用默认值和 CLI 参数时：

```bash
extb ./extension --no-config
```

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
| `--minify` | `minify.enabled: true` | 开启全部压缩 |
| `--no-minify` | `minify.enabled: false` | 关闭全部压缩 |
| `--minify-html` | `minify.html: true` | 开启 HTML 压缩 |
| `--no-minify-html` | `minify.html: false` | 关闭 HTML 压缩 |
| `--minify-js` | `minify.js: true` | 开启 JavaScript 压缩 |
| `--no-minify-js` | `minify.js: false` | 关闭 JavaScript 压缩 |
| `--minify-css` | `minify.css: true` | 开启 CSS 压缩 |
| `--no-minify-css` | `minify.css: false` | 关闭 CSS 压缩 |
| `--obfuscate` | `obfuscate.enabled: true`、`mode: 'safe'` | 开启保守混淆 |
| `--no-obfuscate` | `obfuscate.enabled: false` | 关闭混淆 |
| `--aggressive-js` | `obfuscate.enabled: true`、`mode: 'aggressive'` | 深度压缩和顶层混淆 |
| `--keep-name <name>` | `obfuscate.reservedNames[]` | 保留指定标识符，可重复使用 |
| `--target es5` | `transpile.enabled: true`、`target: 'es5'` | 转译到 ES5 |
| `--target modern` | `transpile.enabled: false`、`target: 'modern'` | 保持现代语法 |
| `--zip` | `zip.enabled: true` | 生成 ZIP |
| `--no-zip` | `zip.enabled: false` | 不生成 ZIP |
| `--zip-name <name>` | `zip.fileName` | CLI 中同时启用 ZIP 并设置文件名 |

### 仅属于 CLI 或加载上下文的参数

| CLI 参数 | 内部对应 | 行为 |
| --- | --- | --- |
| `-c, --config <file>` | `BuildOptions.configFile` | 指定配置文件 |
| `--no-config` | `BuildOptions.configFile: false` | 禁用配置文件加载 |
| `--json` | 无配置字段 | 只改变构建结果的终端输出格式 |
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

- `include`、`exclude`、`transformExclude` 会在不同配置层之间累加。
- `obfuscate.reservedNames` 与 `--keep-name` 会累加并去重。
- `minify.exclude`、`obfuscate.exclude`、`transpile.exclude` 分别控制对应处理器。
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
    enabled: true,
    html: true,
    js: true,
    css: true,
    exclude: ['vendor/**'],
  },

  obfuscate: {
    enabled: true,
    mode: 'safe', // 可改为 aggressive
    exclude: ['vendor/**'],
    reservedNames: ['publicApiName'],
  },

  transpile: {
    enabled: true,
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

## Node.js API

```ts
import { build, defineConfig, loadConfig } from '@mosbydev/extb';

const config = defineConfig({
  root: './extension',
  outDir: './release',
  transpile: { enabled: true, target: 'es5' },
});

const resolved = await loadConfig({ overrides: config });
const result = await build(config);

console.log(result.outDir);
console.log(result.zipPath); // ZIP 未启用时为 undefined
console.log(result.files);
console.log(resolved.minify);
```

公开 API：

```ts
build(options?: BuildOptions): Promise<BuildResult>
loadConfig(options?: LoadConfigOptions): Promise<ResolvedConfig>
defineConfig(config: ExtbConfig): ExtbConfig
```

## 兼容性说明

- `--aggressive-js` 可能改写跨文件共享的全局变量、函数名、类名以及 `Function.name`。使用 `obfuscate.reservedNames` 保留公开名称，或通过 `obfuscate.exclude` 排除依赖反射、`eval` 和源码字符串的文件。
- 对象属性名不会被混淆，Terser 的 `unsafe` 优化保持关闭。
- ES5 转译不会自动注入 `Promise`、`Map`、`Set` 等运行时 polyfill。
- 为保持浏览器原生模块路径和加载方式，`import`/`export` 不会转成 CommonJS；模块内部的现代语法仍会降级。
- extb 不编译 TypeScript、JSX、Sass，也不执行 JavaScript bundling。

建议在启用激进混淆或 ES5 转译后，分别在目标浏览器中回归测试后台脚本、内容脚本、弹窗页面和动态资源加载。

## License

[MIT](./LICENSE)
