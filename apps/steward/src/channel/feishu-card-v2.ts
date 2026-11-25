// Stage 5 Feishu Card JSON Schema 2.0 Renderer (`channel/feishu-card-v2.ts`).
//
// Renders Otto's `LocalMessage` cards (`done`, `attention`, `failure`, `quota_hold`,
// `proposal`, `pr_watch_stuck`, `digest`) into structured Feishu Card Schema 2.0 payloads:
// - Semantic header color template (`green`, `orange`, `red`, `blue`).
// - Markdown primary content + automatic `collapsible_panel` fold when details exceed 600 chars.
// - Action & approval buttons mapped to 7-day (`7 * 86_400_000` ms) single-use `sh_web_link`
//   URLs so owners on mobile/desktop Feishu open the exact Thread or approval view in one tap
//   without exposing public unauthenticated callback endpoints.
import type { LocalMessage, MessageButton, Tone } from "../report-template.ts";

export const CARD_LINK_TTL_MS = 7 * 86_400_000;

export type FeishuHeaderTemplate = "green" | "orange" | "red" | "blue" | "wathet";

export interface FeishuCardV2Element {
  tag: string;
  [key: string]: unknown;
}

export interface FeishuCardV2 {
  schema: "2.0";
  config: {
    wide_screen_mode: boolean;
    update_multi: boolean;
  };
  header: {
    title: {
      tag: "plain_text";
      content: string;
    };
    template: FeishuHeaderTemplate;
  };
  body: {
    direction: "vertical";
    padding?: string;
    elements: FeishuCardV2Element[];
  };
}

export function inferToneFromLocalMessage(card: LocalMessage, explicitTone?: Tone): Tone | "info" {
  if (explicitTone) return explicitTone;
  const trimmed = card.text.trimStart();
  if (trimmed.startsWith("✅")) return "success";
  if (trimmed.startsWith("❌")) return "failure";
  if (trimmed.startsWith("⚠️") || trimmed.startsWith("⏸") || trimmed.startsWith("❓")) return "attention";
  return "info";
}

export function headerTemplateForTone(tone: Tone | "info"): FeishuHeaderTemplate {
  switch (tone) {
    case "success":
      return "green";
    case "attention":
      return "orange";
    case "failure":
      return "red";
    default:
      return "blue";
  }
}

function splitHeadlineAndBody(rawText: string): { headline: string; summaryMd: string; foldMd: string | null } {
  const lines = rawText.split("\n");
  const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
  const headline =
    firstNonEmptyIdx >= 0
      ? lines[firstNonEmptyIdx]!.trim().slice(0, 100)
      : "Otto 任务通知";
  const rest = firstNonEmptyIdx >= 0 ? lines.slice(firstNonEmptyIdx + 1).join("\n").trim() : rawText.trim();
  if (rest.length <= 600) {
    return { headline, summaryMd: rest || headline, foldMd: null };
  }
  const paragraphs = rest.split("\n\n");
  let summaryMd = "";
  let idx = 0;
  while (idx < paragraphs.length && (summaryMd.length + paragraphs[idx]!.length) <= 550) {
    summaryMd = summaryMd ? `${summaryMd}\n\n${paragraphs[idx]!}` : paragraphs[idx]!;
    idx += 1;
  }
  if (!summaryMd) {
    summaryMd = `${rest.slice(0, 550)}…`;
    return { headline, summaryMd, foldMd: rest.slice(550).trim() || null };
  }
  const foldMd = paragraphs.slice(idx).join("\n\n").trim() || null;
  return { headline, summaryMd, foldMd };
}

function renderButtonElement(
  btn: MessageButton,
  actionLinks?: Record<string, string>,
  fallbackUrl?: string | null,
): FeishuCardV2Element | null {
  const targetUrl =
    btn.url ??
    (btn.action && actionLinks?.[btn.action] ? actionLinks[btn.action] : undefined) ??
    fallbackUrl ??
    undefined;
  if (!targetUrl) return null;

  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: btn.label.slice(0, 40),
    },
    type: btn.primary ? "primary" : "default",
    width: "default",
    behaviors: [
      {
        type: "open_url",
        default_url: targetUrl,
      },
    ],
  };
}

export interface RenderFeishuCardV2Input {
  card: LocalMessage;
  title?: string;
  tone?: Tone;
  /** Optional action-to-signed-URL map (7-day single-use `sh_web_link` URLs). */
  actionLinks?: Record<string, string>;
  /** Signed Thread / workspace URL used for action buttons when no per-action URL is mapped. */
  workspaceUrl?: string | null;
}

export function renderFeishuCardV2(input: RenderFeishuCardV2Input): FeishuCardV2 {
  const tone = inferToneFromLocalMessage(input.card, input.tone);
  const { headline, summaryMd, foldMd } = splitHeadlineAndBody(input.card.text);
  const headerTitle = (input.title?.trim() || headline).slice(0, 100);

  const elements: FeishuCardV2Element[] = [
    {
      tag: "markdown",
      content: summaryMd,
    },
  ];

  if (foldMd) {
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: {
          tag: "plain_text",
          content: "展开完整详情",
        },
      },
      elements: [
        {
          tag: "markdown",
          content: foldMd.slice(0, 12_000),
        },
      ],
    });
  }

  const renderedButtons = (input.card.buttons ?? [])
    .map((btn) => renderButtonElement(btn, input.actionLinks, input.workspaceUrl))
    .filter((b): b is FeishuCardV2Element => b !== null);

  if (renderedButtons.length > 0) {
    elements.push({
      tag: "column_set",
      flex_mode: "flow",
      background_style: "default",
      columns: renderedButtons.map((buttonEl) => ({
        tag: "column",
        width: "auto",
        elements: [buttonEl],
      })),
    });
  }

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: headerTitle,
      },
      template: headerTemplateForTone(tone),
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}
