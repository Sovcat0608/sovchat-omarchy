# SovChat Omarchy

## Ownership

This project contains both parts of the independent Omarchy app:

- the Omarchy-native bar widget and panel at the repository root;
- the dedicated SovChat Omarchy Electron client and secure user-level installer.

It has no website backend, database, Windows package, or generic Linux
standalone release. Its only VPS tooling is the fingerprint-pinned publisher
for this client's static update-feed directory.

## Identity

- Package: `sovchat-omarchy`
- Client variant: `omarchy`
- App ID: `com.sovchat.omarchy`
- Executable: `SovChatOmarchy`
- Client update feed: `https://sovchat.com/desktop-updates/omarchy`
- Client version: `0.4.7`
- Plugin ID: `com.sovchat.omarchy`
- Plugin version: `0.1.4`
- GitHub repository: `https://github.com/Sovcat0608/sovchat-omarchy`

Every desktop API request identifies this project with
`X-SovChat-App-Variant: omarchy`.

## Shared services

- API: `https://sovchat.com`
- LiveKit: `wss://livekit.sovchat.com`

Only public endpoint values belong here. API/database/LiveKit server secrets
remain in the Windows/control-plane project and on their respective hosts.

## Access and releases

SovChat accounts and beta access are shared across Windows, Linux, Omarchy, and
the web app. A user with SovChat beta access can sign in here without a
separate Omarchy account or grant.

The shared owner dashboard controls only this client's release gate
independently. `locked` blocks all Omarchy sessions; `beta` and `live` allow
any account with shared SovChat beta access. Windows and Linux release states
have no effect on this client.

The plugin installer accepts only one reviewed AppImage URL, byte count, and
SHA-512 digest. It refuses redirects, bounds transfer time and size, and
publishes files through descriptor-pinned directories without following
symlinks.

The first independent Omarchy artifact must be built before changing
`CLIENT_RELEASE_READY` in `bin/sovchat-control` to `true`. At that point,
pin the exact VPS URL, byte count, and SHA-512 from the same reviewed commit.
Do not publish the plugin or update a marketplace review while that value is
`false`.

### Publishing a client update

A stable tag must be exactly `v` plus the version in `package.json`. The tagged
GitHub Actions run is the source of the AppImage, portable archive,
`latest-linux.yml`, and `SHA512SUMS`; do not publish a locally rebuilt substitute.

The deployment environment file stays outside this repository and supplies the
VPS host, port, unprivileged `codex` user, private-key path, `/opt/sovchat` app
directory, and independently verified SSH host fingerprint. Check access before
downloading or publishing a release:

```text
SOVCHAT_DEPLOY_ENV_FILE=/secure/path/deploy.env npm run publish:omarchy-update:preflight
```

After downloading the exact successful tag-run artifact into
`release/omarchy`, run `npm run verify:omarchy-release`, then:

```text
SOVCHAT_DEPLOY_ENV_FILE=/secure/path/deploy.env npm run publish:omarchy-update
```

The publisher uploads and verifies the versioned AppImage before atomically
replacing `latest-linux.yml`, then downloads both public responses with strict
size, timeout, and SHA-512 checks. It rolls the manifest back on a failed public
postflight and preserves the remote lock and backup if rollback cannot be
confirmed. Once the public bytes are verified, pin the same AppImage's lowercase
hex SHA-512 and exact byte count in `bin/sovchat-control`, set
`CLIENT_RELEASE_READY=true`, rerun the security/update suites, and publish the
plugin revision.

## Development

```text
npm ci
npm run dev:desktop
npm run test:linux-package
npm run test:desktop-updates
npm run test:release-tools
npm run test:build-pipeline
npm run test:layout
npm run test:plugin-security
npm run build:desktop
npm run dist:omarchy
```

The Omarchy interface and iconography are unconditional. Native Hyprland
scratchpad minimize/restore behavior belongs here and nowhere else.

Omarchy screen capture has two platform invariants:

- keep the default Xwayland backend unless native Wayland is deliberately being
  diagnosed;
- on Wayland/PipeWire, enumerate desktop sources once per picker attempt and
  grant the retained `DesktopCapturerSource` object without looking it up again.

Linux system-audio loopback is not offered. Before a release, smoke-test both a
monitor and an application-window share on a real Omarchy/Hyprland session.

## Porting shared changes

Protocol, authentication, audio, and LiveKit changes may be ported from another
SovChat project only after reviewing the diff for this app. Never copy API
routes, Prisma files, credentials, general server deployment scripts, Windows
packaging, or generic Linux release files into this repository. Keep the scoped
Omarchy update-feed publisher independent of application/server deployment.
