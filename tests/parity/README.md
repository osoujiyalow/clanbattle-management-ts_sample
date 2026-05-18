# Parity Fixture Baseline

This folder holds the review-first parity baseline for the Python bot.

## Layout

- `fixtures/raw/cases.json`
  - Captured case inventory from Python source review.
  - This is the earliest baseline and may still be incomplete in detail.
- `fixtures/verified/cases.json`
  - Reviewed parity baseline used for later parity harness work.
  - F23 fixes structure, text templates, and DB invariants.
- `cases/manifest.json`
  - Source of truth for required parity case ids.

## Required Cases

The first verified baseline must cover these eight flows:

- `setup/basic`
- `add/member-self`
- `attack_declare/basic`
- `message_damage/basic`
- `attack_fin/basic`
- `defeat_boss/basic`
- `undo/basic`
- `bossinfo_edit/basic`

## Review Policy

`raw` is only a capture artifact.

`verified` must satisfy all of the following:

- Python source references are present.
- UI review is marked complete.
- DB review is marked complete.
- The case is listed in `cases/manifest.json`.

## Scope Of F23

F23 intentionally stores a structural baseline:

- UI: message sequence, visibility, channel order, reaction set, text templates.
- DB: touched tables, row deltas, invariants.

Executable replay for the required major cases now lives in `snapshots/major-cases.json`.

TS-only features that do not exist in the Python review baseline, such as boss-scoped undo behavior and the correction slash commands, are verified in the integration suites rather than added to the required parity manifest.
