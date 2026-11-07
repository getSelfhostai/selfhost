# @selfhost/github

GitHub delivery for the review list. Through the selfhost GitHub App it keeps each agent pull
request showing what the review list knows: a risk label and an agent label, a check run that
summarizes the review brief, a review request to the owner, and the brief as one comment.
The server's `POST /v1/github/webhooks` calls it (see
[`apps/server`](../../apps/server/README.md#github-app)) with `desired` built from the review
list: the owner its routing picks, and the brief from `@selfhost/brief`, whose summary paragraph
leads the check run and whose Markdown is the comment.

```ts
import { createGitHubApp, githubAppEnv, syncPullRequest } from "@selfhost/github";

const { credentials } = githubAppEnv(); // SELFHOST_GITHUB_APP_ID, _PRIVATE_KEY(_FILE), _WEBHOOK_SECRET
const app = createGitHubApp(credentials);
await app.verify(rawBody, request.headers["x-hub-signature-256"]); // true or false
const octokit = app.installation(payload.installation.id);
const { writes, refused } = await syncPullRequest(
  octokit,
  { owner: "acme", repo: "acme-api", number: 101, headSha, author: "alice" },
  {
    labels: { risk: "high", agent: "claude_code" },
    check: { title, summary, text, conclusion: "neutral" },
    reviewers: { users: ["bob"], teams: [] },
    brief: { body: briefMarkdown, marker: "<!-- selfhost:brief v1 -->" },
  },
);
```

GitHub App plumbing comes from the official Octokit libraries: `@octokit/webhooks` checks
`X-Hub-Signature-256` and types the payloads, `@octokit/auth-app` signs the App's JWT and
fetches, caches and renews installation tokens, and `@octokit/rest` makes the calls (with
pagination). Nothing here signs or verifies by hand.

## Sync

`syncPullRequest(octokit, pr, desired)` reads the current state of each part `desired` names
and writes only what differs. Parts left out are not read and not changed.

| Part        | Read                                                                                    | Written only when                                                                                             |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `labels`    | The pull request's labels                                                               | A managed label is not wanted (removed first) or a wanted one is missing (added in one call)                  |
| `check`     | Check runs named `selfhost/review` on the head commit                                   | No run has this pull request's `external_id` (created), or its conclusion or output differs (updated)         |
| `brief`     | The conversation comments                                                               | No comment by an app holds the marker (created), or that comment's body differs (edited in place)             |
| `reviewers` | Requested reviewers and teams, and, when a user is not requested, the submitted reviews | A login or team is neither requested nor (for a login) already a reviewer, and is not the pull request author |

- Labels are `selfhost:risk-low`, `selfhost:risk-medium`, `selfhost:risk-high` and
  `selfhost:agent-<agent>` (`claude_code` becomes `selfhost:agent-claude-code`), compared
  ignoring case as GitHub does. Only labels with those two prefixes are ever removed, so a risk
  change removes the old level and adds the new one, and every other label stays. GitHub creates
  a label the first time it is added to a pull request.
- The check run's `external_id` is `selfhost:<owner>/<repo>#<number>@<head sha>`: one run per
  pull request and head commit. A push gets a new run; every later delivery for the same commit
  updates the one it made. Its conclusion is `neutral` (passes a required check) or `failure`.
- Review requests are only added. People who already reviewed are not asked again (GitHub drops
  their request when they review), and requests someone made by hand are never removed. A
  request GitHub refuses with 422 (a login that is not a collaborator) is returned in `refused`
  and the rest of the sync still applies; any other error fails the call.
- The brief comment is found by its marker among comments made by an app, so a person quoting
  the marker does not take it over. The marker goes first when the body does not already hold it.
- Summaries, check text and comment bodies over GitHub's limits (65,535 and 65,536 characters)
  are cut with a note, the same way each time.

**Idempotent.** Every write follows a read of the exact state it would change and a comparison
with `desired`. After a run succeeds, the pull request matches `desired`, so a second run with
the same `desired` reads, compares equal everywhere and makes zero writes. The tests run every
case twice against a stateful fake of the GitHub API and check that the second run writes
nothing. A delivery id the server has already handled does not reach this call at all.

## App

- `githubAppEnv(env)` reads `SELFHOST_GITHUB_APP_ID`, `SELFHOST_GITHUB_PRIVATE_KEY` (the PEM,
  or one line with `\n` escapes) or `SELFHOST_GITHUB_PRIVATE_KEY_FILE` (a path to the .pem),
  and `SELFHOST_GITHUB_WEBHOOK_SECRET`. It returns the credentials, or the names of the missing
  variables; values never appear in an error.
- `createGitHubApp(credentials, { fetch, log })` returns `verify(body, signature)` and
  `installation(id)`, which keeps one Octokit per installation so its token is reused until
  @octokit/auth-app renews it. `fetch` replaces the network for tests; `log` gets Octokit's
  warnings, never tokens or bodies.

## Tests

`@selfhost/github/testing` exports `FakeGitHub`, an in-memory GitHub REST API served through a
`fetch` handed to Octokit. It keeps labels, check runs, review requests, reviews, comments, files
(with patches), commits and file contents per pull request, records every request, checks the App
JWT against a public key when given one, and answers 404 (recorded in `unknown`) for any route it
does not serve. No test reaches the network.
