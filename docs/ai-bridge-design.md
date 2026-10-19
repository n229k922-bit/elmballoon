# ChatGPT / Codex review → Claude Code correction pilot

Status: local pilot, not an unattended production integration.

## Boundaries

The host reviews a precise commit, supplies a JSON review, invokes Claude Code,
validates the returned replacement text, runs tests and reviews again. Claude
receives no tools, MCP connections, repository hooks, or permission bypass.
Only existing text fixtures under docs/ai-bridge-pilot/ can be replaced. This
restriction is enforced by Python, not by a natural language prompt.

No secrets are added to the repository. No shell command comes from the model.
The bridge never commits, pushes, merges, deploys or sends LINE messages.
An experiment/chatgpt-claude-* branch and a clean worktree are mandatory.
Reviews are bound to HEAD; stale reviews, duplicate paths, traversal, hash
mismatches, malformed output and empty proposals fail closed.

## Review contract

Create the review JSON OUTSIDE the repository:

```json
{
  "head_sha": "full current commit SHA",
  "round": 1,
  "decision": "changes_requested",
  "allowed_files": ["docs/ai-bridge-pilot/acceptance.txt"],
  "findings": [{"id": "PILOT-1", "description": "A precise correction request"}]
}
```

From the isolated clone, use Python to run tools/claude_patch_bridge.py with the
review path, a new output path outside the clone, and optionally --apply.
The default only saves a proposal. The --apply switch permits fixture edits.
The host must test the actual content, inspect the diff, then record a fresh
review of the resulting commit. A round number is metadata, not a persistent
global spending limit; the host enforces at most 3 rounds per task.

## Approval gates

1. Restrict the task and paths before invoking Claude. Limit runtime to 180 s.
2. Validate proposal, run acceptance tests and re-review. Errors stop the loop.
3. Create a draft PR only after checks pass. No automatic merge.
4. Human approval of the exact final commit is required for main/deployment.
   New commits invalidate earlier approval.

## Future unattended execution (not enabled)

ChatGPT UI conversation state is not an automation API. Use an authenticated
OpenAI API/Codex integration for machine-readable reviews, with its own access
and billing checks. A working ChatGPT subscription or GitHub connector alone
does not establish that API access is configured.

Before allowing real source edits, use an ephemeral container with no production
secrets and restricted network. Keep the orchestrator and test definitions in a
trusted revision outside the model-writable tree; a model must not approve its
own checks. Pin action and dependency revisions. Do not use pull_request_target
to execute untrusted PR content. Reject fork PRs from privileged fix jobs.
Separate read-only review, unprivileged proposal/test, and narrowly scoped PR
publication jobs. Bind every artifact and review to base/head SHA and run ID;
reject stale artifacts and concurrent changes. Persist a 3-round counter and
cost caps in the trusted host. Use an environment approval before paid runs and
before issuing a short-lived branch-only publication credential.

Existing deploy-pages.yml runs on main push and manual dispatch. It must never
be triggered by this pilot. Existing validation is useful but does not establish
that deployment, production LINE behavior or end-to-end integration is accepted.

## Sources

- https://learn.chatgpt.com/docs/github-action
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/cli-reference
