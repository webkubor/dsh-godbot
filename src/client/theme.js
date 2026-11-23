// The default team theme and native workbench share these surfaces. The team
// workspace also uses this shape for its user-selectable themes.
export const workspaceTheme = {
  label: 'NativeCrew',
  light: {
    bg: '#fbfcfd', sidebar: '#edf2f5', bubble: '#ecf1f5', card: '#ffffff',
    text: '#17293d', user: '#203e58', userText: '#ffffff', accent: '#b54425',
  },
  dark: {
    bg: '#101923', sidebar: '#141f2c', bubble: '#223345', card: '#1b2938',
    text: '#e6f0f5', user: '#24485b', userText: '#edfaff', accent: '#ffa47a',
  },
}

function surfaceTokens(palette) {
  return {
    ink: palette.text, bubble: palette.bubble, sidebar: palette.sidebar, main: palette.bg,
    card: palette.card, accent: palette.accent, user: palette.user, 'user-ink': palette.userText,
  }
}

export const lightTokens = {
  ...surfaceTokens(workspaceTheme.light),
  'ink-2': '#506377',
  'ink-3': '#607287',
  'accent-ink': '#ffffff',
  danger: '#ad3348',
  warn: '#875808',
  green: '#13816b',
  star: '#ae720e',
  line: 'rgba(35,62,84,.12)',
  'line-2': 'rgba(35,62,84,.22)',
  'line-weak': 'rgba(35,62,84,.08)',
  hover: 'rgba(26,78,101,.065)',
  active: '#dbe8ed',
  'tag-bg': '#e3ebef',
  'tag-ink': '#4c6374',
  'glass-bg': 'var(--bt-card)',
  'glass-rim': 'var(--bt-line)',
  'glass-shadow': '0 6px 20px -10px rgba(23,43,60,.24)',
  'card-shadow': '0 2px 5px -3px rgba(23,43,60,.18)',
  'nav-thumb-bg': 'var(--bt-card)',
  'nav-thumb-shadow': 'var(--bt-card-shadow)',
  'accent-soft': 'color-mix(in srgb,var(--bt-accent) 12%,var(--bt-card))',
  'danger-soft': 'color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card))',
  font: 'var(--dsw-font-family,"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif)',
}

export const darkTokens = {
  ...surfaceTokens(workspaceTheme.dark),
  'ink-2': '#b0c2d1',
  'ink-3': '#96aabb',
  'accent-ink': '#102832',
  danger: '#ff9fa5',
  warn: '#edbd75',
  green: '#67c5ae',
  star: '#f0bd6d',
  line: 'rgba(182,209,228,.14)',
  'line-2': 'rgba(182,209,228,.25)',
  'line-weak': 'rgba(182,209,228,.08)',
  hover: 'rgba(160,208,222,.08)',
  active: '#253e4d',
  'tag-bg': '#253949',
  'tag-ink': '#c2d5df',
  'glass-shadow': '0 8px 20px -8px rgba(0,7,18,.50)',
  'card-shadow': '0 2px 5px -3px rgba(0,7,18,.40)',
}

const declare = (tokens) => Object.entries(tokens).map(([name, value]) => `--bt-${name}:${value};`).join('')
const aliases = `
  --gb-bg:var(--bt-main);
  --gb-surface:var(--bt-card);
  --gb-raised:var(--bt-hover);
  --gb-input:var(--bt-card);
  --gb-line:var(--bt-line-2);
  --gb-border:var(--bt-line);
  --gb-ink:var(--bt-ink);
  --gb-muted:var(--bt-ink-2);
  --gb-subtle:var(--bt-ink-3);
  --gb-accent:var(--bt-accent);
  --gb-faint:var(--bt-tag-bg);
  --gb-hover:var(--bt-hover);
  --gb-panel:var(--bt-card);
`

// Installed for the whole plugin lifetime. .gb-theme gives the same palette to
// NativeCrew surfaces that DSH mounts outside a workspace, such as its overlay seat.
export const themeStyle = `
:is(.gb-root,.gb-theme){${declare(lightTokens)}${aliases}}
body[data-ds-dark-theme] :is(.gb-root,.gb-theme){${declare(darkTokens)}}
`
