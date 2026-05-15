---
tags: [testing]
applies_to: [feature, bugfix, test]
---

# Testing rules

- All new features must have unit tests.
- Do not mock the database in integration tests.
- Test filenames mirror the source file: `foo.ts` → `foo.test.ts`.
