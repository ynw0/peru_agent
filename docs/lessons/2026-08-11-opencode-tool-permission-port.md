# OpenCode Tool / Permission Port

## Why this change

Peru Agent previously had two overlapping approval concepts: Capability-derived grants
and UI scopes (`once/session/project`). That made Tool behavior depend on a fingerprint
outside the Tool contract and diverged from the mature OpenCode permission model.

## Reused idea

The permission-rule state machine is adapted from `anomalyco/opencode` (MIT): ordered
rules, last-match wins, default ask, and `once / always / reject` replies. The Tool itself
now declares the permission key, match patterns, suggested always patterns, and metadata.

## Important integration rule

OpenCode's rule order is significant. A catch-all default must appear **before** specific
rules when the evaluator uses last-match-wins. Putting `* -> ask/deny` last silently
shadows every preceding allow rule and can deadlock a Tool waiting for an approval that
should never have been requested.

A regression test must cover this whenever permission defaults or mode policy change.

## Deliberate Peru differences

- `write`, `edit`, and `apply_patch` never directly mutate the workspace; they create a
  Diff Proposal and wait at the existing Diff review boundary.
- `bash` is implemented by the Windows Sandbox Broker and existing PowerShell AST safety
  inspection, not by OpenCode's shell runner.
- web access stays behind the Egress Broker.
- Capability/Sandbox hard-deny decisions take precedence over OpenCode-style allow rules.
- `always` rules persist in the owning Session snapshot and cannot authorize another Session.
- missing OpenCode tools do not get placeholder or fallback registrations.

These differences preserve Peru Agent's stronger execution invariants while giving Tools
and approval a single OpenCode-style protocol.
