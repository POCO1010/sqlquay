# Changelog

## 0.4.0 — 2026-11-11

- Rename the visible product to **SQLQuay** and the VSIX artifact to `sqlquay`.
- Keep the installed extension ID, commands, settings keys and connection storage namespace.
- Use generic local policy paths; machine-specific policy packages stay outside the repository.
- Add a public-content check and GitHub CI for unit tests and Java 8-compatible packaging.
- Document Marketplace prerequisites and publishing steps.

## 0.3.1

- Preserve unexecuted SQL edits when pinning or updating an existing result.
- Resolve aliases inside functions and correlated subqueries; scope nested CTEs correctly.
- Complete fields when an alias has the same name as the database.
- Exclude JS/TS regular expressions from embedded SQL detection.

## 0.3.0

- Add independent result panels, pinning and in-memory session history.
- Add cached table and alias-field completion and table search.
- Show measured connection, preflight and execution timings.
- Support static SQL blocks in common host languages and selected pure SQL text.
