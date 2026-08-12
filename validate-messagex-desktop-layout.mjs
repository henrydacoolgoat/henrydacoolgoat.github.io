import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const standalone = await readFile(path.join(projectDirectory, 'messagex-v0.99.4.html'), 'utf8');
const loader = await readFile(path.join(projectDirectory, 'MessageX_Latest_Loader_APP_VERSION_SIGNIN_FIXED.html'), 'utf8');
const asteroid = await readFile(path.join(projectDirectory, 'index.html'), 'utf8');
const styleId = 'messagex-desktop-column-integrity-20260809';

const checks = [
  ['standalone MessageX contains the desktop column repair', standalone.includes(styleId)],
  ['MessageX loader contains the desktop column repair', loader.includes(styleId)],
  ['Asteroid OS embedded MessageX contains the desktop column repair', asteroid.includes(styleId)],
  ['desktop device grid clamps the conversation list width', /grid-template-columns:\s*clamp\(300px,\s*29vw,\s*420px\)\s+minmax\(0,\s*1fr\)\s*!important/.test(standalone)],
  ['desktop list screen is pinned to the first grid column', /#list-screen\s*\{[\s\S]{0,180}grid-column:\s*1\s*!important/.test(standalone)],
  ['desktop chat screen is pinned to the second grid column', /#chat-screen\s*\{[\s\S]{0,180}grid-column:\s*2\s*!important/.test(standalone)],
  ['weather theme cannot restore full-window absolute chat layers', /body\.theme-weather\.is-app\s+#device\s*>\s*#list-screen/.test(standalone) && /position:\s*relative\s*!important/.test(standalone)],
  ['chat messages and media are constrained to the active conversation column', /#chat-screen\s+\.message[\s\S]{0,100}max-width:\s*min\(72%,\s*760px\)\s*!important/.test(standalone) && /#chat-screen\s+:is\(\.msg-bubble,\s*\.msg-image,\s*\.msg-video,\s*\.msg-audio\)/.test(standalone)],
  ['desktop call self preview is compact', /#mx-call-overlay\s+#mx-local-video\s*\{[\s\S]{0,260}width:\s*clamp\(108px,\s*10vw,\s*170px\)/.test(standalone)],
  ['mobile call self preview remains compact', /@media\s*\(max-width:\s*620px\)[\s\S]{0,180}width:\s*clamp\(92px,\s*25vw,\s*126px\)/.test(standalone)],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);
const report = {
  ok: failures.length === 0,
  passed: checks.length - failures.length,
  total: checks.length,
  failures,
  checks: Object.fromEntries(checks),
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
