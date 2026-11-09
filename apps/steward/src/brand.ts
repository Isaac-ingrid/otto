// Public identity; durable storage and protocol identifiers keep their original names
// so a rebrand does not reset an existing deployment (ADR-0014).
export const LOGO_PATH = "/brand/otto.svg";
export const AVATAR_PATH = "/brand/otto-avatar.png";
export const BRAND_HEAD = `<link rel="icon" type="image/svg+xml" href="${LOGO_PATH}">
<meta name="theme-color" content="#070a08">`;
export const BRAND_LOCKUP = `<span class="otto-brand"><img src="${LOGO_PATH}" width="32" height="32" alt=""><span>Otto</span></span>`;
export const BRAND_STYLE = `.otto-brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 700; letter-spacing: -.03em; vertical-align: middle; }
.otto-brand img { display: block; flex: none; }`;
