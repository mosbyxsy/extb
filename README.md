# extbuilder

`extbuilder` 是一个面向 Chrome、Edge、Firefox 等 WebExtension 源码目录的安全打包工具。它从 `manifest.json` 建立依赖图，只打包插件实际引用或显式包含的文件，保持文件名和相对路径不变，默认保守压缩 HTML、JavaScript、CSS，并同时生成可直接加载的目录和商店上传用 ZIP。

## 安装

全局安装：

```bash
npm install -g extbuilder
eb ./extension
# 等价的长命令：extbuilder ./extension
```

作为开发依赖：

```bash
npm install --save-dev extbuilder
npx eb ./extension
```

也可以添加 npm script：

```json
{
  "scripts": {
    "build:extension": "eb ./extension"
  }
}
```

## 默认行为

- 从给定根目录（默认当前目录）递归查找唯一的 `manifest.json`。
- 以 manifest 所在目录为扩展源码根目录，只复制 manifest 入口及其递归依赖。
- 自动追踪 HTML 本地链接、CSS `url()`/`@import`、JavaScript 模块、Worker、`runtime.getURL()`、DNR 规则和 Web Accessible Resources。
- `_locales` 本地化资源自动包含；无法静态识别的动态路径可通过 `include` 补充。
- 默认压缩 `.html`、`.htm`、`.js`、`.mjs`、`.cjs` 和 `.css`；其他资源原样复制。
- 默认输出到 `<root>/dist`，并生成 `dist/<源码目录名>-<版本>.zip`。
- 默认不混淆 JavaScript。使用 `--obfuscate` 显式启用保守的局部变量改名。
- 默认不改变 JavaScript 语法级别；使用 `--target es5` 可将 ES6+ 语法转译为 ES5。
- 使用 `--aggressive-js` 可启用多轮完整压缩及顶层标识符混淆。
- 不进行 bundling、文件名哈希、CSS URL rebasing 或 `@import` 内联。

## CLI

```text
eb [root]
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

`eb` 是短命令，`extbuilder` 是功能完全相同的长命令别名：

```bash
eb --help
extbuilder --help
eb -v
extbuilder --version
```

找到多个 manifest 时必须明确指定：

```bash
eb . --manifest ./extensions/example/manifest.json
```

分项关闭压缩或排除文件：

```bash
eb ./extension --no-minify-html --exclude "vendor/**" --exclude "**/*.map"
```

运行时拼接的资源路径无法通过静态分析确定，可以显式加入：

```bash
eb ./extension --include "data/**" --include "dynamic/page.html"
```

将箭头函数、class、可选链、空值合并等现代语法降级到 ES5：

```bash
eb ./extension --target es5
```

启用深度压缩和顶层名称混淆，并同时输出 ES5：

```bash
eb ./extension --aggressive-js --target es5
```

CLI 路径相对当前工作目录。CLI 显式参数优先于配置文件。

## 配置文件

工具会在 root 目录中查找唯一的以下配置文件：

```text
extbuilder.config.ts  extbuilder.config.mts  extbuilder.config.cts
extbuilder.config.js  extbuilder.config.mjs  extbuilder.config.cjs
extbuilder.config.json
```

TypeScript/JavaScript 示例：

```ts
import { defineConfig } from 'extbuilder';

export default defineConfig({
  root: './extension',
  outDir: './release',
  exclude: ['tests/**', '**/*.map'],
  include: ['data/**'],
  minify: {
    enabled: true,
    html: true,
    js: true,
    css: true,
    exclude: ['vendor/**'],
  },
  obfuscate: {
    enabled: false,
    mode: 'safe', // 可设为 aggressive
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

配置文件中的路径相对配置文件目录。多个自动发现的配置文件会被视为错误，可用 `--config` 指定其中一个。

## Node.js API

```ts
import { build, loadConfig, defineConfig } from 'extbuilder';

const config = defineConfig({
  root: './extension',
  obfuscate: false,
});

const resolved = await loadConfig({ overrides: config });
const result = await build(config);
console.log(result.outDir, result.zipPath, resolved.minify);
```

公开 API：

```ts
build(options?: BuildOptions): Promise<BuildResult>
loadConfig(options?: LoadConfigOptions): Promise<ResolvedConfig>
defineConfig(config: ExtBuilderConfig): ExtBuilderConfig
```

## 功能安全说明

默认 JS 压缩只移除注释和多余格式，不合并模块，也不改名。启用 `--obfuscate` 后只重命名局部标识符，并保留顶层、属性、函数和类名称。

`--aggressive-js` 会执行三轮 Terser 压缩、删除不可达代码并混淆顶层变量、函数和类名称。它仍不会混淆对象属性，也不会启用 Terser 的 `unsafe` 优化。跨文件依赖全局名称、源码字符串、反射、`eval` 或 `Function.name` 的代码，应通过 `obfuscate.reservedNames` 保留名称，或使用 `obfuscate.exclude` 排除，并进行浏览器回归测试。

`--target es5` 使用 Babel preset-env 转换箭头函数、class、展开语法、默认参数、可选链等 ES6+ 语法。为保持浏览器扩展的原生模块路径和加载方式，`import`/`export` 不会被转换为 CommonJS；ES5 转译只提供语法兼容，不自动注入 Promise、Map 等运行时 polyfill。

依赖收集只能识别静态字符串。对于模板字符串插值、运行时拼接路径、从服务器响应中取得的资源名等场景，应使用 `include`；如果静态引用的文件不存在或被 `exclude` 排除，构建会直接失败而不是产生残缺包。

输出采用临时目录构建并在成功后替换，因此压缩、写入或 ZIP 失败不会破坏已有产物。
