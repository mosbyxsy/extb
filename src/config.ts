import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createJiti } from 'jiti';
import { ExtbError, asErrorMessage } from './errors.js';
import type {
  CompressionLevel,
  ExtbConfig,
  JavaScriptTarget,
  LoadConfigOptions,
  MinifyOptions,
  ObfuscationLevel,
  ObfuscateOptions,
  ResolvedConfig,
  ResolvedMinifyOptions,
  ResolvedObfuscateOptions,
  ResolvedTranspileOptions,
  ResolvedZipOptions,
  TranspileOptions,
  ZipOptions,
} from './types.js';

/** 自动发现时允许的配置文件名。禁止同时存在多个候选，避免隐式优先级造成误构建。 */
export const CONFIG_FILE_NAMES = [
  'extb.config.ts',
  '**/extb.config.ts',
  'extb.config.mts',
  '**/extb.config.mts',
  'extb.config.cts',
  '**/extb.config.cts',
  'extb.config.js',
  '**/extb.config.js',
  'extb.config.mjs',
  '**/extb.config.mjs',
  'extb.config.cjs',
  '**/extb.config.cjs',
  'extb.config.json',
  '**/extb.config.json',
] as const;

/**
 * 无论用户是否配置都会应用的安全排除规则。
 *
 * 除了依赖和版本库目录，还排除配置文件、系统垃圾文件以及上次进程异常退出后
 * 可能遗留的临时/备份目录，避免将开发环境内容递归打入扩展包。
 */
export const DEFAULT_EXCLUDES = [
  '.git',
  '.git/**',
  '.hg',
  '.hg/**',
  '.svn',
  '.svn/**',
  'node_modules',
  'node_modules/**',
  'extb.config.ts',
  'extb.config.mts',
  'extb.config.cts',
  'extb.config.js',
  'extb.config.mjs',
  'extb.config.cjs',
  'extb.config.json',
  '.DS_Store',
  '**/.DS_Store',
  'Thumbs.db',
  '**/Thumbs.db',
  '*.log',
  '**/*.log',
  // 构建被强制中断时可能留下同级临时/备份目录，后续 manifest 扫描也必须忽略它们。
  '.*.extb-tmp-*',
  '.*.extb-tmp-*/**',
  '.*.extb-backup-*',
  '.*.extb-backup-*/**',
] as const;

/**
 * 纯类型辅助函数。运行时原样返回对象，使 TS 配置文件获得自动补全和类型检查，
 * 不在此阶段解析路径或写入任何默认值。
 */
export function defineConfig(config: ExtbConfig): ExtbConfig {
  return config;
}

/**
 * 配置文件属于不可信输入，必须排除数组、类实例等带有特殊原型的对象。
 * 允许 null 原型对象，以兼容 Object.create(null) 生成的普通键值配置。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** 只判断路径是否可访问；把“不存在”和“当前用户不可访问”统一视为 false。 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 只在指定 root 的当前层查找配置，不向父目录爬升。
 * 这种边界可以防止全局安装的 eb 意外读取其他项目或用户目录中的同名配置。
 */
async function discoverConfig(root: string): Promise<string | undefined> {
  let names: Set<string>;
  try {
    names = new Set(await readdir(root));
  } catch (error) {
    throw new ExtbError(`无法读取根目录 ${root}: ${asErrorMessage(error)}`, { cause: error });
  }

  const candidates = CONFIG_FILE_NAMES.filter((name) => names.has(name)).map((name) => path.join(root, name));
  if (candidates.length > 1) {
    throw new ExtbError(
      `发现多个 extb 配置文件，请使用 --config 明确指定：\n${candidates.map((file) => `  - ${file}`).join('\n')}`,
    );
  }
  return candidates[0];
}

/**
 * 加载 JSON 或可执行的 TS/JS 配置。
 * JSON 使用原生解析器；其余格式通过 jiti 兼容 ESM、CJS 和 TypeScript 默认导出。
 */
async function readConfigFile(filePath: string): Promise<ExtbConfig> {
  let value: unknown;
  try {
    if (path.extname(filePath).toLowerCase() === '.json') {
      value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    } else {
      const jiti = createJiti(import.meta.url, { moduleCache: false });
      value = await jiti.import(filePath, { default: true });
    }
  } catch (error) {
    throw new ExtbError(`加载配置文件 ${filePath} 失败: ${asErrorMessage(error)}`, { cause: error });
  }

  if (!isPlainObject(value)) {
    throw new ExtbError(`配置文件 ${filePath} 必须导出一个对象。`);
  }
  return value as ExtbConfig;
}

/** 将相对路径按明确的基准目录转换为绝对路径。 */
function resolvePath(value: string, baseDir: string): string {
  return path.resolve(baseDir, value);
}

/**
 * 只解析配置中的路径字段，其他字段保持不变。
 * 配置文件字段以配置文件目录为基准，CLI/编程参数则会以 cwd 为基准调用本函数。
 */
function resolveConfigPaths(config: ExtbConfig, baseDir: string): ExtbConfig {
  const resolved: ExtbConfig = { ...config };
  if (config.root !== undefined) resolved.root = resolvePath(config.root, baseDir);
  if (config.manifest !== undefined) resolved.manifest = resolvePath(config.manifest, baseDir);
  if (config.outDir !== undefined) resolved.outDir = resolvePath(config.outDir, baseDir);
  return resolved;
}

/** 在归一化边界验证字符串数组，尽早给出包含字段名的可读错误。 */
function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ExtbError(`${label} 必须是字符串数组。`);
  }
  return [...value];
}

/** 验证压缩等级；配置文件是运行时输入，不能只依赖 TypeScript 类型。 */
function compressionLevel(value: unknown, label: string): CompressionLevel {
  if (value !== 'none' && value !== 'safe' && value !== 'aggressive') {
    throw new ExtbError(`${label} 只能是 'none'、'safe' 或 'aggressive'。`);
  }
  return value;
}

/** 混淆使用相同的三级强度，但保留独立类型以表达不同业务含义。 */
function obfuscationLevel(value: unknown, label: string): ObfuscationLevel {
  if (value !== 'none' && value !== 'safe' && value !== 'aggressive') {
    throw new ExtbError(`${label} 只能是 'none'、'safe' 或 'aggressive'。`);
  }
  return value;
}

/**
 * 把一层 minify 配置应用到已有状态。
 *
 * 字符串或 level 会先统一设置 HTML/JS/CSS，随后同一对象内的分项等级覆盖总等级。
 * 因此 `{ level: 'none', js: 'aggressive' }` 可以表达“只深度压缩 JavaScript”。
 */
function applyMinify(
  current: ResolvedMinifyOptions,
  input: CompressionLevel | MinifyOptions | undefined,
): ResolvedMinifyOptions {
  if (input === undefined) return current;
  if (typeof input === 'string') {
    const level = compressionLevel(input, 'minify');
    return { ...current, level, html: level, js: level, css: level };
  }
  if (!isPlainObject(input)) throw new ExtbError('minify 必须是压缩等级或对象。');
  if ('enabled' in input) {
    throw new ExtbError("minify.enabled 已移除，请使用 minify.level: 'none' | 'safe' | 'aggressive'。");
  }

  let level = current.level;
  let html = current.html;
  let js = current.js;
  let css = current.css;
  if (input.level !== undefined) {
    level = compressionLevel(input.level, 'minify.level');
    html = js = css = level;
  }
  if (input.html !== undefined) html = compressionLevel(input.html, 'minify.html');
  if (input.js !== undefined) js = compressionLevel(input.js, 'minify.js');
  if (input.css !== undefined) css = compressionLevel(input.css, 'minify.css');
  return {
    level,
    html,
    js,
    css,
    exclude: input.exclude === undefined ? current.exclude : stringArray(input.exclude, 'minify.exclude'),
  };
}

/** 应用混淆配置；数组采用高优先级层替换，而不是与低优先级层隐式合并。 */
function applyObfuscate(
  current: ResolvedObfuscateOptions,
  input: ObfuscationLevel | ObfuscateOptions | undefined,
): ResolvedObfuscateOptions {
  if (input === undefined) return current;
  if (typeof input === 'string') return { ...current, level: obfuscationLevel(input, 'obfuscate') };
  if (!isPlainObject(input)) throw new ExtbError('obfuscate 必须是混淆等级或对象。');
  if ('enabled' in input || 'mode' in input) {
    throw new ExtbError("obfuscate.enabled/mode 已移除，请使用 obfuscate.level: 'none' | 'safe' | 'aggressive'。");
  }
  return {
    level: input.level === undefined ? current.level : obfuscationLevel(input.level, 'obfuscate.level'),
    exclude: input.exclude === undefined ? current.exclude : stringArray(input.exclude, 'obfuscate.exclude'),
    reservedNames:
      input.reservedNames === undefined
        ? current.reservedNames
        : [
            ...new Set([
              ...current.reservedNames,
              ...stringArray(input.reservedNames, 'obfuscate.reservedNames'),
            ]),
          ],
  };
}

/** 应用 JavaScript 转译配置；target 是唯一状态源，es5 启用降级，modern 保持源码语法。 */
function applyTranspile(
  current: ResolvedTranspileOptions,
  input: JavaScriptTarget | TranspileOptions | undefined,
): ResolvedTranspileOptions {
  if (input === undefined) return current;
  if (typeof input === 'string') {
    if (input !== 'modern' && input !== 'es5') {
      throw new ExtbError("transpile 只能是 'modern'、'es5' 或对象。");
    }
    return { ...current, target: input };
  }
  if (!isPlainObject(input)) throw new ExtbError("transpile 必须是 'modern'、'es5' 或对象。");
  if ('enabled' in input) {
    throw new ExtbError("transpile.enabled 已移除，请使用 transpile.target: 'modern' | 'es5'。");
  }
  if (input.target !== undefined && input.target !== 'modern' && input.target !== 'es5') {
    throw new ExtbError("transpile.target 只能是 'modern' 或 'es5'。");
  }
  return {
    target: input.target ?? current.target,
    exclude: input.exclude === undefined ? current.exclude : stringArray(input.exclude, 'transpile.exclude'),
  };
}

/** 应用 ZIP 配置并验证自定义名称是非空字符串；更严格的路径验证在构建阶段完成。 */
function applyZip(current: ResolvedZipOptions, input: boolean | ZipOptions | undefined): ResolvedZipOptions {
  if (input === undefined) return current;
  if (typeof input === 'boolean') return { ...current, enabled: input };
  if (!isPlainObject(input)) throw new ExtbError('zip 必须是布尔值或对象。');
  const next: ResolvedZipOptions = {
    ...current,
    enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
  };
  if (input.fileName !== undefined) {
    if (typeof input.fileName !== 'string' || input.fileName.trim() === '') {
      throw new ExtbError('zip.fileName 必须是非空字符串。');
    }
    next.fileName = input.fileName;
  }
  return next;
}

/**
 * 按“内置默认值 < 配置文件 < 调用参数”合并所有配置层。
 *
 * 顶层 exclude 是累加语义，因为调用方通常希望在项目排除规则上临时再排除文件；
 * minify/obfuscate/zip 则逐层应用，让更高层只覆盖其显式提供的字段。
 */
function mergeConfig(
  cwd: string,
  discoveryRoot: string,
  fileConfig: ExtbConfig,
  overrides: ExtbConfig,
  configFile?: string,
): ResolvedConfig {
  const root = overrides.root ?? fileConfig.root ?? discoveryRoot;
  const manifest = overrides.manifest ?? fileConfig.manifest;
  const outDir = overrides.outDir ?? fileConfig.outDir ?? path.join(root, 'dist');
  const exclude = [
    ...DEFAULT_EXCLUDES,
    ...stringArray(fileConfig.exclude, 'exclude'),
    ...stringArray(overrides.exclude, 'exclude'),
  ];
  // include 与 exclude 都采用累加语义；exclude 在文件清单阶段先执行，因此冲突时排除优先。
  const include = [
    ...stringArray(fileConfig.include, 'include'),
    ...stringArray(overrides.include, 'include'),
  ];
  // transformExclude 与顶层 include/exclude 一样采用累加语义，适合 CLI 临时追加 vendor 文件。
  const transformExclude = [
    ...stringArray(fileConfig.transformExclude, 'transformExclude'),
    ...stringArray(overrides.transformExclude, 'transformExclude'),
  ];

  // 压缩默认使用安全等级。每应用一层，都保留该层没有声明的旧值。
  let minify: ResolvedMinifyOptions = { level: 'safe', html: 'safe', js: 'safe', css: 'safe', exclude: [] };
  minify = applyMinify(minify, fileConfig.minify);
  minify = applyMinify(minify, overrides.minify);

  // 混淆默认关闭，以免依赖反射、eval 或函数名称的第三方代码发生行为变化。
  let obfuscate: ResolvedObfuscateOptions = { level: 'none', exclude: [], reservedNames: [] };
  obfuscate = applyObfuscate(obfuscate, fileConfig.obfuscate);
  obfuscate = applyObfuscate(obfuscate, overrides.obfuscate);

  // modern 是不降级的默认目标；只有最终目标为 es5 时处理器才调用 Babel。
  let transpile: ResolvedTranspileOptions = { target: 'modern', exclude: [] };
  transpile = applyTranspile(transpile, fileConfig.transpile);
  transpile = applyTranspile(transpile, overrides.transpile);

  // 通用转换排除规则最终注入三个处理器；资源仍进入包，只是保持原始文本内容。
  minify.exclude = [...new Set([...minify.exclude, ...transformExclude])];
  obfuscate.exclude = [...new Set([...obfuscate.exclude, ...transformExclude])];
  transpile.exclude = [...new Set([...transpile.exclude, ...transformExclude])];

  // ZIP 默认关闭；普通构建只输出可直接加载的目录，需要归档时再显式启用。
  let zip: ResolvedZipOptions = { enabled: false };
  zip = applyZip(zip, fileConfig.zip);
  zip = applyZip(zip, overrides.zip);

  const resolved: ResolvedConfig = {
    cwd,
    root,
    outDir,
    exclude,
    include,
    transformExclude,
    minify,
    obfuscate,
    transpile,
    zip,
  };
  if (manifest !== undefined) resolved.manifest = manifest;
  if (configFile !== undefined) resolved.configFile = configFile;
  return resolved;
}

/**
 * 发现、加载并归一化 extb 配置。
 *
 * 路径解析顺序非常重要：先确定调用方 cwd 和用于发现配置的 root；配置文件加载后，
 * 其路径相对配置文件目录解析；最后把调用方覆盖值相对 cwd 解析并合并。
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const discoveryRoot = path.resolve(cwd, options.root ?? options.overrides?.root ?? '.');

  let configFile: string | undefined;
  // false 是显式禁用；字符串是显式文件；undefined 才执行自动发现。
  if (options.configFile !== false) {
    configFile =
      typeof options.configFile === 'string'
        ? path.resolve(cwd, options.configFile)
        : await discoverConfig(discoveryRoot);
  }

  let fileConfig: ExtbConfig = {};
  if (configFile !== undefined) {
    if (!(await pathExists(configFile))) throw new ExtbError(`配置文件不存在: ${configFile}`);
    fileConfig = resolveConfigPaths(await readConfigFile(configFile), path.dirname(configFile));
  }

  // options.root 既参与配置发现，也作为最高优先级的最终 root。
  const overrides = resolveConfigPaths(options.overrides ?? {}, cwd);
  if (options.root !== undefined) overrides.root = path.resolve(cwd, options.root);
  return mergeConfig(cwd, discoveryRoot, fileConfig, overrides, configFile);
}
