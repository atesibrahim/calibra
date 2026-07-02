---
allowed-tools: Bash(rm -f ~/.claude-corp/calibra/calibra-disabled), Bash(touch ~/.claude-corp/calibra/calibra-disabled), Bash(test -f ~/.claude-corp/calibra/calibra-disabled && echo DISABLED || echo ENABLED), Bash(echo ml > ~/.claude-corp/calibra/calibra-engine), Bash(echo heuristic > ~/.claude-corp/calibra/calibra-engine), Bash(cat ~/.claude-corp/calibra/calibra-engine 2>/dev/null || echo heuristic)
description: Enable or disable Calibra model routing
---

Run ONE bash command based on "$ARGUMENTS". Reply in one line only, no explanation.

If "$ARGUMENTS" is "on" or "enable":
Run `rm -f ~/.claude-corp/calibra/calibra-disabled` → reply "Calibra: ENABLED"

If "$ARGUMENTS" is "off" or "disable":
Run `touch ~/.claude-corp/calibra/calibra-disabled` → reply "Calibra: DISABLED"

If "$ARGUMENTS" is "toggle":
Run `test -f ~/.claude-corp/calibra/calibra-disabled && (rm -f ~/.claude-corp/calibra/calibra-disabled && echo ENABLED) || (touch ~/.claude-corp/calibra/calibra-disabled && echo DISABLED)` → reply result

If "$ARGUMENTS" is "ml" or "ml on" or "neural":
Run `rm -f ~/.claude-corp/calibra/calibra-disabled && echo ml > ~/.claude-corp/calibra/calibra-engine` → reply "Calibra: ENABLED · Engine: ml"

If "$ARGUMENTS" is "ml off" or "rules":
Run `echo heuristic > ~/.claude-corp/calibra/calibra-engine` → reply "Calibra: Engine set to heuristic rules"

If "$ARGUMENTS" is "status" or empty:
Run both:
  `test -f ~/.claude-corp/calibra/calibra-disabled && echo DISABLED || echo ENABLED`
  `cat ~/.claude-corp/calibra/calibra-engine 2>/dev/null || echo heuristic`
→ reply "Calibra: [ENABLED|DISABLED] · Engine: [ml|heuristic] · Switch: /calibra ml on | /calibra ml off | /calibra rules"
