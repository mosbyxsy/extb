#!/usr/bin/env node
import { runCli } from './cli-runner.js';
import { asErrorMessage } from './errors.js';

// 长命令入口与 eb 使用完全相同的参数和构建逻辑，只改变帮助文本中的命令名称。
runCli(process.argv, { commandName: 'extb' }).catch((error: unknown) => {
  process.stderr.write(`extb: ${asErrorMessage(error)}\n`);
  process.exitCode = 1;
});
