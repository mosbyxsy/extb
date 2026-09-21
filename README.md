# extb

`extb` 是面向 Chrome、Edge、Firefox 等 WebExtension 的依赖感知型打包工具。它从 `manifest.json` 出发分析插件真正依赖的文件，压缩 HTML/CSS/JavaScript，并可选执行 JavaScript 深度混淆和 ES5 转译，最后输出可直接加载的目录与商店上传用 ZIP。

## 特性

- 递归发现唯一的 `manifest.json`，也可通过命令显式指定。
- manifest 扫描自动忽略默认或自定义输出目录，以及残留的构建临时/备份目录。
- 只打包 manifest 入口及其递归依赖，不会复制 `.git`、`.idea`、源码备注等无关文件。
- 追踪 HTML 资源、CSS `url()`/`@import`、ES modules、Worker、`importScripts()`、`runtime.getURL()`、DNR 规则和 Web Accessible Resources。
- 默认安全压缩 HTML、CSS 和 JavaScript，不改变文件名、目录结构及资源 URL。
- 可选使用 Terser 深度压缩并混淆顶层标识符。
- 可选使用 Babel 将箭头函数、class、可选链等 ES6+ 语法降级到 ES5。
- 在临时目录中完成构建；失败时保留原有输出。
- 同时提供 CLI 与 Node.js API，要求 Node.js 20 或更高版本。

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

默认生成：

```text
dist/
├─ manifest.json
├─ ...插件运行所需文件
└─ <源码目录名>-<manifest.version>.zip
```

找到多个 manifest 时必须明确指定：

```bash
extb . --manifest ./extensions/example/manifest.json
```

自定义输出目录并关闭 ZIP：

```bash
extb ./extension --out-dir ./release --no-zip
```

## JavaScript 处理

默认模式只移除注释和多余格式，不改写顶层名称，也不执行可能改变副作用顺序的激进优化：

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

额外排除文件：

```bash
extb ./extension \
  --exclude "vendor/debug/**" \
  --exclude "**/*.map"
```

如果 manifest 或已发现文件静态引用的资源不存在、越过源码根目录或被排除，构建会直接失败，不会生成残缺扩展包。

## CLI

```text
extb [root]
  -c, --config <file>
  -m, --manifest <file>
  -o, --out-dir <dir>
  --[no-]minify
  --[no-]minify-html
  --[no-]minify-js
  --[no-]minify-css
  --[no-]obfuscate
  --aggressive-js
  --[no-]transpile
  --target <modern|es5>
  --[no-]zip
  --zip-name <name>
  --exclude <glob>
  --include <glob>
  -v, --version
  -h, --help
```

`root` 默认为当前目录。CLI 中的路径相对当前工作目录；显式 CLI 参数优先于配置文件。

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

  zip: {
    enabled: true,
    fileName: 'extension-release.zip',
  },
});
```

配置文件内的路径相对配置文件目录。发现多个配置文件时会报错，可通过 `--config` 明确指定。

配置优先级：

```text
内置默认值 < 配置文件 < CLI 参数或 build() 参数
```

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
console.log(result.zipPath);
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
