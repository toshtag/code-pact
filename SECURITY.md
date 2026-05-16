# Security Policy

## Supported versions

`code-pact` is in alpha (`0.1.x-alpha.*`). Only the latest alpha on the npm `alpha` tag receives security fixes. Once a stable `0.1.0` ships, this section will be updated.

| Version | Supported |
|---|---|
| `0.1.x-alpha` (latest on `alpha` tag) | yes |
| older alphas | no |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security reports.

Use GitHub's Private Vulnerability Reporting:

→ https://github.com/toshtag/code-pact/security/advisories/new

Include:

- A description of the issue and its impact.
- Steps to reproduce, or a minimal proof of concept.
- Affected version(s) (`npm view code-pact version`).
- Your suggested severity, if you have one.

You should receive an acknowledgement within a few days. This is a small project, so please be patient with response times. Coordinated disclosure timelines will be agreed in the advisory thread.

## Scope

In scope:

- Command injection, path traversal, or arbitrary file write from any CLI command.
- Issues that cause `code-pact` to leak secrets from the user's filesystem outside the project directory.
- Supply chain integrity of the published `code-pact` npm package (e.g. tampered tarball, unexpected `dependencies`).

Out of scope:

- Vulnerabilities in third-party dependencies — please report those upstream (`yaml`, `zod`, etc.).
- Issues that require an attacker who already has write access to the user's `design/` directory or `.code-pact/` state.
- Reports based on outdated alpha versions when the issue is already fixed on the current `alpha` tag.

## Supply chain notes

- Releases use annotated git tags and are built locally from a clean checkout before publish.
- The published tarball shasum is recorded in the corresponding GitHub Release notes.
- 2FA (`auth-and-writes`) is enabled on the publisher's npm account.

If a published version's registry-side shasum does not match the value in its release notes, please report it via the channel above with the highest priority.
