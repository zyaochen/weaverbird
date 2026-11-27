# Audit Pipe

Standalone audit sidecar for Weaverbird W3.1/F17.

- Entry: `packages/core/src/audit-pipe/audit-pipe-main.ts`
- Config: `~/.weaverbird/config.json` (mode `600`)
- Mirror: `~/.weaverbird/audit-mirror.ndjson`
- WAL: `~/.weaverbird/wal/audit/`

## Commands

```bash
npm run audit-pipe -- --once
npm run audit-pipe -- --interval 300000
```

## Quick checks

```bash
grep -rn "lark_domain\|open\.larkoffice\.com" packages/core/src/audit-pipe/bitable-sink.ts
wc -l packages/core/src/audit-pipe/contracts.ts
npm run typecheck
```
