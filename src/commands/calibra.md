---
allowed-tools: Bash(rm -f ~/.claude-corp/calibra-disabled), Bash(touch ~/.claude-corp/calibra-disabled), Bash(test -f ~/.claude-corp/calibra-disabled && echo DISABLED || echo ENABLED)
description: Enable or disable Calibra model routing
---

Run ONE bash command based on "$ARGUMENTS". Reply in one line only, no explanation.

If "$ARGUMENTS" is "on" or "enable":
Run `rm -f ~/.claude-corp/calibra-disabled` → reply "Calibra: ENABLED"

If "$ARGUMENTS" is "off" or "disable":
Run `touch ~/.claude-corp/calibra-disabled` → reply "Calibra: DISABLED"

If "$ARGUMENTS" is "toggle":
Run `test -f ~/.claude-corp/calibra-disabled && (rm -f ~/.claude-corp/calibra-disabled && echo ENABLED) || (touch ~/.claude-corp/calibra-disabled && echo DISABLED)` → reply result

If "$ARGUMENTS" is "status" or empty:
Run `test -f ~/.claude-corp/calibra-disabled && echo DISABLED || echo ENABLED` → reply "Calibra: [result]"
