# ADR-0016: The workspace is a dark instrument panel

Status: accepted. Supersedes the light palette ADR-0004 shipped with; the layout and interaction it
decided stand.

The workspace, the login page and the onboarding flow are used at night, next to a terminal, for
minutes at a time. A cream page with a forest-green primary spends its brightest pixels on
furniture — sidebars, cards, empty rows — while the two things that actually change (a run is live,
a decision is waiting) are drawn in the same weight as everything else. The result reads as a
document about the agent rather than a board that shows what the agent is doing.

- **Base is near-black, structure is drawn with lines.** `--page #070a08` to `--surface #0b0f0c`,
  a 76 px grid at `--grid #10150f`, hairline dividers `--line #1e261d`, corner brackets on panels.
  Depth comes from one border and one line, not from shadow and radius.
- **Signal green is rationed.** `--green #8dff62` appears only where something is live, actionable
  or focused: status dots, the active thread rail, the primary button, `.section-title` markers,
  focus rings. Surfaces stay neutral; a green-washed block means "this is the current thing"
  (`.thread-item.active`, `.provider-tile.is-active`), never decoration.
- **Amber and red stay meaningful.** `--amber #f5b455` / `--red #ff8871` carry the same
  attention/failure tones `notify_user` already decides (§7.5 of the steward design), so colour
  never disagrees with the card's `data-tone`.
- **Readouts are monospace, prose is not.** Utility text — state badges, section overlines, times,
  counts, keyboard hints, machine rows — uses `--mono` at 9–11 px with letter-spacing; message
  bodies, titles and card copy stay in the sans stack. Nothing that a person typed is
  re-cased or re-styled: `text-transform` is limited to labels the code itself writes.
- **Hard edges.** `--radius 4px` for panels and controls, 2–3 px for chips and inputs, circles only
  for dots and avatars.
- **The same tokens on every door.** `src/login-page.ts` and `src/brand.ts` share the palette and
  the mono/label treatment (`theme-color #070a08`), so sign-in, onboarding and the workspace do not
  flash two different products.

Constraints this keeps: the UI is still built through `h()` text nodes only (no HTML sink, no inline
script or style — `test/ui-modules.test.ts`), the CSP stays `default-src 'none'`, and the theme is
pure CSS plus two `<meta>` tags, so it deploys with the static `ui/` copy and needs no bundle swap.

Consequences. Legacy light-era rules stay in `workspace.css` underneath the dark root block and the
appended "instrument panel" layer; the mechanical conversion of 270 colour literals is complete, but
dead selectors (`decision-*`, `attention-item`, `process`, `raw-entry`, `machine-help`, `text-button`,
`tiny-mark`, `brand-wordmark`) can still be pruned. Dark is now the only theme — there is no
`prefers-color-scheme` branch to maintain.
