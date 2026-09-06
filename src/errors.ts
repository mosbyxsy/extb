/**
 * extbuilder 的领域错误。
 *
 * 使用独立错误类型便于调用方区分“构建失败”和普通编程异常；cause 会保留底层
 * 文件系统或第三方压缩器抛出的原始错误，方便继续诊断。
 */
export class ExtBuilderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExtBuilderError';
  }
}

/** 将 JavaScript 中允许抛出的任意值安全地转换为可展示文本。 */
export function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
