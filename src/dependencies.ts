import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { Parser } from 'htmlparser2';
import { minimatch } from 'minimatch';
import { ExtbError, asErrorMessage } from './errors.js';
import type { SourceFile } from './paths.js';

interface DependencyReference {
  value: string;
  from: string;
  reason: string;
  rootRelative?: boolean;
  moduleSpecifier?: boolean;
  glob?: boolean;
  htmlBase?: string;
}

interface DependencyCollectionOptions {
  manifest: Record<string, unknown>;
  manifestPath: string;
  inventory: readonly SourceFile[];
  include: readonly string[];
}

const EXTENSION_ORIGIN = 'https://extb.invalid';
const HTML_REFERENCE_ATTRIBUTES = new Set(['src', 'href', 'poster', 'data', 'action', 'formaction']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(deepStrings);
  if (isObject(value)) return Object.values(value).flatMap(deepStrings);
  return [];
}

function memberName(node: acorn.AnyNode): string | undefined {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MetaProperty') return `${node.meta.name}.${node.property.name}`;
  if (node.type !== 'MemberExpression' || node.optional) return undefined;
  const object = memberName(node.object);
  if (object === undefined) return undefined;
  if (!node.computed && node.property.type === 'Identifier') return `${object}.${node.property.name}`;
  const property = literalString(node.property);
  return property === undefined ? undefined : `${object}.${property}`;
}

function literalString(node: acorn.AnyNode | null | undefined): string | undefined {
  if (node === null || node === undefined) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }
  return undefined;
}

function objectPropertyValues(node: acorn.AnyNode | undefined, names: ReadonlySet<string>): string[] {
  if (node?.type !== 'ObjectExpression') return [];
  const values: string[] = [];
  for (const property of node.properties) {
    if (property.type !== 'Property' || property.kind !== 'init') continue;
    const key = property.computed ? literalString(property.key) : property.key.type === 'Identifier' ? property.key.name : literalString(property.key);
    if (key === undefined || !names.has(key)) continue;
    const single = literalString(property.value);
    if (single !== undefined) values.push(single);
    if (property.value.type === 'ArrayExpression') {
      for (const element of property.value.elements) {
        const item = literalString(element);
        if (item !== undefined) values.push(item);
      }
    }
  }
  return values;
}

function parseJavaScript(source: string, relativePath: string): acorn.Node {
  const options: acorn.Options = { ecmaVersion: 'latest', allowHashBang: true };
  try {
    return acorn.parse(source, { ...options, sourceType: 'module' });
  } catch (moduleError) {
    try {
      return acorn.parse(source, { ...options, sourceType: 'script' });
    } catch (scriptError) {
      throw new ExtbError(`分析 JavaScript 依赖失败 ${relativePath}: ${asErrorMessage(scriptError)}`, {
        cause: moduleError,
      });
    }
  }
}

function collectJavaScriptReferences(source: string, relativePath: string): DependencyReference[] {
  const ast = parseJavaScript(source, relativePath);
  const references: DependencyReference[] = [];
  const add = (value: string | undefined, reason: string, rootRelative = false, moduleSpecifier = false) => {
    if (value !== undefined) references.push({ value, from: relativePath, reason, rootRelative, moduleSpecifier });
  };

  walk.simple(ast, {
    ImportDeclaration(node) {
      add(literalString(node.source), 'JavaScript import', false, true);
    },
    ExportNamedDeclaration(node) {
      add(literalString(node.source), 'JavaScript export', false, true);
    },
    ExportAllDeclaration(node) {
      add(literalString(node.source), 'JavaScript export', false, true);
    },
    ImportExpression(node) {
      add(literalString(node.source), 'JavaScript dynamic import', false, true);
    },
    CallExpression(node) {
      const callee = memberName(node.callee);
      const first = node.arguments[0];
      const firstString = first?.type === 'SpreadElement' ? undefined : literalString(first);
      if (callee === 'fetch' || callee?.endsWith('.fetch')) add(firstString, 'fetch() 本地资源');
      if (callee === 'importScripts' || callee?.endsWith('.importScripts')) add(firstString, 'importScripts()');
      if (callee?.endsWith('.runtime.getURL')) add(firstString, 'runtime.getURL()', true);

      const rootObjectKeys = new Map<string, ReadonlySet<string>>([
        ['scripting.executeScript', new Set(['files'])],
        ['scripting.insertCSS', new Set(['files'])],
        ['tabs.executeScript', new Set(['file'])],
        ['tabs.insertCSS', new Set(['file'])],
        ['offscreen.createDocument', new Set(['url'])],
        ['sidePanel.setOptions', new Set(['path'])],
        ['action.setPopup', new Set(['popup'])],
        ['browserAction.setPopup', new Set(['popup'])],
        ['pageAction.setPopup', new Set(['popup'])],
      ]);
      for (const [suffix, keys] of rootObjectKeys) {
        if (callee === suffix || callee?.endsWith(`.${suffix}`)) {
          const argument = first?.type === 'SpreadElement' ? undefined : first;
          for (const value of objectPropertyValues(argument, keys)) add(value, `${suffix}()`, true);
        }
      }
    },
    NewExpression(node) {
      const callee = memberName(node.callee);
      const first = node.arguments[0];
      if (callee === 'Worker' || callee === 'SharedWorker') {
        add(first?.type === 'SpreadElement' ? undefined : literalString(first), `new ${callee}()`);
      }
      if (callee === 'URL' && node.arguments.length > 1) {
        const second = node.arguments[1];
        if (second?.type === 'MemberExpression' && memberName(second) === 'import.meta.url') {
          add(first?.type === 'SpreadElement' ? undefined : literalString(first), 'new URL(..., import.meta.url)');
        }
      }
    },
  });
  return references;
}

function collectCssReferences(source: string, relativePath: string, htmlBase?: string): DependencyReference[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const references: DependencyReference[] = [];
  const add = (value: string, reason: string) =>
    references.push({ value, from: relativePath, reason, ...(htmlBase === undefined ? {} : { htmlBase }) });

  const urlPattern = /url\(\s*(?:(["'])(.*?)\1|([^\s)'";]+))\s*\)/gi;
  for (const match of withoutComments.matchAll(urlPattern)) {
    const value = match[2] ?? match[3];
    if (value !== undefined) add(value, 'CSS url()');
  }
  const importPattern = /@import\s+(?:url\(\s*)?(?:(["'])(.*?)\1|([^\s)'";]+))/gi;
  for (const match of withoutComments.matchAll(importPattern)) {
    const value = match[2] ?? match[3];
    if (value !== undefined) add(value, 'CSS @import');
  }
  return references;
}

function collectHtmlReferences(source: string, relativePath: string): DependencyReference[] {
  const rawReferences: Array<{ value: string; reason: string }> = [];
  const inlineCss: string[] = [];
  const inlineScripts: string[] = [];
  let htmlBase: string | undefined;
  let activeScript: { executable: boolean; text: string } | undefined;
  let activeStyle: string | undefined;

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = name.toLowerCase();
        if (tag === 'base' && htmlBase === undefined && attributes.href !== undefined) htmlBase = attributes.href;
        for (const [attributeName, value] of Object.entries(attributes)) {
          const attribute = attributeName.toLowerCase();
          if (HTML_REFERENCE_ATTRIBUTES.has(attribute) && !(tag === 'base' && attribute === 'href')) {
            rawReferences.push({ value, reason: `HTML <${tag}> ${attribute}` });
          }
          if (attribute === 'srcset' && !value.trimStart().startsWith('data:')) {
            for (const candidate of value.split(',')) {
              const resource = candidate.trim().split(/\s+/, 1)[0];
              if (resource) rawReferences.push({ value: resource, reason: `HTML <${tag}> srcset` });
            }
          }
          if (attribute === 'style') inlineCss.push(value);
        }
        if (tag === 'script') {
          const type = attributes.type?.trim().toLowerCase();
          const executable = type === undefined || type === '' || type === 'module' || type.includes('javascript');
          activeScript = { executable, text: '' };
        } else if (tag === 'style') {
          activeStyle = '';
        }
      },
      ontext(text) {
        if (activeScript !== undefined) activeScript.text += text;
        if (activeStyle !== undefined) activeStyle += text;
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (tag === 'script' && activeScript !== undefined) {
          if (activeScript.executable && activeScript.text.trim() !== '') inlineScripts.push(activeScript.text);
          activeScript = undefined;
        } else if (tag === 'style' && activeStyle !== undefined) {
          inlineCss.push(activeStyle);
          activeStyle = undefined;
        }
      },
    },
    { decodeEntities: false, lowerCaseAttributeNames: true, lowerCaseTags: true },
  );
  parser.end(source);

  const references: DependencyReference[] = rawReferences.map(({ value, reason }) => ({
    value,
    from: relativePath,
    reason,
    ...(htmlBase === undefined ? {} : { htmlBase }),
  }));
  for (const css of inlineCss) references.push(...collectCssReferences(css, relativePath, htmlBase));
  for (const script of inlineScripts) {
    for (const reference of collectJavaScriptReferences(script, relativePath)) {
      references.push(htmlBase === undefined ? reference : { ...reference, htmlBase });
    }
  }
  return references;
}

function addManifestReferences(manifest: Record<string, unknown>): {
  references: DependencyReference[];
  dnrFiles: Set<string>;
} {
  const references: DependencyReference[] = [];
  const dnrFiles = new Set<string>();
  const add = (value: unknown, reason: string, glob = false) => {
    for (const item of strings(value)) {
      references.push({
        value: item,
        from: 'manifest.json',
        reason,
        rootRelative: true,
        glob: glob && item.includes('*'),
      });
    }
  };
  const addDeep = (value: unknown, reason: string) => {
    for (const item of deepStrings(value)) add(item, reason);
  };

  addDeep(manifest.icons, 'manifest.icons');
  for (const key of ['action', 'browser_action', 'page_action', 'sidebar_action']) {
    const action = manifest[key];
    if (!isObject(action)) continue;
    addDeep(action.default_icon, `manifest.${key}.default_icon`);
    add(action.default_popup, `manifest.${key}.default_popup`);
    add(action.default_panel, `manifest.${key}.default_panel`);
  }

  const background = manifest.background;
  if (isObject(background)) {
    add(background.scripts, 'manifest.background.scripts');
    add(background.page, 'manifest.background.page');
    add(background.service_worker, 'manifest.background.service_worker');
  }
  if (Array.isArray(manifest.content_scripts)) {
    for (const contentScript of manifest.content_scripts) {
      if (!isObject(contentScript)) continue;
      add(contentScript.js, 'manifest.content_scripts.js');
      add(contentScript.css, 'manifest.content_scripts.css');
    }
  }

  add(manifest.options_page, 'manifest.options_page');
  if (isObject(manifest.options_ui)) add(manifest.options_ui.page, 'manifest.options_ui.page');
  add(manifest.devtools_page, 'manifest.devtools_page');
  if (isObject(manifest.side_panel)) add(manifest.side_panel.default_path, 'manifest.side_panel.default_path');
  if (isObject(manifest.chrome_url_overrides)) add(Object.values(manifest.chrome_url_overrides), 'manifest.chrome_url_overrides');
  if (isObject(manifest.sandbox)) add(manifest.sandbox.pages, 'manifest.sandbox.pages');
  if (isObject(manifest.storage)) add(manifest.storage.managed_schema, 'manifest.storage.managed_schema');

  if (Array.isArray(manifest.web_accessible_resources)) {
    for (const entry of manifest.web_accessible_resources) {
      if (typeof entry === 'string') add(entry, 'manifest.web_accessible_resources', true);
      else if (isObject(entry)) add(entry.resources, 'manifest.web_accessible_resources.resources', true);
    }
  }

  const dnr = manifest.declarative_net_request;
  if (isObject(dnr) && Array.isArray(dnr.rule_resources)) {
    for (const rule of dnr.rule_resources) {
      if (!isObject(rule)) continue;
      for (const rulePath of strings(rule.path)) {
        add(rulePath, 'manifest.declarative_net_request.rule_resources.path');
        dnrFiles.add(normalizeManifestPath(rulePath));
      }
    }
  }

  addDeep(isObject(manifest.theme) ? manifest.theme.images : undefined, 'manifest.theme.images');
  addDeep(isObject(manifest.theme) ? manifest.theme.icons : undefined, 'manifest.theme.icons');
  addDeep(isObject(manifest.dark_theme) ? manifest.dark_theme.icons : undefined, 'manifest.dark_theme.icons');
  addDeep(isObject(manifest.theme_experiment) ? manifest.theme_experiment.images : undefined, 'manifest.theme_experiment.images');

  if (isObject(manifest.dictionaries)) {
    for (const dictionary of deepStrings(manifest.dictionaries)) {
      add(dictionary, 'manifest.dictionaries');
      if (/\.dic$/i.test(dictionary)) add(dictionary.replace(/\.dic$/i, '.aff'), 'manifest.dictionaries companion');
    }
  }
  if (Array.isArray(manifest.nacl_modules)) {
    for (const module of manifest.nacl_modules) if (isObject(module)) add(module.path, 'manifest.nacl_modules.path');
  }
  if (Array.isArray(manifest.plugins)) {
    for (const plugin of manifest.plugins) if (isObject(plugin)) add(plugin.path, 'manifest.plugins.path');
  }
  if (Array.isArray(manifest.file_browser_handlers)) {
    for (const handler of manifest.file_browser_handlers) {
      if (isObject(handler)) addDeep(handler.default_icon, 'manifest.file_browser_handlers.default_icon');
    }
  }
  const settingsOverrides = manifest.chrome_settings_overrides;
  if (isObject(settingsOverrides) && isObject(settingsOverrides.search_provider)) {
    add(settingsOverrides.search_provider.favicon_url, 'manifest.chrome_settings_overrides.search_provider.favicon_url');
  }
  if (Array.isArray(manifest.protocol_handlers)) {
    for (const handler of manifest.protocol_handlers) if (isObject(handler)) add(handler.uri, 'manifest.protocol_handlers.uri');
  }
  if (isObject(manifest.experiment_apis)) {
    for (const experiment of Object.values(manifest.experiment_apis)) {
      if (!isObject(experiment)) continue;
      add(experiment.schema, 'manifest.experiment_apis.schema');
      if (isObject(experiment.parent)) add(experiment.parent.script, 'manifest.experiment_apis.parent.script');
      if (isObject(experiment.child)) add(experiment.child.script, 'manifest.experiment_apis.child.script');
    }
  }
  return { references, dnrFiles };
}

function normalizeManifestPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').split(/[?#]/, 1)[0] ?? '';
}

function resolveReference(reference: DependencyReference): string | undefined {
  let value = reference.value.trim().replace(/\\/g, '/');
  if (value === '' || value.startsWith('#') || /^(?:data|blob|javascript|mailto|tel):/i.test(value)) return undefined;
  if (reference.moduleSpecifier && !value.startsWith('.') && !value.startsWith('/')) return undefined;
  if (reference.glob) return normalizeManifestPath(value);

  let baseUrl = new URL(reference.rootRelative ? '/' : `/${reference.from}`, EXTENSION_ORIGIN);
  // runtime.getURL 等 API 明确以扩展根目录为基准，不受页面中的 <base href> 影响。
  if (!reference.rootRelative && reference.htmlBase !== undefined) {
    try {
      baseUrl = new URL(reference.htmlBase, baseUrl);
    } catch {
      return undefined;
    }
  }
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return undefined;
  }
  if (url.origin !== EXTENSION_ORIGIN) return undefined;
  try {
    value = decodeURIComponent(url.pathname);
  } catch (error) {
    throw new ExtbError(`资源路径包含无效 URL 编码（${reference.reason}）: ${reference.value}`, { cause: error });
  }
  const relative = path.posix.normalize(value.replace(/^\/+/, ''));
  return relative === '.' || relative === '' ? undefined : relative;
}

function expandGlob(pattern: string, inventory: readonly SourceFile[]): SourceFile[] {
  const normalized = normalizeManifestPath(pattern);
  if (normalized.endsWith('/*')) {
    const prefix = normalized.slice(0, -1);
    return inventory.filter((file) => file.relativePath.startsWith(prefix));
  }
  const matchBase = !normalized.includes('/');
  return inventory.filter((file) => minimatch(file.relativePath, normalized, { dot: true, matchBase }));
}

function collectDnrReferences(source: string, relativePath: string): DependencyReference[] {
  let rules: unknown;
  try {
    rules = JSON.parse(source) as unknown;
  } catch (error) {
    throw new ExtbError(`解析 DNR 规则文件失败 ${relativePath}: ${asErrorMessage(error)}`, { cause: error });
  }
  const references: DependencyReference[] = [];
  if (!Array.isArray(rules)) return references;
  for (const rule of rules) {
    if (!isObject(rule) || !isObject(rule.action) || !isObject(rule.action.redirect)) continue;
    for (const extensionPath of strings(rule.action.redirect.extensionPath)) {
      references.push({
        value: extensionPath,
        from: relativePath,
        reason: 'DNR redirect.extensionPath',
        rootRelative: true,
      });
    }
  }
  return references;
}

/**
 * 从 manifest 入口建立静态依赖图，并递归追踪 HTML、CSS、JavaScript 和 DNR 引用。
 * 无法静态表达的动态资源必须由 include glob 明确补充。
 */
export async function collectRequiredSourceFiles(options: DependencyCollectionOptions): Promise<SourceFile[]> {
  const inventoryByPath = new Map(options.inventory.map((file) => [file.relativePath, file]));
  const selected = new Map<string, SourceFile>();
  const processed = new Set<string>();
  const queue: DependencyReference[] = [];

  const manifestStat = await import('node:fs/promises').then(({ stat }) => stat(options.manifestPath));
  selected.set('manifest.json', { sourcePath: options.manifestPath, relativePath: 'manifest.json', size: manifestStat.size });

  const manifestDependencies = addManifestReferences(options.manifest);
  queue.push(...manifestDependencies.references);

  for (const pattern of options.include) {
    queue.push({
      value: pattern,
      from: 'extb include',
      reason: `include: ${pattern}`,
      rootRelative: true,
      glob: /[*?[\]{}()]/.test(pattern),
    });
  }
  // 只有声明了 default_locale（或 manifest 使用 __MSG_*__）时，本地化目录才属于运行时资源。
  const usesLocalization =
    typeof options.manifest.default_locale === 'string' || JSON.stringify(options.manifest).includes('__MSG_');
  if (usesLocalization) {
    for (const locale of options.inventory.filter((file) => file.relativePath.startsWith('_locales/'))) {
      queue.push({ value: locale.relativePath, from: 'manifest.json', reason: '扩展本地化目录', rootRelative: true });
    }
  }

  while (queue.length > 0) {
    const reference = queue.shift()!;
    const resolved = resolveReference(reference);
    if (resolved === undefined) continue;

    if (reference.glob) {
      // 通配符匹配到的文件也可能是 HTML/CSS/JS，因此转成精确引用重新入队，继续追踪其依赖。
      for (const file of expandGlob(resolved, options.inventory)) {
        queue.push({ value: file.relativePath, from: reference.from, reason: reference.reason, rootRelative: true });
      }
      continue;
    }

    const file = inventoryByPath.get(resolved);
    if (file === undefined) {
      throw new ExtbError(`必需资源不存在或已被排除: ${resolved}\n来源: ${reference.from}（${reference.reason}）`);
    }
    selected.set(file.relativePath, file);
    if (processed.has(file.relativePath)) continue;
    processed.add(file.relativePath);

    const extension = path.posix.extname(file.relativePath).toLowerCase();
    if (!['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json'].includes(extension)) continue;
    const source = await readFile(file.sourcePath, 'utf8');
    if (extension === '.html' || extension === '.htm') queue.push(...collectHtmlReferences(source, file.relativePath));
    else if (extension === '.css') queue.push(...collectCssReferences(source, file.relativePath));
    else if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
      queue.push(...collectJavaScriptReferences(source, file.relativePath));
    } else if (manifestDependencies.dnrFiles.has(file.relativePath)) {
      queue.push(...collectDnrReferences(source, file.relativePath));
    }
  }

  return [...selected.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
