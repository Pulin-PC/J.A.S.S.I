# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

Only the Windows installer (`JASSI-windows-setup.exe`) and the `jassi.exe` app inside it are signed. Both are built by the [Desktop release](.github/workflows/desktop-release.yml) GitHub Actions workflow on GitHub-hosted runners, from the source code in this repository. Nothing built anywhere else is signed.

## Team roles

| Role | Members |
| --- | --- |
| Committers and reviewers | [Pulin-PC](https://github.com/Pulin-PC) |
| Approvers | [Pulin-PC](https://github.com/Pulin-PC) |

Every signing request is approved by hand. All team members use multi-factor authentication on GitHub and SignPath.

## Privacy

J.A.S.S.I sends data only to the services needed for what you ask it to do:

- The J.A.S.S.I server (`jassi.pulin-chaudhari.workers.dev`), which handles your requests.
- Google, to sign you in and, if you allow it, to use your Google services such as Gmail.
- Apps and websites you ask J.A.S.S.I to open or use, such as WhatsApp, Spotify or Swiggy.

It sends nothing to any other networked system unless you ask it to. The installer adds a normal uninstaller under **Settings → Apps**.
