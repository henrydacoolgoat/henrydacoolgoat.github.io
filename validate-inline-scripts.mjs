import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const targets = ['messagex-v0.99.4.html', 'index.html'];
let checked = 0;

for (const target of targets) {
  const html = await readFile(path.join(projectDirectory, target), 'utf8');
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  let scriptNumber = 0;
  while ((match = scriptPattern.exec(html))) {
    scriptNumber += 1;
    const attributes = match[1];
    const source = match[2];
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const type = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() || '';
    if (type && !['text/javascript', 'application/javascript', 'module'].includes(type)) continue;
    if (type === 'module') {
      if (typeof vm.SourceTextModule !== 'function') {
        throw new Error(`${target} script ${scriptNumber}: this Node runtime cannot validate modules.`);
      }
      new vm.SourceTextModule(source, { identifier: `${target}:script-${scriptNumber}` });
    } else {
      new vm.Script(source, { filename: `${target}:script-${scriptNumber}` });
    }
    checked += 1;
  }
}

console.log(`Validated ${checked} inline JavaScript blocks.`);
