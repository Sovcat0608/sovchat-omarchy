# SovChat Omarchy

Independent SovChat app and native plugin for Omarchy.

- Omarchy bar widget and control panel
- Dedicated `omarchy` client/release lane
- Native Hyprland scratchpad behavior
- Descriptor-safe, digest-pinned user installer

## Requirements

- Omarchy Quattro with third-party plugin support
- a SovChat account; anyone can sign up while the server-enforced 500-account
  capacity has space
- `bash`, Python 3, and `curl` for the user-level client installer
- optional `fuse2` support if the AppImage runtime is not already available

The plugin and client run as the signed-in user. They do not require `sudo` or
modify system configuration.

## Install

```bash
omarchy plugin add https://github.com/Sovcat0608/sovchat-omarchy-plugin.git --enable
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

Marketplace plugin 0.1.3 and earlier installed the generic standalone Linux
client, which uses a different update channel. Plugin 0.1.4 detects that exact
legacy target and shows **Standalone found**. Choose **Install Omarchy edition**
to install the independent Omarchy client alongside it. The legacy AppImage is
not opened, changed, or removed. Once installed, the Omarchy edition receives
the normal in-app update pings described above.

The standalone Linux update feed must not be redirected to the Omarchy feed.

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

If this machine migrated from marketplace plugin 0.1.3 or earlier, the old
standalone client may remain alongside the Omarchy edition. After confirming
the Omarchy edition works, it can be removed separately with:

```bash
rm -rf -- "$HOME/.local/opt/sovchat"
rm -f -- "$HOME/.local/share/applications/com.sovchat.desktop.desktop"
rm -f -- "$HOME/.local/share/icons/hicolor/scalable/apps/com.sovchat.desktop.svg"
```

Do not run those legacy cleanup commands for a separately managed Linux client.

SovChat connects only to `https://sovchat.com` and
`wss://livekit.sovchat.com`. The repository is licensed under MIT; see
[LICENSE](LICENSE).

See [HANDOVER.md](HANDOVER.md) for development, release, and ownership details.
