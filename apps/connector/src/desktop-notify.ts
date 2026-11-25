// Stage 5 Zero-Dependency Cross-Platform Desktop Notifications (`desktop-notify.ts`).
//
// Adapted from `KKKKhazix/agent-autoloop` (`plugins/desktop/channel.ts`):
// - Headless / SSH guard: silently skips when running inside SSH (`SSH_CONNECTION` / `SSH_TTY`),
//   CI (`CI`), or headless Linux without `DISPLAY` / `WAYLAND_DISPLAY`.
// - Zero command-string interpolation:
//   - macOS (`darwin`): `osascript - -- <title> <body>` reading `item 1 of argv` / `item 2 of argv`
//   - Windows (`win32`): `-EncodedCommand <UTF-16LE Base64>` reading `$env:OTTO_NOTIFY_TITLE` /
//     `$env:OTTO_NOTIFY_BODY` via `System.Windows.Forms.NotifyIcon`
//   - Linux (`linux`): `notify-send --app-name=Otto -- <title> <body>`
import { execFile } from "node:child_process";

const MACOS_APPLESCRIPT = [
  "on run argv",
  "  set notifTitle to item 1 of argv",
  "  set notifBody to item 2 of argv",
  "  display notification notifBody with title notifTitle",
  "end run",
].join("\n");

const WINDOWS_POWERSHELL_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$n = New-Object System.Windows.Forms.NotifyIcon",
  "$n.Icon = [System.Drawing.SystemIcons]::Information",
  "$n.BalloonTipTitle = [string]$env:OTTO_NOTIFY_TITLE",
  "$n.BalloonTipText = [string]$env:OTTO_NOTIFY_BODY",
  "$n.Visible = $true",
  "$n.ShowBalloonTip(5000)",
  "Start-Sleep -Milliseconds 250",
  "$n.Dispose()",
].join("; ");

export function encodePowerShellUtf16LeBase64(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function hasActiveDesktopSession(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false;
  if (env.CI === "1" || env.CI === "true") return false;
  if (platform === "linux") {
    return Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
  }
  return platform === "darwin" || platform === "win32";
}

export interface DesktopNotificationCommand {
  file: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

export function buildDesktopNotificationCommand(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
  baseEnv: Record<string, string | undefined> = process.env,
): DesktopNotificationCommand | null {
  const cleanTitle = title.replace(/\0/g, "").trim().slice(0, 120) || "Otto";
  const cleanBody = body.replace(/\0/g, "").trim().slice(0, 300) || "Task status updated.";

  if (platform === "darwin") {
    return {
      file: "osascript",
      args: ["-e", MACOS_APPLESCRIPT, "--", cleanTitle, cleanBody],
    };
  }
  if (platform === "win32") {
    return {
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encodePowerShellUtf16LeBase64(WINDOWS_POWERSHELL_SCRIPT),
      ],
      env: {
        ...baseEnv,
        OTTO_NOTIFY_TITLE: cleanTitle,
        OTTO_NOTIFY_BODY: cleanBody,
      },
    };
  }
  if (platform === "linux") {
    return {
      file: "notify-send",
      args: ["--app-name=Otto", "--", cleanTitle, cleanBody],
    };
  }
  return null;
}

export type DesktopExecFn = (
  file: string,
  args: string[],
  options: { timeout: number; env?: Record<string, string | undefined>; windowsHide?: boolean },
) => Promise<void>;

const defaultExec: DesktopExecFn = (file, args, options) =>
  new Promise((resolveDone) => {
    execFile(file, args, options, () => resolveDone());
  });

export async function sendDesktopNotification(options: {
  title: string;
  body: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  exec?: DesktopExecFn;
}): Promise<{ sent: boolean; reason?: "headless_or_ssh" | "unsupported_platform" }> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (!hasActiveDesktopSession(platform, env)) {
    return { sent: false, reason: "headless_or_ssh" };
  }
  const cmd = buildDesktopNotificationCommand(options.title, options.body, platform, env);
  if (!cmd) {
    return { sent: false, reason: "unsupported_platform" };
  }
  const execFn = options.exec ?? defaultExec;
  await execFn(cmd.file, cmd.args, {
    timeout: options.timeoutMs ?? 4_000,
    ...(cmd.env ? { env: cmd.env } : {}),
    windowsHide: true,
  });
  return { sent: true };
}
