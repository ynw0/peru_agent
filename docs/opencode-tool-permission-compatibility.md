# OpenCode Tool / Permission Compatibility

Peru Agent reuses the interaction model and selected permission-rule semantics from
[anomalyco/opencode](https://github.com/anomalyco/opencode), which is MIT licensed.
The license copy used by this repository is stored at `THIRD_PARTY/opencode-MIT.txt`.

This port is intentionally **not** a wholesale fork of OpenCode. Peru Agent keeps its
existing security boundaries: workspace writes remain Diff Proposals, PowerShell stays
behind the Windows Sandbox Broker, network access stays behind the Egress Broker, and
subagents retain isolated workspaces plus reviewer/tester gates.

## Permission semantics

The permission core follows OpenCode's current model:

- ordered rules with the **last matching rule winning**;
- unmatched requests default to `ask`;
- a Tool declares `permission`, `patterns`, `always`, and `metadata`;
- user replies are `once`, `always`, or `reject`;
- `always` adds allow rules for the suggested patterns and releases other matching
  pending requests in the same Session;
- wildcard matching follows OpenCode path normalization and wildcard semantics, including
  `\`/`/` normalization and optional trailing arguments for patterns such as `git *`;
- `reject` rejects all pending permission requests in the same Session.

Peru Agent adds stricter invariants on top: Capability/Sandbox hard-deny results are
never overridable by permission rules or user approval. `always` rules are also persisted
inside the owning Session snapshot and never leak into another Session. OpenCode currently
keeps approved rules in its permission-service instance; this Session scoping is an
intentional least-privilege deviation.

## Tool mapping

| OpenCode tool | Peru Agent model-facing ID | Execution backend | Status |
| --- | --- | --- | --- |
| `read` | `read` | `WorkspaceService` / authorized external target | implemented |
| `write` | `write` | `DiffManager` proposal only | implemented |
| `edit` | `edit` | `DiffManager` proposal only | implemented |
| `apply_patch` | `apply_patch` | existing exact-edit patch proposal | implemented |
| `glob` | `glob` | `WorkspaceService.glob` | implemented |
| `grep` | `grep` | `WorkspaceService.grep` | implemented |
| `bash` | `bash` | Windows Sandbox Broker / PowerShell AST inspection | implemented |
| `task` | `task` | isolated `SubagentScheduler` | implemented |
| `webfetch` | `webfetch` | Egress Broker | implemented |
| `websearch` | `websearch` | Egress Broker | implemented |
| `question` | — | requires a first-class mid-run user-question coordinator | not implemented |
| `todowrite` | — | requires a first-class Session todo state machine | not implemented |
| `skill` | — | existing Skill Evolution artifacts are not a runtime SKILL.md loader | not implemented |
| `lsp` | — | no LSP client/runtime exists in the Agent execution path | not implemented |

The missing tools are deliberately not registered under OpenCode names until a real
backend exists. This prevents the model from seeing a Tool that silently falls back to
another subsystem or returns placeholder output.

### Argument-schema compatibility

The table above means **model-facing IDs and permission protocol compatibility**, not a
claim that every JSON argument schema is byte-for-byte identical to OpenCode. Existing
Peru backends keep their validated inputs where OpenCode currently exposes capabilities
that Peru does not yet implement. For example, OpenCode `read` exposes
`filePath / offset / limit`, while Peru's current `read` backend uses a validated `path`;
OpenCode `task` supports continuation/background fields that do not map one-to-one onto
Peru's gated SubagentScheduler. These schemas will only be aligned when the corresponding
native capability exists, rather than through aliases or fallback fields.

## Peru-specific tools retained

Peru Agent keeps additional audited tools for document manipulation, browser automation,
Computer Use, Diff/Checkpoint inspection, background PowerShell terminals, Plan review,
and subagent gate reporting. These use the same `permissions()` declaration contract
when they require approval.

## Review UI

Permission review exposes the same three user outcomes as OpenCode:

- **允许一次** → `once`
- **始终允许匹配项** → `always`
- **拒绝** → `reject`

The review detail includes the permission key, requested patterns, proposed `always`
patterns, Tool metadata, affected files, network targets, commands, and the existing
Peru capability/risk information.
