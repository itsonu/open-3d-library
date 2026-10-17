# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |

Only the latest 0.1.x release gets fixes.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a vulnerability.

Include the version or commit, steps to reproduce, and, if the problem involves a file, the file or a minimal version of it. Do not send files you do not have the right to share.

This is a volunteer project. Response times are best-effort: expect an acknowledgement within about a week and a fix or a decision as soon as it can be done.

## Scope

In scope:

- **Parsing untrusted files in the browser.** The app opens GLB/glTF, FBX, OBJ/MTL, VMD and image files that can come from anywhere. Crashes that lead to code execution, script injection (XSS) through file names, metadata, material or mesh names, `catalog.json` fields or the inspector, and parser bugs with security impact are in scope. Plain crashes or out-of-memory on malformed files are bugs; report them as normal issues unless they have security impact.
- **`serve.py`.** Path traversal, serving dotfiles or files outside `dist/` and the asset folder, bypassing the Host check, or unauthenticated writes beyond the capped thumbnail upload.
- The build and the code in this repository.

Notes:

- `serve.py` is for local use only. It binds to loopback (`127.0.0.1`) by default and checks the `Host` header. Binding to other interfaces with `--host` exposes your asset folder to the network and is at your own risk. There is no authentication or TLS. Do not run it as a public web server.
- Vendored third-party code (see `THIRD_PARTY_NOTICES.md`) should be reported upstream as well when the bug is in the upstream code.
- The app runs locally and loads no code from CDNs at runtime. Reports that depend on a hosting environment you control (for example missing HTTP headers on your own server) are out of scope.
