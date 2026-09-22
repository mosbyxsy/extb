/** 压缩强度。none 不处理，safe 保守压缩，aggressive 允许更深入的结构优化。 */
export type CompressionLevel = 'none' | 'safe' | 'aggressive';

/** JavaScript 标识符混淆强度。none 关闭，safe 仅局部，aggressive 允许顶层改名。 */
export type ObfuscationLevel = 'none' | 'safe' | 'aggressive';

/** HTML、JavaScript、CSS 三类文本资源的压缩配置。 */
export interface MinifyOptions {
  /** 总等级。设置后先统一覆盖三个分项，随后再应用下面的分项等级。 */
  level?: CompressionLevel;
  /** HTML 文档本身的压缩等级。 */
  html?: CompressionLevel;
  /** 独立 JS 文件以及 HTML 中可执行脚本的压缩等级。 */
  js?: CompressionLevel;
  /** 独立 CSS 文件以及 HTML 中内联样式的压缩等级。 */
  css?: CompressionLevel;
  /** 不参与压缩的 POSIX 风格 glob，匹配路径相对 manifest 所在目录。 */
  exclude?: string[];
}

/** JavaScript 混淆配置。混淆默认关闭。 */
export interface ObfuscateOptions {
  /** none 关闭；safe 只改局部名称；aggressive 还允许改写顶层、函数和类名称。 */
  level?: ObfuscationLevel;
  /** 不参与混淆的相对路径 glob。 */
  exclude?: string[];
  /** 即使开启混淆也必须保留的标识符名称。 */
  reservedNames?: string[];
}

/** JavaScript 输出目标。modern 保持源码语法，es5 使用 Babel 降级现代语法。 */
export type JavaScriptTarget = 'modern' | 'es5';

/** ES6+ 到旧版 JavaScript 的转译配置。 */
export interface TranspileOptions {
  /** 输出语法目标；modern 保持源码语法，es5 启用 Babel 降级。 */
  target?: JavaScriptTarget;
  /** 不参与语法转译的相对路径 glob。 */
  exclude?: string[];
}

/** ZIP 归档配置。 */
export interface ZipOptions {
  /** 是否在可直接加载的输出目录内额外生成 ZIP。 */
  enabled?: boolean;
  /** 自定义 ZIP 文件名；只能是文件名，不能包含目录，并且必须以 .zip 结尾。 */
  fileName?: string;
}

/**
 * 用户可写入 extb.config.* 的原始配置结构。
 *
 * 此处的路径仍是用户输入形式；只有经过 loadConfig() 后才会转换成绝对路径。
 */
export interface ExtbConfig {
  /** 搜索 manifest.json 的根目录。 */
  root?: string;
  /** 显式指定 manifest.json；省略时从 root 递归查找。 */
  manifest?: string;
  /** 构建输出目录，默认是 <root>/dist。 */
  outDir?: string;
  /** 从最终扩展包中排除的相对路径 glob。 */
  exclude?: string[];
  /** 静态分析无法发现时，强制加入包并继续追踪其依赖的相对路径 glob。 */
  include?: string[];
  /** 文件仍会打包，但跳过 HTML/CSS/JS 压缩、混淆和语法转译。 */
  transformExclude?: string[];
  /** 字符串设置总等级，对象形式可分别控制三类文件。 */
  minify?: CompressionLevel | MinifyOptions;
  /** 字符串设置混淆等级，对象形式可设置排除项和保留名称。 */
  obfuscate?: ObfuscationLevel | ObfuscateOptions;
  /** JavaScript 语法转译；字符串直接设置目标，对象形式可追加排除规则。 */
  transpile?: JavaScriptTarget | TranspileOptions;
  /** 布尔值是总开关，对象形式可自定义 ZIP 名称。 */
  zip?: boolean | ZipOptions;
}

/** build() 接受的参数；这些参数拥有最高优先级。 */
export interface BuildOptions extends ExtbConfig {
  /** Base directory for programmatic path resolution. Defaults to process.cwd(). */
  cwd?: string;
  /** Explicit config path, false to disable loading, or undefined to auto-discover. */
  configFile?: string | false;
  /** 完整执行分析和文本转换，但不创建、替换输出目录或生成 ZIP。 */
  dryRun?: boolean;
}

/** loadConfig() 的加载上下文和覆盖项。 */
export interface LoadConfigOptions {
  /** CLI/编程 API 路径解析基准，默认是 process.cwd()。 */
  cwd?: string;
  /** 自动发现配置文件及 manifest 的初始根目录。 */
  root?: string;
  /** 指定配置文件；false 表示完全禁用配置文件加载。 */
  configFile?: string | false;
  /** 在配置文件之上应用的调用方覆盖值。 */
  overrides?: ExtbConfig;
}

/** 归一化后的压缩配置，所有等级和数组都已经补全。 */
export interface ResolvedMinifyOptions {
  level: CompressionLevel;
  html: CompressionLevel;
  js: CompressionLevel;
  css: CompressionLevel;
  exclude: string[];
}

/** 归一化后的混淆配置。 */
export interface ResolvedObfuscateOptions {
  level: ObfuscationLevel;
  exclude: string[];
  reservedNames: string[];
}

/** 归一化后的 JavaScript 转译配置。 */
export interface ResolvedTranspileOptions {
  target: JavaScriptTarget;
  exclude: string[];
}

/** 归一化后的 ZIP 配置。 */
export interface ResolvedZipOptions {
  enabled: boolean;
  fileName?: string;
}

/**
 * loadConfig() 的最终结果。
 * 所有路径均为绝对路径，可直接交给文件系统 API 使用。
 */
export interface ResolvedConfig {
  cwd: string;
  root: string;
  manifest?: string;
  outDir: string;
  exclude: string[];
  /** 已合并的动态资源补充规则。 */
  include: string[];
  /** 已合并的“只复制、不转换”规则。 */
  transformExclude: string[];
  minify: ResolvedMinifyOptions;
  obfuscate: ResolvedObfuscateOptions;
  transpile: ResolvedTranspileOptions;
  zip: ResolvedZipOptions;
  configFile?: string;
}

/** 构建过程中按处理方式统计的文件数量。 */
export interface BuildFileCounts {
  /** 未经文本转换、按字节或原文本复制的文件数。 */
  copied: number;
  /** 经过 HTML 流水线的文件数。 */
  html: number;
  /** 经过 JavaScript 流水线的独立文件数。 */
  js: number;
  /** 经过 CSS 流水线的独立文件数。 */
  css: number;
  /** 启用了混淆的 JS 文件或包含可执行脚本的 HTML 文件数。 */
  obfuscated: number;
  /** 经过 ES5 语法转译的独立 JS 文件或含可执行脚本的 HTML 文件数。 */
  transpiled: number;
}

/** build() 返回给 CLI 或第三方调用者的构建摘要。 */
export interface BuildResult {
  /** 是否为未写入文件系统的预演构建。 */
  dryRun: boolean;
  /** 实际使用的源 manifest 绝对路径。 */
  manifestPath: string;
  /** manifest 所在目录，也是保持相对路径的基准目录。 */
  sourceDir: string;
  /** 最终输出目录的绝对路径。 */
  outDir: string;
  /** 开启 ZIP 时的最终 ZIP 绝对路径。 */
  zipPath?: string;
  /** dry-run 且启用 ZIP 时，返回原本会生成的 ZIP 路径。 */
  plannedZipPath?: string;
  /** 最终依赖闭包中的包内相对文件路径，不包含 ZIP 本身。 */
  includedFiles: string[];
  /** 各处理类型的文件数量。 */
  files: BuildFileCounts;
  /** 所有输入文件处理前的总字节数。 */
  bytesBefore: number;
  /** 不含 ZIP 本身的输出文件总字节数。 */
  bytesAfter: number;
}
