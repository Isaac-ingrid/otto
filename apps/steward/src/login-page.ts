import { BRAND_HEAD, BRAND_LOCKUP, BRAND_STYLE } from "./brand.ts";

export const LOGIN_SCRIPT_PATH = "/login.js";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

export function loginPage(message = "", status = 200): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#070a08"><meta name="robots" content="noindex">
<title>Sign in - Otto</title>
${BRAND_HEAD}
<style>${BRAND_STYLE}
:root{color-scheme:dark;accent-color:var(--green);--page:#070a08;--surface:#0b0f0c;--inset:#0f1410;--ink:#dbe4d7;--ink-strong:#f1f7ee;--muted:#959f98;--muted-dim:#6c7a70;--line:#1e261d;--line-strong:#2b362a;--grid:#10150f;--green:#8dff62;--green-dark:#5ecb4a;--green-wash:#12200f;--red:#ff8871;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background-color:var(--page);background-image:linear-gradient(to right,var(--grid) 1px,transparent 1px),linear-gradient(to bottom,var(--grid) 1px,transparent 1px);background-size:76px 76px;color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:max(32px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(32px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));-webkit-font-smoothing:antialiased}
main{width:100%;max-width:420px}
.otto-brand{font-size:24px;margin-bottom:28px;color:var(--ink-strong)}
h1{font-size:30px;letter-spacing:-.02em;line-height:1.2;margin:0 0 10px;color:var(--ink-strong);text-wrap:balance}
.intro{color:var(--muted);margin:0 0 28px;text-wrap:pretty}
.card{position:relative;background:var(--surface);border:1px solid var(--line-strong);border-radius:4px;padding:28px;box-shadow:0 30px 80px rgba(0,0,0,.5)}
.card::before,.card::after{content:"";position:absolute;width:10px;height:10px;pointer-events:none}
.card::before{top:-1px;left:-1px;border-top:1px solid var(--green-dark);border-left:1px solid var(--green-dark);border-top-left-radius:4px}
.card::after{right:-1px;bottom:-1px;border-bottom:1px solid var(--line-strong);border-right:1px solid var(--line-strong);border-bottom-right-radius:4px}
label{display:block;font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600;margin-bottom:8px}
input,button,summary,a{font:inherit;touch-action:manipulation}
input{width:100%;border:1px solid var(--line-strong);border-radius:3px;padding:12px;background:var(--inset);color:var(--ink-strong);font-family:var(--mono);font-size:13px;min-width:0}
input:user-invalid{border-color:var(--red)}
input:-webkit-autofill,input:autofill{-webkit-text-fill-color:var(--ink-strong);box-shadow:0 0 0 1000px var(--inset) inset;caret-color:var(--ink-strong)}
button{width:100%;padding:12px 16px;border-radius:3px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);cursor:pointer;font-family:var(--mono);font-size:12px;letter-spacing:.04em;font-weight:600}
button:hover{border-color:var(--green-dark);color:var(--green)}
button.primary{background:var(--green);color:#06110a;border-color:var(--green);margin-top:14px;box-shadow:0 0 18px rgba(141,255,98,.14)}
button.primary:hover{background:var(--green);color:#06110a}
button:disabled{opacity:.55;cursor:default}
button:focus-visible,input:focus-visible,summary:focus-visible,a:focus-visible{outline:1px solid var(--green);outline-offset:2px;box-shadow:0 0 0 3px rgba(141,255,98,.12)}
.divider{display:flex;align-items:center;gap:14px;color:var(--muted-dim);font:10px var(--mono);letter-spacing:.12em;text-transform:uppercase;margin:22px 0}
.divider:before,.divider:after{content:"";height:1px;background:var(--line);flex:1}
.status{font-size:12px;margin:12px 0 0;color:var(--red)}
.notice{background:var(--green-wash);border:1px solid #26351f;color:var(--green);padding:12px 16px;border-radius:3px;margin-bottom:20px;font:11px/1.7 var(--mono);letter-spacing:.02em}
.recovery{color:var(--muted);font-size:13px;margin-top:24px}
summary{cursor:pointer;color:var(--ink)}
details p{margin:12px 0 0}
code{font-family:var(--mono);font-size:12px;background:rgba(255,255,255,.045);border-radius:2px;padding:1px 4px;color:#a9b6ae;overflow-wrap:anywhere}
.footer{color:var(--muted-dim);font:10px var(--mono);letter-spacing:.1em;text-transform:uppercase;text-align:center;margin-top:20px}
[hidden]{display:none!important}
@media(max-width:650px){input{font-size:16px}button{min-height:44px}}
@media(max-width:440px){.card{padding:22px}body{padding:max(24px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}}
</style></head>
<body><main>
${BRAND_LOCKUP}
<h1 data-copy="heading">Welcome back.</h1>
<p class="intro" data-copy="intro">Sign in to your personal agent.</p>
<p class="notice" ${message ? "" : "hidden"}>${escapeHtml(message)}</p>
<p id="reauth-notice" class="notice" hidden data-copy="reauth">Sign in again to change your security settings.</p>
<section class="card" aria-label="Sign in">
<form id="password-form">
<label for="login-password" data-copy="password">Deployment password</label>
<input id="login-password" name="password" type="password" required maxlength="128" autocomplete="current-password webauthn" aria-describedby="password-status" autofocus>
<button id="password-signin" class="primary" type="submit" data-copy="passwordSignIn">Sign in</button>
<p id="password-status" class="status" role="status" aria-live="polite" hidden></p>
</form>
<div id="passkey-divider" class="divider" hidden data-copy="or">or</div>
<button id="passkey-signin" type="button" hidden data-copy="passkeySignIn">Sign in with a passkey</button>
<p id="passkey-status" class="status" role="status" aria-live="polite" hidden></p>
<details class="recovery"><summary data-copy="recoveryTitle">Forgot your password?</summary>
<p data-copy="recovery">Self-hosted: set LOGIN_PASSWORD in /etc/otto/.dev.vars and restart the service. On Cloudflare: open the Worker, then Settings &gt; Variables and Secrets, and deploy. Either way use a new, unique password of at least 15 characters, and every browser is signed out while your data and connected machines are untouched.</p></details>
<noscript><p class="status">Enable JavaScript to sign in.</p></noscript>
</section>
<p class="footer" data-copy="footer">Your own agent. Your own workspace.</p>
<script type="module" src="${LOGIN_SCRIPT_PATH}"></script>
</main></body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
