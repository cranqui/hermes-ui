# Hermes Chat — Style Guide

All styles live in a single `<style>` block inside `index.html`. There is no separate CSS file. The design is a **dark Claude-inspired palette** with warm orange as the accent color.

---

## CSS Variables (`:root`)

These are the only values you need to touch for a full theme change. Everything else in the file references these variables.

| Variable | Value | Role |
|---|---|---|
| `--bg-main` | `#1a1a1e` | Main content area background |
| `--bg-sidebar` | `#212128` | Left sidebar background |
| `--bg-input` | `#252530` | Input box, settings fields |
| `--bg-msg-user` | `#2d2d3c` | User message bubble |
| `--bg-hover` | `rgba(255,255,255,0.06)` | Hover state on list items / buttons |
| `--bg-active` | `rgba(255,255,255,0.10)` | Active / selected list item |
| `--border` | `#363642` | All borders and dividers |
| `--text-primary` | `#ebebf0` | Main readable text |
| `--text-secondary` | `#8888a0` | Labels, metadata, placeholders |
| `--text-dim` | `#55556a` | Very muted text, timestamps |
| `--accent` | `#c96442` | Brand color — buttons, links, active tab, title |
| `--danger` | `#ff6b6b` | Destructive actions, errors |
| `--radius` | `12px` | Default border radius |

---

## Typography

| Variable | Value | Used for |
|---|---|---|
| `--font-display` | Bricolage Grotesque | Topbar chat title (weight 800) |
| `--font-body` | Inter | All UI text, labels, buttons |
| `--font-mono` | JetBrains Mono | Code blocks, tool call previews |

Fonts are loaded from Google Fonts (requires network). The topbar title uses `font-variation-settings: 'wdth' 100, 'opsz' 40` and `letter-spacing: -0.04em` for the HEY.com-inspired compressed look.

---

## Hardcoded Colors (outside variables)

Some colors are hardcoded for specific components. Change these directly in `index.html`.

### Code blocks
```css
/* Code block background + border */
.msg-bubble pre        { background: #252530; border-color: #363642; }
/* Code block header bar */
.code-header           { background: #2a2a36; border-bottom-color: #363642; }
/* Inline code (e.g. `variable`) */
.msg-bubble p code     { background: #2a2a36; border-color: #363642; color: var(--accent); }
```

### Input toolbar buttons
All three (round-btn, model-pill, ctx-pill) share the same background:
```css
background: #2e2e3a;   /* resting */
background: #383846;   /* hover */
```

### Send button
```css
/* Active */   background: var(--accent);
/* Hover */    background: #e07050;        /* lighter shade of accent */
/* Disabled */ background: #2a2a36;
```

### Status banners (cron, offline, error)
```css
/* Running/online */  background: #0d2310; color: #4ade80;
/* Paused */          background: #2d1c08; color: #fb923c;
/* Error/offline */   background: #2d1515; color: #ff8080;
/* Offline banner */  background: #2d2510; color: #e6b84a;
```

### Skill source badges
```css
.skill-source.builtin  { background: #0d1a2d; color: #60a5fa; }
.skill-source.local    { background: #0d2310; color: #4ade80; }
.skill-source.hub      { background: #1e0d2d; color: #c084fc; }
```

### Right sidebar
```css
#right-sidebar { background: #18181e; }   /* slightly darker than --bg-main */
```

### Settings panel (slide-up sheet)
```css
#settings-panel { background: #1e1e26; }
```

---

## Syntax Highlighting

Uses **highlight.js** with the `github-dark.min.css` theme:
```html
<link rel="stylesheet" href="node_modules/highlight.js/styles/github-dark.min.css">
```

To switch themes, replace `github-dark.min.css` with any file from `node_modules/highlight.js/styles/`. Good dark alternatives: `atom-one-dark.min.css`, `github-dark-dimmed.min.css`.

---

## Common Changes

**Change accent color**
Find `--accent` in `:root` and update the hex. Also update the two hardcoded hover variants used on the send button and primary button:
- Send hover: `#e07050` → your lighter shade
- Btn-primary hover: `#e07050` → same

**Switch to a light theme**
Replace the `:root` values with light equivalents (e.g. swap `--bg-main` back to `#f9f9fb`, `--text-primary` to `#111115`, etc.) and change the hljs stylesheet to `github.min.css`.

**Change the topbar title font**
Edit `#topbar-title` and `#topbar-title-input`. The display font variable controls the family; adjust `font-size`, `font-weight`, and `letter-spacing` directly on those selectors.

**Change the logo gradient**
Search for `linear-gradient(135deg,` — it appears on `.hermes-logo` and `.big-logo`. Currently `#c96442 → #a03060`.
