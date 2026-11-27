# minutes package

This domain hosts the local-only Minutes adapter flow used by `MIN-ADAPTER`.

- adapter writes run-scoped Minutes context into `runs/<botId>/<runId>/`
- mock client is allowed for local verification
- guarded client is the default boundary for real Minutes fetch/auth paths
- do not route Minutes behavior through `group-sync` or `reverse-channel`
