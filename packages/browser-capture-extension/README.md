# Verity One Browser Capture Extension

Optional MV3 extension shell for saving the active browser tab into the
local VO vault inbox.

This extension is a thin intake bridge only. It posts plain text from the
active tab to local VO at `/browser-capture/intake`, where local VO writes a
markdown file under `inbox/web-clips/`. Existing `vo vault clipper-sync` or
`vo vault harvest` remains the harvest authority.

## Local Setup

1. Initialize and enable a local VO vault.
2. Mint a browser-capture token from local VO.
3. Allow the unpacked extension origin through `VERITY_BROWSER_CAPTURE_ORIGINS`.
4. Load this directory as an unpacked extension.
5. Paste the local VO URL and `vobc_*` token in extension options.

The extension never stores dashboard, sync, hosted, Google, MCP, TDK, or CK
credentials. It only stores the local VO URL and `vobc_*` capture token in
browser extension storage.
