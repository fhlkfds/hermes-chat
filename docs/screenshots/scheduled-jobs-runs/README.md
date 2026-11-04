# Scheduled jobs: runs, results, profiles and delivery (#73)

Captured on 2026-11-04 from the running Tauri debug application (WebKitGTK, frontend embedded) on an Xvfb display,
1280 × 820 unless noted. The app was signed in by URL, with the dashboard's password, to a real Hermes dashboard at
`bf0203a` serving a throwaway `HERMES_HOME` under `/tmp`, with a throwaway gateway running its scheduler. The gateway
had no messaging platforms and no provider credentials; the default profile's model was a stand-in on loopback that
answers every request with one fixed line. Every job is a synthetic `[fixture]` job made for these captures, and
every run shown was made by Hermes's scheduler (or by Run now where said). Times are the default profile's
`America/Chicago`, which is also the capturing computer's zone; the `fixture-b` profile is `Europe/London`. No visual
element was composited or retouched.

- `1-job-list.png`: the list, with each job's schedule, the schedule time zone, next run, last result and delivery.
- `2-delivery-warning.png`: a job delivering to Slack, which this profile's gateway doesn't have.
- `3-run-history-result.png`: an agent job's runs, each with its state and how long it took, and Show the result
  open on the newest: the reply read from that run's Hermes session.
- `4-failed-runs.png`: a script job whose script exits 3: each run failed, with the error Hermes recorded.
- `5-overlap-confirm.png`: Run now on a job whose 45-second run, started by another client, is under way.
- `6-overlap-refused.png`: Hermes refused the second run (409), in the app's words.
- `7-editor-other-profile.png`: New job in the `fixture-b` profile: its London schedule time zone, with this
  computer's time beside each upcoming run.
- `8-editor-summary.png`: the summary shown before anything is saved.
- `9-created-elsewhere.png`: the list after creating that job in `fixture-b`.
- `10-history-paging.png`: a job's history after Show more runs, 20 at a time.
- `11-narrow.png`: a job at the window's minimum width (760 px), with the 2:30 AM spring-forward note from the profile's real zone.
