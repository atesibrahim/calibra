# Calibra

Automatic per-prompt model routing for Claude Code. Calibra classifies each prompt by complexity and routes it to the most cost-effective model — no manual model switching needed.

---

## How It Works

Every time you submit a prompt, Calibra scores it and picks a tier:

| Tier | Default Model | When |
|------|--------------|------|
| `light` | Haiku | Greetings, short replies, trivial one-liners (fix typo, add log) |
| `mid` | Sonnet | Concrete implementation tasks (fix, build, write, create, explain) |
| `deep` | Opus | Design, analysis, architecture, security, investigation |
| `ultra` | Opus | Long + deep + broad scope together (comprehensive audits, full redesigns) |

### Scoring

Calibra scores each prompt across **five orthogonal axes** — no keyword appears in more than one axis, so no signal double-counts.

#### Axis 1 — Length

| Prompt length | Points |
|---------------|--------|
| > 500 chars | +3 |
| > 200 chars | +2 |
| ≥ 80 chars | +1 |

#### Axis 2 — Intent

| Signal | Points |
|--------|--------|
| **Deep intent** (`architect`, `design`, `analyse`, `review`, `security`, `refactor`, `audit`, `investigate`, `compare`, `trade-offs`, `deep dive`, `evaluate`, `strategy`, `propose`, `plan`, …) | +3 |
| **Mid intent** (`implement`, `build`, `create`, `write`, `fix`, `debug`, `add`, `update`, `migrate`, `deploy`, `explain`, `describe`, `summarize`, …) | +1 |

#### Axis 3 — Scope

| Signal | Points |
|--------|--------|
| Breadth/thoroughness words (`comprehensive`, `entire`, `full`, `end-to-end`, `thorough`, `exhaustive`, `detailed`, `in-depth`, `complete`, `overall`, …) | +2 |

#### Axis 4 — Domain

| Signal | Points |
|--------|--------|
| Technical complexity vocabulary (`distributed`, `microservices`, `monolith`, `authentication`, `authorization`, `system design`, `system architecture`, `scalability`, `bottleneck`, `kubernetes`, `graphql`, `grpc`, `event-driven`, `message queue`, `sharding`, `circuit breaker`, `technical debt`, `algorithm`, `consensus`, `throughput`, `latency`, …) | +2 |

#### Axis 5 — Structure

| Signal | Points |
|--------|--------|
| Multiple code blocks or block > 52 lines | +2 |
| Single code block | +1 |
| Step-by-step / multi-part markers (`walk me through`, `break it down`, …) | +1 |

#### Tier thresholds (max realistic ≈ 13)

```
score 0–2, no deep or mid intent  → light
score 0–7, no deep intent         → mid
score 0–7, deep intent present    → deep   ← floor: deep intent always routes here minimum
score 8+                          → ultra
```

**Floor rules:**
- Any deep-intent keyword → minimum `deep`, regardless of score (catches short expert prompts like "design auth system")
- Any mid-intent keyword → minimum `mid` (prevents short implementation requests from falling to light)

#### Early exits (bypass scoring)

- **Greetings / acks** → `light` immediately
- **Trivial one-liners** (add console.log, fix typo, rename variable, format file, add comment) → `light` immediately
- **Slash commands** → `mid` (tool/harness invocations, not natural language)
- **Short prompts ≤ 55 chars with no signal** → `light`

### Architecture

```
Claude Code
    │
    ▼ ANTHROPIC_BASE_URL → http://127.0.0.1:{port}
saka-proxy (local HTTP proxy)
    │  reads prompt from request body
    │  runs calibraClassify()
    │  rewrites model field in-flight
    ▼
Upstream AI server  (CALIBRA_REMOTE_HOST)
```

The proxy starts when your enterprise wrapper launches Claude Code and sets `ANTHROPIC_BASE_URL` to the local port. Claude Code never talks to the upstream directly.

---

## Requirements

- Node.js ≥ 18
- Claude Code CLI
- An enterprise wrapper that sets `CALIBRA_REMOTE_HOST` and `ANTHROPIC_BASE_URL` before launching Claude Code

---

## Installation

**Option A — npx (no permissions needed, recommended)**

```sh
npx calibra install
```

**Option B — global install**

```sh
npm install -g calibra
```

If you get `EACCES: permission denied`, fix npm's global directory first:

```sh
# Set a user-writable prefix (one-time setup)
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc   # or ~/.bashrc
source ~/.zshrc

npm install -g calibra
```

> If you use **nvm** or **fnm**, global installs already work without this step.

That's it. The postinstall script:

1. Copies `saka-proxy.js` to `~/.claude-corp/`
2. Copies hooks to `~/.claude/hooks/`
3. Copies the `/calibra` command to `~/.claude/commands/`
4. Creates `~/.claude-corp/calibra-models.json` (only on first install — never overwritten on upgrade)
5. Creates symlinks `~/.claude-corp/claude-config/hooks` → `~/.claude/hooks` and `commands` → `~/.claude/commands`
6. Registers hooks in `~/.claude/settings.json` and `~/.claude-corp/claude-config/settings.json` (if it exists)

---

## Configuration

### Model tiers — `~/.claude-corp/calibra-models.json`

Created on first install. Edit to change which model each tier uses:

```json
{
  "light": "claude-haiku-4-5-20251001",
  "mid":   "claude-sonnet-4-6",
  "deep":  "claude-opus-4-7",
  "ultra": "claude-opus-4-7",
  "nonAnthropicModels": []
}
```

- **Never overwritten on upgrade** — your customisations are preserved
- `nonAnthropicModels`: list model IDs that need special request sanitisation (strip thinking blocks, set min `max_tokens`)

### Remote host — `CALIBRA_REMOTE_HOST`

Set by your enterprise wrapper before starting the proxy:

```sh
export CALIBRA_REMOTE_HOST="your-litellm-server.example.com"
```

If unset, the proxy starts but cannot forward requests.

---

## Usage

Calibra runs silently in the background. You will see a context note on each prompt:

```
calibra: claude-sonnet-4-6 used regarding your prompt complexity
```

### `/calibra` command

Control Calibra from within Claude Code:

```
/calibra status    → show current state (ENABLED / DISABLED)
/calibra on        → enable routing
/calibra off       → disable routing (all prompts use default model)
/calibra toggle    → flip current state
```

You can also type naturally:
```
disable calibra
enable calibra
calibra status
```

### Disable flag

Routing is also disabled if the file `~/.claude-corp/calibra-disabled` exists. The `/calibra` command creates or removes this file.

---

## Upgrade

```sh
npx calibra upgrade
# or
npm update -g calibra
```

- `saka-proxy.js` and hooks are updated
- `calibra-models.json` is **never overwritten** — your tier config is preserved
- Hook entries in `settings.json` are updated in-place if node path changed

---

## Uninstall

```sh
npx calibra uninstall
# or
npm uninstall -g calibra
```

The preuninstall script removes:
- `~/.claude-corp/saka-proxy.js`
- `~/.claude-corp/calibra-models.json`
- `~/.claude-corp/calibra-disabled`
- `~/.claude/hooks/calibra-{notify,debug,toggle}.js`
- `~/.claude/commands/calibra.md`
- Calibra hook entries from both `settings.json` files
- `claude-config/hooks` and `claude-config/commands` (symlink or copied files)
- Any of the above directories left empty after cleanup

---

## Files Installed

| File | Location | Purpose |
|------|----------|---------|
| `saka-proxy.js` | `~/.claude-corp/` | Local proxy — classifies prompts, rewrites model |
| `calibra-models.json` | `~/.claude-corp/` | Tier → model mapping (user config) |
| `calibra-notify.js` | `~/.claude/hooks/` | Shows routing decision in context |
| `calibra-debug.js` | `~/.claude/hooks/` | Logs raw hook input to `<tmpdir>/calibra-debug.log` |
| `calibra-toggle.js` | `~/.claude/hooks/` | Handles chat-phrase toggle commands |
| `calibra.md` | `~/.claude/commands/` | `/calibra` slash command definition |

---

## Publishing a New Version

### 1. Bump version

```sh
npm version patch   # 1.0.0 → 1.0.1  (bug fix)
npm version minor   # 1.0.0 → 1.1.0  (new feature)
npm version major   # 1.0.0 → 2.0.0  (breaking change)
```

This updates `package.json` and creates a git tag automatically.

### 2. Publish

```sh
npm publish
```

#### First-time login

```sh
npm login
```

#### Publishing to GitHub Packages instead of public npm

Add to `package.json`:

```json
"publishConfig": {
  "registry": "https://npm.pkg.github.com"
}
```

Add to `~/.npmrc`:

```
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

Then publish normally:

```sh
npm publish
```

### 3. Push git tag

```sh
git push && git push --tags
```

---

## Team Quick Reference

| Action | Command |
|--------|---------|
| Install | `npx calibra install` |
| Install (global) | `npm install -g calibra` |
| Check version | `npm list -g calibra` |
| Upgrade | `npx calibra upgrade` |
| Uninstall | `npx calibra uninstall` |
| Verify working | `/calibra status` in Claude Code |

---

## Platforms

| Platform | Status |
|----------|--------|
| macOS | Supported |
| Linux | Supported |
| Windows (native) | Supported |

On Windows, hooks use explicit `node hookpath.js` invocation. Junction points are used instead of symlinks (no admin required).
