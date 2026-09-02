# SovChat Omarchy

Independent SovChat app and native plugin for Omarchy.

- Omarchy bar widget and control panel
- Dedicated `omarchy` client/release lane
- Native Hyprland scratchpad behavior
- Descriptor-safe, digest-pinned user installer

## Requirements

- Omarchy Quattro with third-party plugin support
- a SovChat account with beta access
- `bash`, Python 3, and `curl` for the user-level client installer
- optional `fuse2` support if the AppImage runtime is not already available

The plugin and client run as the signed-in user. They do not require `sudo` or
modify system configuration.

## Install

```bash
omarchy plugin add https://github.com/Sovcat0608/sovchat-omarchy.git --enable
```

Open the SovChat bar widget and choose **Install client**. The installer accepts
only the reviewed versioned AppImage URL, exact byte count, and SHA-512 digest.
It writes the client, desktop entry, and icon beneath the current user's
`~/.local` directory.

## Updates

Update the plugin checkout with:

```bash
omarchy plugin update --yes
```

The installed AppImage checks SovChat's Omarchy-only update feed shortly after
launch, hourly, and after resume or unlock. It downloads newer stable versions
in the background and offers **Update now** when ready.

## Remove

Remove the Omarchy plugin with:

```bash
omarchy plugin remove com.sovchat.omarchy --yes
```

The desktop client is deliberately kept when the widget is removed. To remove
the client too, close SovChat and delete only its owned user-level targets:

```bash
rm -rf -- "$HOME/.local/opt/sovchat-omarchy"
rm -f -- "$HOME/.local/share/applications/com.sovchat.omarchy.desktop"
rm -f -- "$HOME/.local/share/icons/hicolor/scalable/apps/com.sovchat.omarchy.svg"
```

SovChat connects only to `https://sovchat.com` and
`wss://livekit.sovchat.com`. The repository is licensed under MIT; see
[LICENSE](LICENSE).

See [HANDOVER.md](HANDOVER.md) for development, release, and ownership details.
