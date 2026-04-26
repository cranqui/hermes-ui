# Hermes-UI Patch Notes

## api_server.py — SSE Event Forwarding Patch

**File:** `/home/user/.local/pipx/venvs/hermes/lib/python3.12/site-packages/hermes/server/gateway/api_server.py`

**Change:** Line ~949, the `_on_tool_progress` callback currently filters to only forward `tool.started` events:
```python
if event_type != "tool.started":
    return
```

**Patched to:** Forward all three event types (`tool.started`, `tool.completed`, `reasoning.available`) as `hermes.tool.progress` SSE events, each including the `event_type` field in the payload.

**⚠️ This patch is applied to the pipx-installed package, NOT the source repo at `~/dev/hermes/`.**
Running `pipx upgrade hermes` will overwrite this patch. Must be re-applied after any upgrade.

**Source repo** (`~/dev/hermes/hermes/server/gateway/api_server.py`) has the same change committed in git but is not what the running server loads.