import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, 'index.html'), 'utf8');

const checks = [
  ['security build marker', source.includes("ASTEROID_SECURITY_BUILD='asteroid-os-supabase-verified-session-2026-08-05'")],
  ['Supabase user endpoint validates sessions', source.includes("asteroidRequest('/auth/v1/user','GET',null,token)")],
  ['account creation uses the protected Supabase Edge Function', source.includes("asteroidRequest('/functions/v1/messagex-create-account','POST',{username,password})")],
  ['unsupported direct Auth-table signup RPC is not used', !source.includes("messagex_create_account")],
  ['verified user helper is used during restore', source.includes('asteroidVerifiedUserForSession(existingSession)')],
  ['profile lookup is bound to auth user id', source.includes("profiles?select=username,auth_user_id,is_approved,is_banned,ban_reason&auth_user_id=eq.")],
  ['profile ownership is checked', source.includes("String(profile.auth_user_id)!==userId")],
  ['Supabase local logout is used', source.includes("signOutAsteroidSession('local')")],
  ['login screen identifies Supabase Auth', source.includes('Protected by Supabase Auth.')],
  ['full session is not written to localStorage mirror', !source.includes('localStorage.setItem(ASTEROID_SESSION_MIRROR_KEY')],
  ['full session is not written to window.name', !source.includes('window.name=ASTEROID_WINDOW_SESSION_PREFIX')],
  ['full session is not written to browser history', !source.includes('history.replaceState({...history.state,asteroidSession')],
  ['legacy history-session trust helper is removed', !source.includes('function readAsteroidHistorySession')],
  ['profile restoration cannot fall back to username metadata', !source.includes('asteroidProfileForSession(session,fallbackUsername)')],
  ['profile restoration cannot query by an unverified username', !source.includes("profiles?select=*&username=eq.")],
  ['transient network failures preserve saved sessions', source.includes('asteroidAuthFailureIsDefinitive(error)') && source.includes('the saved session was preserved')],
  ['session verification timeout is treated as transient', source.includes("asteroidTransientAuthError('Supabase session verification timed out.')")],
  ['AFS startup and lock verification overlays are visually suppressed', source.includes('#afsOverlay.show[data-mode="startup"],#afsOverlay.show[data-mode="lock"]{display:none!important}')],
  ['silent AFS is hidden from accessibility and cannot intercept input', source.includes("ui.overlay.toggleAttribute('inert',silent)") && source.includes("ui.overlay.setAttribute('aria-hidden',silent?'true':'false')")],
  ['the lock-screen password panel is always visible while AFS runs', source.includes("screen.classList.add('password-visible','show')") && source.includes("setTimeout(()=>input?.focus({preventScroll:true}),80)")],
  ['background AFS targets half-second frames with a five-second recognition window', source.includes('const BACKGROUND_RECOGNITION_MS=5000;') && source.includes('const TARGET_FRAME_MS=500;') && source.includes('lastFrameAt<=TARGET_FRAME_MS')],
  ['AFS failure keeps the visible password path available', source.includes("onUnavailable:()=>revealAsteroidPasswordPanel()") && source.includes("options.onUnavailable||options.onPassword")],
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
