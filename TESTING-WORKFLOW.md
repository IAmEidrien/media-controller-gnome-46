# Testing and release promotion

The release branch remains `main`. Push development changes to the persistent
`testing` branch and use Gitpulsar on that branch when you want to try them.
Users who want released changes continue pulling `main`.

The promotion controller opens one `testing` → `main` pull request while changes
are pending. It checks hourly and merges only after **72 hours without a new
testing push**, successful Testing CI and other push CI/statuses for the current
head, and a clean merge. The timer uses GitHub's server-side workflow creation
time, never author/committer dates. A force-push back to an old SHA still restarts
the timer. Do not force-push shared branches as part of the normal workflow.

Apply **`do-not-merge` to the promotion PR** to pause automatic merging. Removing
it resumes against the existing latest-push timer; a new testing push always
restarts the timer. Draft PRs, requested changes, conflicts and missing/failed/
cancelled validation also stop promotion. A closed promotion PR may be recreated
while unmerged changes remain, so use the label for a durable pause.

You may merge early using **Create a merge commit**. Do not squash or rebase if
you want original commits and authorship retained. Automatic promotion always
uses a normal merge commit and leaves `testing` in place. Keep the repository's
automatic head-branch deletion setting off. No release tags are created.

If the release branch has advanced independently, the controller normally merges
it into testing first, runs validation, and restarts the 72-hour period. Conflicts
require maintainer resolution. This preserves history and validates the combined
candidate rather than publishing against an untested release baseline.

Testing CI runs on pushes and supports manual dispatch. Rerunning an existing
run does not restart its timer; a new manual dispatch on testing deliberately
starts a fresh conservative timer. Bot pushes may not trigger another workflow,
so bots must dispatch Testing CI after pushing. The hourly controller dispatches
it if the current testing head has no push receipt. Scheduler/runner delays may
make promotion later than 72 hours; it never intentionally happens earlier.

The workflow files and controller must exist on `main` as well as testing.
Actions needs permission to create PRs, merge repository contents, manage the pause
label and dispatch validation. GitHub's combined **Allow GitHub Actions to create
and approve pull requests** setting must be enabled; this controller never submits
approving reviews. It uses the temporary repository token, with no personal token
or external service. The privileged controller executes only from `main`;
candidate validation uses a read-only token with checkout credentials disabled.

Validation includes static/schema checks, available regressions and packaging.
It is not a native GNOME desktop test. Use the three-day period for actual desktop
testing; apply the pause label whenever behavior needs more investigation.
