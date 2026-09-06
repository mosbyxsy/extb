import path from 'node:path';
import { transformAsync as transformWithBabel } from '@babel/core';
import presetEnv from '@babel/preset-env';
import CleanCSS from 'clean-css';
import { minify as minifyHtml } from 'html-minifier-terser';
import { minify as minifyJavaScript } from 'terser';
import { ExtBuilderError } from './errors.js';
import { matchesAny } from './paths.js';
import type { ResolvedConfig } from './types.js';

/** 用于构建摘要的处理类别；copied 表示没有经过文本转换。 */
export type ProcessedKind = 'copied' | 'html' | 'js' | 'css';

/** 文本处理器返回内容和统计元数据，不直接负责写文件。 */
export interface ProcessedText {
  content: string;
  kind: ProcessedKind;
  obfuscated: boolean;
  transpiled: boolean;
}

/** 判断当前文件是否被 minify.exclude 排除。 */
function canMinify(relativePath: string, config: ResolvedConfig): boolean {
  return !matchesAny(relativePath, config.minify.exclude);
}

/** 混淆既要求总开关开启，也要求当前相对路径没有命中排除 glob。 */
function canObfuscate(relativePath: string, config: ResolvedConfig): boolean {
  return config.obfuscate.enabled && !matchesAny(relativePath, config.obfuscate.exclude);
}

/** 转译需要开启总开关、选择 es5 目标，并且当前文件没有命中排除规则。 */
function canTranspile(relativePath: string, config: ResolvedConfig): boolean {
  return (
    config.transpile.enabled &&
    config.transpile.target === 'es5' &&
    !matchesAny(relativePath, config.transpile.exclude)
  );
}

/**
 * 使用 Babel preset-env 把现代 JavaScript 语法降级为 ES5。
 *
 * modules:false 会保留 import/export 和文件路径，避免把浏览器原生 ES module 错误改成
 * CommonJS；模块语法本身没有 ES5 等价物，但模块内部的箭头函数、class、可选链等仍会
 * 被降级。babelrc/configFile 关闭，确保用户项目中的 Babel 配置不会暗中改变打包结果。
 */
async function transpileJavaScriptToEs5(source: string): Promise<string> {
  const result = await transformWithBabel(source, {
    babelrc: false,
    configFile: false,
    comments: true,
    compact: false,
    sourceMaps: false,
    sourceType: 'unambiguous',
    presets: [
      [
        presetEnv,
        {
          bugfixes: true,
          modules: false,
          targets: { ie: '11' },
          useBuiltIns: false,
        },
      ],
    ],
  });
  if (result?.code === undefined || result.code === null) {
    throw new ExtBuilderError('Babel 未生成 JavaScript 输出。');
  }
  return result.code;
}

/**
 * 使用 Terser 对一个完整脚本或 HTML 内脚本片段进行转换。
 *
 * safe 模式刻意关闭 compress：只依赖紧凑输出移除空白和普通注释，不执行常量折叠、
 * 无用代码删除等优化。aggressive 模式会执行三轮完整压缩，并允许顶层标识符改名。
 *
 * 开启 obfuscate 时也只改局部标识符：不改属性、顶层变量、函数名和类名。这样可以保留
 * 不同扩展脚本之间通过全局名称通信的行为，并降低 Function.name 相关兼容风险。
 */
async function transformJavaScript(
  source: string,
  minify: boolean,
  obfuscate: boolean,
  aggressive: boolean,
  transpile: boolean,
  reservedNames: string[],
  inline: boolean,
) {
  if (!minify && !obfuscate && !transpile) return source;
  // 事件属性包含顶层 return，不能作为完整 Program 交给 Babel；独立脚本和 script 标签可转译。
  const input = transpile && !inline ? await transpileJavaScriptToEs5(source) : source;
  const result = await minifyJavaScript(input, {
    // aggressive 仍关闭 unsafe 系列优化，避免擅自假设内建对象或 getter 没有副作用。
    compress: aggressive ? { passes: 3, unsafe: false } : false,
    ecma: transpile ? 5 : 2020,
    mangle: obfuscate
      ? {
          eval: false,
          keep_classnames: !aggressive,
          keep_fnames: !aggressive,
          properties: false,
          reserved: reservedNames,
          toplevel: aggressive,
        }
      : false,
    keep_classnames: !aggressive,
    keep_fnames: !aggressive,
    // onclick 等事件属性允许顶层 return，Terser 需要 bare_returns 才能解析这类片段。
    parse: inline ? { bare_returns: true } : {},
    format: {
      beautify: false,
      ecma: transpile ? 5 : 2020,
      // 保留 /*! ... */ 形式的许可证或重要说明，删除普通开发注释。
      comments: /^!/,
    },
  });
  if (result.code === undefined) throw new ExtBuilderError('Terser 未生成 JavaScript 输出。');
  return result.code;
}

/**
 * 使用 clean-css 的 level 1 单属性优化。
 * 禁止 @import 内联和 URL 重写，确保所有 CSS 引用仍指向原来的相对资源路径。
 */
function transformCss(source: string): string {
  const result = new CleanCSS({
    inline: ['none'],
    level: 1,
    rebase: false,
  }).minify(source);
  if (result.errors.length > 0) throw new ExtBuilderError(`CSS 压缩失败: ${result.errors.join('; ')}`);
  return result.styles;
}

/**
 * HTML 是复合资源：除了压缩标签和空白，还可能包含 script、style 和事件属性。
 * 因此即使 HTML 本身压缩关闭，只要 JS/CSS/混淆任一项开启，仍需让 HTML 解析器处理
 * 对应的内联片段；其余会改变标签结构的激进选项全部保持关闭。
 */
async function transformHtml(source: string, relativePath: string, config: ResolvedConfig): Promise<string> {
  const minifyAllowed = canMinify(relativePath, config);
  const html = config.minify.html && minifyAllowed;
  const js = config.minify.js && minifyAllowed;
  const css = config.minify.css && minifyAllowed;
  const obfuscate = canObfuscate(relativePath, config);
  const transpile = canTranspile(relativePath, config);
  const aggressive = obfuscate && config.obfuscate.mode === 'aggressive';
  if (!html && !js && !css && !obfuscate && !transpile) return source;

  return minifyHtml(source, {
    // conservativeCollapse 会保留一个必要空格，降低内联元素文字粘连风险。
    collapseWhitespace: html,
    conservativeCollapse: true,
    continueOnParseError: false,
    keepClosingSlash: true,
    minifyCSS: css
      ? {
          inline: ['none'],
          level: 1,
          rebase: false,
        }
      : false,
    minifyJS:
      js || obfuscate || transpile
        ? async (text: string, inline: boolean) =>
            // 事件属性是上下文相关的代码片段，因此只压缩、不做局部名称混淆。
            transformJavaScript(
              text,
              js,
              obfuscate && !inline,
              aggressive && !inline,
              transpile,
              config.obfuscate.reservedNames,
              inline,
            )
        : false,
    preserveLineBreaks: false,
    preventAttributesEscaping: false,
    processConditionalComments: false,
    removeAttributeQuotes: false,
    removeComments: html,
    removeEmptyAttributes: false,
    removeOptionalTags: false,
    removeRedundantAttributes: false,
    removeScriptTypeAttributes: false,
    removeStyleLinkTypeAttributes: false,
    sortAttributes: false,
    sortClassName: false,
    useShortDoctype: false,
  });
}

/**
 * 按扩展名分派文本文件处理器。
 *
 * manifest、图片、字体、WASM 等不在这里处理，由构建层按字节复制。返回的 kind 和
 * obfuscated 只服务于构建统计，调用方不需要重新推断实际采用了哪个转换器。
 */
export async function processTextFile(
  source: string,
  relativePath: string,
  config: ResolvedConfig,
): Promise<ProcessedText> {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const minifyAllowed = canMinify(relativePath, config);
  const obfuscate = canObfuscate(relativePath, config);

  if (extension === '.html' || extension === '.htm') {
    const active = (config.minify.html || config.minify.js || config.minify.css) && minifyAllowed;
    const transpile = canTranspile(relativePath, config);
    return {
      content: await transformHtml(source, relativePath, config),
      kind: active || obfuscate || transpile ? 'html' : 'copied',
      obfuscated: obfuscate,
      transpiled: canTranspile(relativePath, config),
    };
  }

  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    const minify = config.minify.js && minifyAllowed;
    const transpile = canTranspile(relativePath, config);
    const aggressive = obfuscate && config.obfuscate.mode === 'aggressive';
    return {
      content: await transformJavaScript(
        source,
        minify,
        obfuscate,
        aggressive,
        transpile,
        config.obfuscate.reservedNames,
        false,
      ),
      kind: minify || obfuscate || transpile ? 'js' : 'copied',
      obfuscated: obfuscate,
      transpiled: transpile,
    };
  }

  if (extension === '.css') {
    const minify = config.minify.css && minifyAllowed;
    return {
      content: minify ? transformCss(source) : source,
      kind: minify ? 'css' : 'copied',
      obfuscated: false,
      transpiled: false,
    };
  }

  return { content: source, kind: 'copied', obfuscated: false, transpiled: false };
}
