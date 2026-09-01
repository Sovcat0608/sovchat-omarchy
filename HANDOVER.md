# SovChat Omarchy

## Ownership

This project contains both parts of the independent Omarchy app:

- the Omarchy-native bar widget and panel at the repository root;
- the dedicated SovChat Omarchy Electron client and secure user-level installer.

It has no website backend, database, VPS tooling, Windows package, or generic
Linux standalone release.

## Identity

- Package: `sovchat-omarchy`
- Client variant: `omarchy`
- App ID: `com.sovchat.omarchy`
- Executable: `SovChatOmarchy`
- Client update feed: `https://sovchat.com/desktop-updates/omarchy`
- Client version: `0.4.5`
- Plugin ID: `com.sovchat.omarchy`
- Plugin version: `0.1.3`
- GitHub repository: `https://github.com/Sovcat0608/sovchat-omarchy`

Every desktop API request identifies this project with
`X-SovChat-App-Variant: omarchy`.

## Shared services

- API: `https://sovchat.com`
- LiveKit: `wss://livekit.sovchat.com`

Only public endpoint values belong here. API/database/LiveKit server secrets
remain in the Windows/control-plane project and on their respective hosts.

## Access and releases

The shared owner dashboard controls this client independently. In `beta`
status, a user needs the Omarchy grant. `locked` blocks all Omarchy sessions
and `live` opens Omarchy to every general beta account.

The plugin installer accepts only one reviewed AppImage URL, byte count, and
SHA-512 digest. It refuses redirects, bounds transfer time and size, and
publishes files through descriptor-pinned directories without following
symlinks.

The first independent Omarchy artifact must be built before changing
`CLIENT_RELEASE_READY` in `bin/sovchat-control` to `true`. At that point,
pin the exact VPS URL, byte count, and SHA-512 from the same reviewed commit.
Do not publish the plugin or update a marketplace review while that value is
`false`.

## Development

```text
npm ci
npm run dev:desktop
npm run test:linux-package
npm run test:build-pipeline
npm run test:layout
npm run test:plugin-security
npm run build:desktop
npm run dist:omarchy
```

The Omarchy interface and iconography are unconditional. Native Hyprland
scratchpad minimize/restore behavior belongs here and nowhere else.

## Porting shared changes

Protocol, authentication, audio, and LiveKit changes may be ported from another
SovChat project only after reviewing the diff for this app. Never copy API
routes, Prisma files, credentials, deployment scripts, Windows packaging, or
generic Linux release files into this repository.
