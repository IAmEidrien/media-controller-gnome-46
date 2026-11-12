# Media Controller: GNOME 46 public fork

This is a compatibility and convenience fork of `naimur900/media-controller-gnome`,
based on upstream `07c66b5` (3.4). Preserve
upstream ancestry, copyright notices, and the GPL-2.0-or-later license.

The target is Linux Mint 22 / GNOME Shell 46 on Wayland, with GLib 2.80 and
libadwaita 1.5. Do not widen the support declaration or claim native runtime
testing from syntax checks or mocked constructors.

- Keep UUID `media-controller-gnome-46@eidrien.local`, schema ID/path
  `org.gnome.shell.extensions.media-controller`, and gettext domain
  `media-controller` stable. No personal GSettings values in the repository.
- The repository root is directly installable. Keep runtime JS, metadata,
  stylesheet, and schema XML at the root, and the Makefile's package manifest
  complete. Do not commit `schemas/gschemas.compiled` or build ZIPs.
- Shell 46 box layouts use `vertical`; `orientation` is not an St.BoxLayout
  property there. Preferences must work without Adw.ButtonRow (introduced 1.6).
  Shell 46 cannot resolve `-st-accent-color`. Guard newer Shell light-style
  APIs/signals. Apply theme accents to the volume slider and player-list rows.
- Theme accents use the standard slider fill through St.ThemeNode color lookup,
  with an optional `-media-controller-accent-color` override and blue fallback.
  Preserve theme listener cleanup, artwork styles/sizing, and neutral icons.
- Preserve the lyrics icon in package/install manifests. Online lyrics lookup stays
  opt-in; keep stale-response guards, timer cleanup, and metadata/local LRC lookup.
- Preserve fixed icon/artwork sizing, MPRIS capabilities, player selection,
  seek behavior, timer/signal cleanup, and cancellation of artwork downloads.
- The optional album-art backdrop uses GdkPixbuf and a small cache. Keep the
  backdrop module in the flat runtime package and preserve its cleanup.
- Panel shortcuts apply to the selected player and must not intercept transport
  controls. Player-volume shortcuts affect MPRIS Volume, not system volume.
  Keep the Actions group after Placement in the Panel preferences.
- Sound output selection changes the system default via Gvc, never issues
  Play to undo a pause. Do not infer user intent from pauses shortly after an
  output switch. Preserve the audio mixer's signal cleanup and close on disable.
- Back/Forward defaults are Previous/Next player. Player cycling belongs to
  the shared action list, uses the same ready, non-idle roster as the menu with wraparound, and must
  not change playback or depend on CanControl. Preserve scroll fractions across
  selections caused by the gesture itself; external player changes still clear
  them. Keep old schema action enum numbers stable.
- When pausing other players, wait for the reported status. Optimistically
  recording Paused can misread delayed browser updates as a new playback start.
- Prefer symbolic icons through Shell's icon-theme lookup, preserving the
  original GIcon as fallback. Keep this preference panel-only, immediately
  below Player icon, and disable its row while Player icon is off.
- Gitpulsar Pull updates the installed checkout. Use ordinary fast-forward
  commits on shared main; never force-push. Installation/uninstallation helpers
  must not remove a Git-managed extension checkout.
- The optional tools/update_helper.py installs only systemd user units. It must
  never pull Git, force a logout, overwrite a valid schema on compilation failure,
  or block new schema compilations while a notification waits for a response.
- Upstream automation must use normal merges/pushes, preserve the root layout,
  require compatibility/check/package gates, and stop for conflicts or new
  platform APIs. Do not describe mocked validation as native runtime coverage.
- HUMANS.md is exclusively Eidrien's writing. Do not draft, paraphrase, polish
  or edit its prose unless Eidrien supplies exact text and requests insertion.
  Keep public AI disclosure and technical maintenance information in README.md.

Run `make check`, `make pack`, and `git diff --check` for relevant changes.
`make check` uses Node compatibility mocks, not a running GNOME Shell. A live
Wayland check should cover Rhythmbox, a browser player, switching players,
transport controls, seeking, preferences, and disable/re-enable.

License policy: follow LICENSING.md. Prefer MIT for independent original work,
then GPL-2.0-or-later where compatible; preserve stricter upstream grants,
attribution and asset licenses. Never infer permission for unlicensed code.

## Public documentation and agent-neutral publication policy

These instructions apply to **every agent or automated workflow** that reads this repository, regardless of provider, model, tool, or execution environment. They apply to future agents as well as the current maintainer's tools. Treat all repository-visible artifacts as potentially public, including commits, PRs, issues, changelogs, release notes, comments, CI reports, examples, and documentation, even when a repository is presently private.

- **Audience:** Write for an independent reader with no access to chats, prompts, personal history, local paths, or project-specific shorthand. Describe behavior, rationale, test conditions, and limitations self-sufficiently. Do not address the maintainer as the assumed reader of public artifacts or leak internal instructions into them.
- **Evidence:** Ground claims in checked-in source, explicit approved specifications, or actual test results. Clearly distinguish a declared compatibility range from versions exercised, mock/static checks from native Shell tests, and intentions from implemented behavior. Never invent verification, security assurances, priority, or novelty claims.
- **Scope and provenance:** A conversation, prior task, local configuration, private theme, unreleased asset, or other project's files are *not* permission to add or publish them. Never import personal settings, unpublished assets, unrelated dependencies, or private conversation excerpts without explicit authorization for this repository. Preserve licensing and upstream attribution; inspect additions for secrets and identifying information.
- **Documentation ownership:** The human maintainer owns the README's introduction, user-facing feature lists, motivation, UX descriptions, and other product narrative. Agents must not draft, rewrite, reorder, or silently "improve" those sections absent explicit task-specific permission. Agents maintain implementation/architecture notes, testing instructions and results, technical compatibility details, and tightly scoped factual installation/build changes. The permission to correct a command or version does not authorize rewriting surrounding narrative.
- **Change handoff:** For every functional change, report user-visible differences, new settings, limitations, affected README claims, and any needed maintainer-authored updates. Keep that report in the task/PR handoff rather than inserting agent-written feature prose into the README. Flag incorrect protected prose and request a maintainer decision; do not quietly edit it. An inaccurate README claim must not be treated as resolved merely because an agent says documentation is complete.
- **Release discipline:** Documentation and public-facing PR/release text must be checked for audience, accuracy, provenance, and human-owned sections before publication. If user-facing documentation is pending or materially false, explicitly mark it as unresolved and use the repository's existing release-pause mechanism when available; never claim an automated gate exists unless the workflow actually enforces it. The human maintainer decides whether a narrative update is complete or unnecessary. Technical checks alone are not such approval.
- **Minimal changes:** Preserve current documentation voice and repository-specific instructions. Do not rewrite old narrative wholesale during unrelated engineering work. If unsure whether text or an asset is authorized for publication, omit it and flag the question in the handoff.
