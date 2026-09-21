import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { build } from './build.js';
import type {
  BuildOptions,
  BuildResult,
  JavaScriptTarget,
  MinifyOptions,
  ObfuscateOptions,
  TranspileOptions,
  ZipOptions,
} from './types.js';

/** Commander 解析后的扁平参数结构；尚未转换为公开的嵌套配置结构。 */
interface CliOptions {
  config?: string;
  manifest?: string;
  outDir?: string;
  minify?: boolean;
  minifyHtml?: boolean;
  minifyJs?: boolean;
  minifyCss?: boolean;
  obfuscate?: boolean;
  aggressiveJs?: boolean;
  transpile?: boolean;
  target?: JavaScriptTarget;
  zip?: boolean;
  zipName?: string;
  exclude?: string[];
  include?: string[];
}

/**
 * CLI 的可注入依赖，只用于隔离副作用和测试。
 * 正常 bin 入口不传此参数，会使用真实 build() 和 process.stdout。
 */
export interface CliDependencies {
  build?: (options?: BuildOptions) => Promise<BuildResult>;
  write?: (text: string) => void;
  /** 帮助文本中显示的命令名；两个 bin 入口分别传入 eb 和 extb。 */
  commandName?: 'eb' | 'extb';
}

/** Commander 对重复 --exclude 的累加器。 */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** 在 Commander 参数解析阶段验证目标，避免直到构建文件时才发现拼写错误。 */
function parseJavaScriptTarget(value: string): JavaScriptTarget {
  if (value !== 'modern' && value !== 'es5') {
    throw new InvalidArgumentError("只能是 'modern' 或 'es5'");
  }
  return value;
}

/** 将字节数转换为适合终端阅读的二进制单位。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * 将 CLI 的扁平选项转换成 BuildOptions。
 *
 * 只写入用户明确提供的值非常重要：undefined 必须继续保持“未指定”，才能让配置文件
 * 或内置默认值生效。正负开关由 Commander 汇总成同一个 boolean 字段。
 */
export function createBuildOptions(root: string | undefined, options: CliOptions): BuildOptions {
  const result: BuildOptions = {};
  if (root !== undefined) result.root = root;
  if (options.config !== undefined) result.configFile = options.config;
  if (options.manifest !== undefined) result.manifest = options.manifest;
  if (options.outDir !== undefined) result.outDir = options.outDir;
  if (options.exclude !== undefined && options.exclude.length > 0) result.exclude = options.exclude;
  if (options.include !== undefined && options.include.length > 0) result.include = options.include;

  if (
    options.minify !== undefined ||
    options.minifyHtml !== undefined ||
    options.minifyJs !== undefined ||
    options.minifyCss !== undefined
  ) {
    // 分项开关组合为一个对象，随后由配置层按总开关 -> 分项覆盖的顺序归一化。
    const minify: MinifyOptions = {};
    if (options.minify !== undefined) minify.enabled = options.minify;
    if (options.minifyHtml !== undefined) minify.html = options.minifyHtml;
    if (options.minifyJs !== undefined) minify.js = options.minifyJs;
    if (options.minifyCss !== undefined) minify.css = options.minifyCss;
    result.minify = minify;
  }

  if (options.obfuscate !== undefined || options.aggressiveJs !== undefined) {
    const obfuscate: ObfuscateOptions = {};
    if (options.obfuscate !== undefined) {
      obfuscate.enabled = options.obfuscate;
      // --obfuscate 明确表示安全模式，避免配置文件中的 aggressive 模式被意外沿用。
      if (options.obfuscate) obfuscate.mode = 'safe';
    }
    if (options.aggressiveJs === true) {
      obfuscate.mode = 'aggressive';
      // --no-obfuscate 明确出现时优先，否则 aggressive-js 自身即表示启用。
      if (options.obfuscate === undefined) obfuscate.enabled = true;
    }
    result.obfuscate = obfuscate;
  }
  if (options.transpile !== undefined || options.target !== undefined) {
    const transpile: TranspileOptions = {};
    if (options.transpile !== undefined) transpile.enabled = options.transpile;
    if (options.target !== undefined) {
      transpile.target = options.target;
      // --target es5 默认开启、--target modern 默认关闭；显式 --[no-]transpile 拥有更高优先级。
      if (options.transpile === undefined) transpile.enabled = options.target === 'es5';
    }
    result.transpile = transpile;
  }
  if (options.zip !== undefined || options.zipName !== undefined) {
    const zip: ZipOptions = {};
    if (options.zip !== undefined) zip.enabled = options.zip;
    if (options.zipName !== undefined) zip.fileName = options.zipName;
    result.zip = zip;
  }
  return result;
}

/**
 * 创建并执行一次独立的 CLI 解析过程。
 *
 * 每次调用都新建 Command，避免测试或嵌入式调用之间残留上一次解析状态。argv 使用
 * Node 模式，格式与 process.argv 相同：前两项是 node 路径和脚本路径。
 */
export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<void> {
  const buildExtension = dependencies.build ?? build;
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));

  const program = new Command()
    .name(dependencies.commandName ?? 'eb')
    .description('压缩并打包浏览器扩展源码目录')
    .version('0.1.0', '-v, --version', '显示版本号')
    .helpOption('-h, --help', '显示帮助信息')
    .configureOutput({ writeOut: write })
    // 覆盖 Commander 默认的 process.exit()，让嵌入式 API 和测试都能安全调用帮助/版本参数。
    .exitOverride()
    .argument('[root]', '查找 manifest.json 的根目录，默认是当前目录')
    .option('-c, --config <file>', '指定 extb 配置文件')
    .option('-m, --manifest <file>', '指定 manifest.json 路径')
    .option('-o, --out-dir <dir>', '输出目录，默认是 <root>/dist')
    .option('--minify', '启用 HTML、JavaScript 和 CSS 压缩')
    .option('--no-minify', '禁用 HTML、JavaScript 和 CSS 压缩')
    .option('--minify-html', '启用 HTML 压缩')
    .option('--no-minify-html', '禁用 HTML 压缩')
    .option('--minify-js', '启用 JavaScript 压缩')
    .option('--no-minify-js', '禁用 JavaScript 压缩')
    .option('--minify-css', '启用 CSS 压缩')
    .option('--no-minify-css', '禁用 CSS 压缩')
    .option('--obfuscate', '启用保守的 JavaScript 局部标识符混淆')
    .option('--no-obfuscate', '禁用 JavaScript 混淆')
    .option('--aggressive-js', '启用完整 JS 压缩和顶层标识符混淆（可能需要保留名称）')
    .option('--transpile', '启用 JavaScript 语法转译，默认目标为 ES5')
    .option('--no-transpile', '禁用 JavaScript 语法转译')
    .option('--target <target>', 'JavaScript 输出目标：modern 或 es5', parseJavaScriptTarget)
    .option('--zip', '生成 ZIP')
    .option('--no-zip', '不生成 ZIP')
    .option('--zip-name <name>', '自定义 ZIP 文件名（必须以 .zip 结尾）')
    .option('--exclude <glob>', '额外排除一个 glob，可重复使用', collect, [])
    .option('--include <glob>', '补充静态分析无法发现的资源 glob，可重复使用', collect, [])
    .allowExcessArguments(false)
    .action(async (root: string | undefined, rawOptions: CliOptions) => {
      const result = await buildExtension(createBuildOptions(root, rawOptions));
      // 空扩展理论上不会出现（manifest 本身至少一个文件），仍防止除以零产生 NaN。
      const ratio = result.bytesBefore === 0 ? 0 : 1 - result.bytesAfter / result.bytesBefore;
      write(
        [
          `extb: 已输出到 ${result.outDir}`,
          `文件: ${result.files.copied} 个；HTML ${result.files.html}；JS ${result.files.js}；CSS ${result.files.css}；混淆 ${result.files.obfuscated}；转译 ${result.files.transpiled}`,
          `体积: ${formatBytes(result.bytesBefore)} -> ${formatBytes(result.bytesAfter)}（减少 ${(ratio * 100).toFixed(1)}%）`,
          ...(result.zipPath === undefined ? [] : [`ZIP: ${result.zipPath}`]),
        ].join('\n') + '\n',
      );
    });

  try {
    await program.parseAsync([...argv], { from: 'node' });
  } catch (error) {
    // --help 和 --version 已经完成输出，属于正常结束；其他参数错误继续交给 bin 入口处理。
    if (
      error instanceof CommanderError &&
      (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')
    ) {
      return;
    }
    throw error;
  }
}
