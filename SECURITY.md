# Security Policy

## Supported versions

Security fixes go into the latest release. Please use the newest version.

| Version | Supported |
| ------- | --------- |
| 0.3.x   | ✅        |
| < 0.3   | ❌        |

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues.**

Report privately with the **"Report a vulnerability"** button on the repository's
**[Security](https://github.com/Shreyas1015/codeloom/security)** tab. This opens a private advisory that only
the maintainer can see.

Please include:

- what the problem is and what an attacker could do with it
- steps to reproduce (a small example repo helps)
- the codeloom version (`codeloom --version`), your OS and Node version

### What to expect

- **Acknowledgement:** within a few days.
- **Fix:** we agree on a severity together and work on a fix.
- **Disclosure:** once a fixed version is out, the advisory is published with credit to you (unless you
  prefer to stay anonymous).

## Scope

codeloom runs on your machine and reads your code. The parts that matter for security:

- **The indexer** (`codeloom index`): reads repo files and git history, writes `.codeloom/`. It runs no code
  from the repos it reads.
- **The dashboard server** (`codeloom dashboard`): listens on 127.0.0.1 only and needs the session token in
  its link. It serves files from inside the workspace repos, never `.git`, `.env*` or `.codeloom`.
- **The MCP server** (`codeloom serve`): talks to your agent over stdio and writes only into `.codeloom/`.
- **The git hook** that `codeloom init` adds, which re-indexes after each commit.
- **The trace check** (`codeloom check --traces`): the only network call, and only when you ask for it.

Reports about any of these are welcome, including unsafe defaults. Problems in a dependency should also go to
that project.

Thank you for helping keep codeloom and its users safe.
