import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const gateway = 'https://messagex-media.asteroid-messagex.workers.dev';
const build = 'messagex-v0994-compact-call-preview-permanent-gateway-asteroid-bundled-2026-08-09';
const asteroidBuild = 'asteroid-os-v0.99.23.4-source-cover-art-fast-cached-games-2026-08-09';
const canonical = await readFile(path.join(root, 'messagex-v0.99.4.html'), 'utf8');
const loader = await readFile(path.join(root, 'MessageX_Latest_Loader_APP_VERSION_SIGNIN_FIXED.html'), 'utf8');
const asteroid = await readFile(path.join(root, 'index.html'), 'utf8');

const startMarker = '<script id="messageXEmbeddedSource" type="text/plain">';
const contentStart = asteroid.indexOf(startMarker) + startMarker.length;
const boundary = asteroid.toLowerCase().indexOf('</html>\n</script>', contentStart);
const embedded = contentStart >= startMarker.length && boundary >= 0
  ? asteroid.slice(contentStart, boundary + 7).replaceAll('<\\/script>', '</script>')
  : '';

const retryFunctionStart = canonical.indexOf('async function fetchMessageXMediaStorage');
const retryFunctionEnd = canonical.indexOf('function messageXLaptopMediaUrl', retryFunctionStart);
const retryFunction = retryFunctionStart >= 0 && retryFunctionEnd > retryFunctionStart
  ? canonical.slice(retryFunctionStart, retryFunctionEnd)
  : '';
const retryTryIndex = retryFunction.indexOf('try {');
const retryLookupIndex = retryFunction.indexOf('storageOrigin = await refreshMessageXMediaStorage');
const sendFunctionStart = canonical.indexOf('async function handleSend()');
const sendFunctionEnd = canonical.indexOf('const attachBtn =', sendFunctionStart);
const sendFunction = sendFunctionStart >= 0 && sendFunctionEnd > sendFunctionStart
  ? canonical.slice(sendFunctionStart, sendFunctionEnd)
  : '';
const uploadRequestIndex = sendFunction.indexOf('await fetchMessageXMediaStorage(uploadPath');
const validatedMediaIndex = sendFunction.indexOf("if (!media_url) throw new Error('The laptop returned an invalid media path.')");
const messageInsertIndex = sendFunction.indexOf("await supabase.from('messages').insert(insert)");

async function runRetryScenario({ registryFailures = 0, gatewayStatuses = [], failEveryLookup = false }) {
  let registryCalls = 0;
  let gatewayCalls = 0;
  let invalidations = 0;
  const context = vm.createContext({
    MESSAGE_X_MEDIA_RETRY_DELAYS_MS: [0, 750, 2000],
    MESSAGE_X_MEDIA_RETRYABLE_STATUSES: new Set([408, 425, 429, 500, 502, 503, 504, 521, 522, 523, 524, 525, 526, 530]),
    setTimeout(callback) { callback(); return 1; },
    refreshMessageXMediaStorage: async () => {
      registryCalls += 1;
      if (failEveryLookup || registryCalls <= registryFailures) throw new TypeError('Failed to fetch');
      return gateway;
    },
    fetch: async () => {
      const status = gatewayStatuses[gatewayCalls] ?? 201;
      gatewayCalls += 1;
      return { status };
    },
    invalidateMessageXMediaStorage: () => { invalidations += 1; },
  });
  vm.runInContext(`${retryFunction}\nglobalThis.retryUnderTest = fetchMessageXMediaStorage;`, context);
  try {
    const result = await context.retryUnderTest('/api/upload', { method: 'POST' }, true);
    return { ok: true, status: result.response.status, registryCalls, gatewayCalls, invalidations };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), registryCalls, gatewayCalls, invalidations };
  }
}

const registryRecovery = await runRetryScenario({ registryFailures: 2 });
const gatewayRecovery = await runRetryScenario({ gatewayStatuses: [503, 201] });
const normalizedNetworkFailure = await runRetryScenario({ failEveryLookup: true });

const checks = [
  ['standalone and remembered loader are byte-identical', canonical === loader],
  ['embedded MessageX equals the canonical standalone client', embedded === canonical.trimEnd()],
  ['permanent Cloudflare gateway is compiled into MessageX', canonical.includes(`const MESSAGE_X_MEDIA_GATEWAY_ORIGIN = '${gateway}';`)],
  ['Asteroid OS contains the permanent gateway', asteroid.includes(gateway)],
  ['all bundled copies carry the permanent-gateway build marker', canonical.includes(build) && loader.includes(build) && asteroid.includes(build)],
  ['the complete Asteroid OS carries the integrated release marker', asteroid.includes(`<meta name="asteroid-build" content="${asteroidBuild}"`) && asteroid.includes(`const ASTEROID_RELEASE_BUILD='${asteroidBuild}';`)],
  ['Supabase registry remains the online-state source', canonical.includes('media_storage_config?id=eq.primary&select=public_gateway_url,endpoint_url,is_online,tunnel_mode,updated_at')],
  ['registry endpoints must advertise the pinned origin', canonical.includes('endpoint.origin === MESSAGE_X_MEDIA_GATEWAY_ORIGIN')],
  ['media requests use only the pinned origin', canonical.includes('const nextOrigin = MESSAGE_X_MEDIA_GATEWAY_ORIGIN;')],
  ['uploads forward the current Supabase bearer session', canonical.includes('Authorization: uploadHeaders.Authorization')],
  ['uploads use a multipart file field', canonical.includes('const uploadForm = new FormData();') && canonical.includes("uploadForm.append('file', originalFile") && canonical.includes('body: uploadForm')],
  ['browser sets the multipart boundary automatically', !canonical.includes("'Content-Type': cleanType")],
  ['media tickets forward the current Supabase bearer session', canonical.includes("if (!authHeaders.Authorization) throw new Error('Sign in to view this media.')")],
  ['protected media tickets use the upload-proven authenticated POST transport', canonical.includes("await fetchMessageXMediaStorage(\n        '/api/media-ticket'") && canonical.includes("body: JSON.stringify({ path: pathname, chat_id: chatId })") && canonical.includes("'X-MessageX-Upload': '1'")],
  ['registry lookup and upload fetch share the retry boundary', retryTryIndex >= 0 && retryLookupIndex > retryTryIndex],
  ['media requests use five bounded attempts', canonical.includes('const MESSAGE_X_MEDIA_RETRY_DELAYS_MS = [0, 750, 2000, 5000, 10000];') && retryFunction.includes('attempt < MESSAGE_X_MEDIA_RETRY_DELAYS_MS.length')],
  ['raw browser network failures are converted to an actionable error', retryFunction.includes('/failed to fetch|networkerror|network request failed|load failed/i') && retryFunction.includes('try the photo again.')],
  ['fault injection recovers from two registry fetch failures', registryRecovery.ok && registryRecovery.status === 201 && registryRecovery.registryCalls === 3 && registryRecovery.gatewayCalls === 1],
  ['fault injection recovers from a retryable gateway response', gatewayRecovery.ok && gatewayRecovery.status === 201 && gatewayRecovery.registryCalls === 2 && gatewayRecovery.gatewayCalls === 2 && gatewayRecovery.invalidations === 1],
  ['fault injection never exposes the raw Failed to fetch message', !normalizedNetworkFailure.ok && normalizedNetworkFailure.registryCalls === 3 && !/failed to fetch/i.test(normalizedNetworkFailure.error) && /try the photo again/i.test(normalizedNetworkFailure.error)],
  ['photo receipt tickets fall through to the resilient request path', canonical.includes("try { storageOrigin = await refreshMessageXMediaStorage(); } catch (_) {}") && canonical.includes('const ticketRequest = await fetchMessageXMediaStorage(')],
  ['a photo message is inserted only after laptop upload confirmation', uploadRequestIndex >= 0 && validatedMediaIndex > uploadRequestIndex && messageInsertIndex > validatedMediaIndex],
  ['the full OS reads MessageX only from its embedded source', asteroid.includes("const source=document.getElementById(MESSAGE_X_DIRECT_EMBED_ID);") && !asteroid.includes('fetch(MESSAGE_X_BUNDLED_FILE')],
  ['the full OS mounts the validated embedded client with srcdoc', asteroid.includes('frame.srcdoc=html;') && asteroid.includes("meta[name=\"messagex-build\"]") && asteroid.includes('===MESSAGE_X_BUNDLED_BUILD')],
  ['the Asteroid desktop MessageX app mounts the shared embedded frame', asteroid.includes('async function mountMessageXFrame(root)') && asteroid.includes('const frame=await prepareMessageXInBackground();')],
  ['Contacts opens the shared embedded MessageX client', asteroid.includes("function openMessageXUsername(username)") && asteroid.includes("openApp('messages');\n    sendMessageXCommand({type:'asteroid-open-messagex-chat',username:clean});")],
  ['notification clicks open the shared embedded MessageX client', asteroid.includes("openApp('messages');\n    sendMessageXCommand({\n      type:'asteroid-open-messagex-chat',\n      chatId:note.chatId")],
  ['Comet sends through the shared embedded MessageX client', asteroid.includes('async function sendCometMessageXMessage({username,text})') && asteroid.includes('const frame=await prepareMessageXInBackground(),requestId=')],
  ['no Quick Tunnel hostname is bundled', !canonical.includes('trycloudflare.com')],
  ['no laptop loopback address is bundled', !canonical.includes('127.0.0.1:8787') && !canonical.includes('localhost:8787')],
  ['no Supabase secret or service-role key is bundled', !canonical.includes('sb_secret_') && !canonical.includes('service_role')],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);
const report = {
  ok: failures.length === 0,
  gateway,
  passed: checks.length - failures.length,
  total: checks.length,
  failures,
  checks: Object.fromEntries(checks),
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
