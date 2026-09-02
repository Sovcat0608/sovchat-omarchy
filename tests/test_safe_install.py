#!/usr/bin/python3

import hashlib
import importlib.util
import io
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


HELPER_PATH = Path(__file__).resolve().parents[1] / "bin" / "sovchat-safe-install.py"
SPEC = importlib.util.spec_from_file_location("sovchat_safe_install", HELPER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load the SovChat secure installer")
INSTALLER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = INSTALLER
SPEC.loader.exec_module(INSTALLER)


class ReviewedSnapshotTests(unittest.TestCase):
    def test_manifest_and_client_identity_are_immutable(self):
        plugin_root = HELPER_PATH.parents[1]
        manifest = json.loads((plugin_root / "manifest.json").read_text(encoding="utf-8"))
        control = (plugin_root / "bin/sovchat-control").read_text(encoding="utf-8")
        widget = (plugin_root / "BarWidget.qml").read_text(encoding="utf-8")
        panel = (plugin_root / "Panel.qml").read_text(encoding="utf-8")

        self.assertEqual(manifest["version"], "0.1.4")
        self.assertRegex(control, r'readonly CLIENT_VERSION="0\.4\.7"')
        self.assertRegex(control, r'readonly CLIENT_ARTIFACT="SovChat-Omarchy-0\.4\.7-x86_64\.AppImage"')
        self.assertRegex(
            control,
            r'readonly CLIENT_URL="https://sovchat\.com/desktop-updates/omarchy/SovChat-Omarchy-0\.4\.7-x86_64\.AppImage"',
        )
        self.assertRegex(control, r'readonly CLIENT_RELEASE_READY="true"')
        self.assertRegex(control, r'readonly CLIENT_EXPECTED_BYTES="129110268"')
        self.assertRegex(control, r'readonly CLIENT_SHA512_HEX="48540f5f2f0882990dd6e1ccc5f8eb7c2c60efe65f14a426e40593561e3ff82d3a36f8184f8a4007cf37ecc3cee1e6180a255f83a222eb3792c18b3aae7aa229"')
        self.assertNotIn("${INSTALL_TARGET}.new", control)
        self.assertNotRegex(control, re.compile(r"\binstall\s+-[dm]"))
        self.assertNotIn("--location", control)
        self.assertIn('readonly LEGACY_INSTALL_TARGET="${LEGACY_INSTALL_DIR}/SovChat.AppImage"', control)
        self.assertIn('probeProcess.command = ["bash", helperPath, "status-v2", executableOverride]', widget)
        self.assertIn('replace(/[\\r\\n]+$/, "").split("\\n")', widget)
        self.assertNotIn('.trim().split("\\n")', widget)
        self.assertIn('"STANDALONE FOUND"', panel)
        self.assertIn('"INSTALL OMARCHY EDITION"', panel)
        self.assertIn('text: "PLUGIN 0.1.4"', panel)
        self.assertIn("fields.length === 7", widget)
        self.assertIn('(fields[0] === "1") === (fields[3] !== "")', widget)
        self.assertIn('(fields[4] === "1") === (fields[6] !== "")', widget)
        self.assertIn('readonly property bool statusReady: probed && !probing && lastError === ""', widget)
        self.assertIn('[[ "${candidate}" == "${LEGACY_INSTALL_TARGET}" ]] && return 0', control)
        self.assertIn("legacyClientInstalled && !clientInstalled && !clientRunning", widget)
        self.assertIn("The SovChat plugin update is incomplete.", widget)
        self.assertIn("enabled: !root.busy && root.actionsReady", panel)
        self.assertIn("migrationRequired && hostWidget ? hostWidget.legacyClientPath", panel)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux process and inode semantics required")
class LegacyClientMigrationStatusTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sovchat-legacy-status-")
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.control = HELPER_PATH.with_name("sovchat-control")
        self.legacy_marker = self.root / "legacy-executed"
        self.new_marker = self.root / "omarchy-executed"
        self.fake_bin = self.root / "fake-bin"
        self.fake_bin.mkdir(mode=0o700)
        for command_name in ("pgrep", "ps", "hyprctl"):
            stub = self.fake_bin / command_name
            stub.write_text("#!/usr/bin/bash\nexit 1\n", encoding="ascii")
            stub.chmod(0o700)

    def tearDown(self):
        self.temporary.cleanup()

    def make_executable(self, path, marker):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_text(f"#!/usr/bin/bash\nprintf 'executed\\n' >> '{marker}'\n", encoding="utf-8")
        path.chmod(0o700)
        return path

    def make_legacy_client(self):
        target = self.make_executable(
            self.home / ".local/opt/sovchat/SovChat.AppImage",
            self.legacy_marker,
        )
        (target.parent / "VERSION").write_text("0.4.5\n", encoding="ascii")
        return target

    def make_omarchy_client(self):
        target = self.make_executable(
            self.home / ".local/opt/sovchat-omarchy/SovChat-Omarchy.AppImage",
            self.new_marker,
        )
        (target.parent / "VERSION").write_text("0.4.7\n", encoding="ascii")
        return target

    def run_helper(self, action, override=None):
        command = ["/usr/bin/bash", str(self.control), action]
        if override is not None:
            command.append(str(override))
        environment = os.environ.copy()
        environment["HOME"] = str(self.home)
        environment["PATH"] = f"{self.fake_bin}:/usr/bin:/bin"
        return subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            env=environment,
            timeout=5,
        )

    def status_fields(self, action="status-v2", override=None):
        result = self.run_helper(action, override)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.rstrip("\n").split("\t")

    def test_four_field_status_remains_compatible_and_v2_reports_legacy(self):
        legacy = self.make_legacy_client()

        self.assertEqual(self.status_fields("status"), ["0", "0", "", ""])
        self.assertEqual(
            self.status_fields(),
            ["0", "0", "", "", "1", "0.4.5", str(legacy)],
        )
        self.assertFalse(self.legacy_marker.exists())

    def test_exact_symlink_and_hardlink_legacy_overrides_are_rejected(self):
        legacy = self.make_legacy_client()
        symlink = self.root / "legacy-symlink"
        hardlink = self.root / "legacy-hardlink"
        symlink.symlink_to(legacy)
        os.link(legacy, hardlink)

        for candidate in (legacy, symlink, hardlink):
            with self.subTest(candidate=candidate):
                fields = self.status_fields(override=candidate)
                self.assertEqual(fields[0], "0")
                self.assertEqual(fields[4], "1")
                result = self.run_helper("launch", candidate)
                self.assertEqual(result.returncode, 3)

        self.assertFalse(self.legacy_marker.exists())

    def test_managed_client_wins_when_legacy_override_is_saved(self):
        legacy = self.make_legacy_client()
        managed = self.make_omarchy_client()

        fields = self.status_fields(override=legacy)
        self.assertEqual(fields, ["1", "0", "0.4.7", str(managed), "1", "0.4.5", str(legacy)])
        self.assertFalse(self.legacy_marker.exists())
        self.assertFalse(self.new_marker.exists())

    def test_nonlegacy_custom_override_remains_supported(self):
        custom = self.make_executable(self.root / "custom-client", self.new_marker)
        fields = self.status_fields(override=custom)
        self.assertEqual(fields[0], "1")
        self.assertEqual(fields[3], str(custom))
        self.assertEqual(fields[4], "0")
        self.assertFalse(self.new_marker.exists())


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux filesystem semantics required")
@unittest.skipIf(os.getuid() == 0, "Installer intentionally refuses root")
class SafeInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sovchat-safe-install-")
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.icon = self.root / "sovchat.svg"
        self.icon.write_bytes(b"<svg xmlns='http://www.w3.org/2000/svg'/>\n")
        self.payload = b"reviewed-sovchat-appimage-payload"

    def tearDown(self):
        self.temporary.cleanup()

    def config(self, *, digest=None):
        return INSTALLER.InstallConfig(
            home=str(self.home),
            version="9.8.7",
            expected_bytes=len(self.payload),
            maximum_bytes=1024,
            sha512_hex=digest or hashlib.sha512(self.payload).hexdigest(),
            icon_path=str(self.icon),
        )

    def install(self, *, digest=None):
        return INSTALLER.install_from_stream(self.config(digest=digest), io.BytesIO(self.payload))

    def test_installs_verified_files_with_expected_modes(self):
        target = Path(self.install())

        self.assertEqual(target.read_bytes(), self.payload)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o755)
        self.assertEqual((target.parent / "VERSION").read_text(encoding="ascii"), "9.8.7\n")
        self.assertEqual(
            (self.home / ".local/share/icons/hicolor/scalable/apps/com.sovchat.omarchy.svg").read_bytes(),
            self.icon.read_bytes(),
        )
        desktop = self.home / ".local/share/applications/com.sovchat.omarchy.desktop"
        self.assertIn(f'Exec="{target}"', desktop.read_text(encoding="utf-8"))

    def test_install_preserves_legacy_client_bytes_and_metadata(self):
        legacy = self.home / ".local/opt/sovchat/SovChat.AppImage"
        legacy.parent.mkdir(parents=True, mode=0o700)
        legacy.write_bytes(b"legacy-client")
        legacy.chmod(0o700)
        before = legacy.stat()

        self.install()

        after = legacy.stat()
        self.assertEqual(legacy.read_bytes(), b"legacy-client")
        self.assertEqual(after.st_ino, before.st_ino)
        self.assertEqual(stat.S_IMODE(after.st_mode), stat.S_IMODE(before.st_mode))
        self.assertEqual(after.st_mtime_ns, before.st_mtime_ns)

    def test_checksum_failure_preserves_existing_client(self):
        target = self.home / ".local/opt/sovchat-omarchy/SovChat-Omarchy.AppImage"
        target.parent.mkdir(parents=True, mode=0o700)
        target.write_bytes(b"existing-client")
        wrong_digest = hashlib.sha512(b"different-payload").hexdigest()

        with self.assertRaises(INSTALLER.InstallError):
            self.install(digest=wrong_digest)

        self.assertEqual(target.read_bytes(), b"existing-client")

    def test_symlinked_destination_directory_is_rejected(self):
        victim = self.root / "victim-directory"
        victim.mkdir()
        (self.home / ".local").symlink_to(victim, target_is_directory=True)

        with self.assertRaises(INSTALLER.InstallError):
            self.install()

        self.assertEqual(list(victim.iterdir()), [])

    def test_final_symlink_is_replaced_without_touching_its_target(self):
        victim = self.root / "victim-file"
        victim.write_bytes(b"do-not-touch")
        target = self.home / ".local/opt/sovchat-omarchy/SovChat-Omarchy.AppImage"
        target.parent.mkdir(parents=True, mode=0o700)
        target.symlink_to(victim)

        self.install()

        self.assertFalse(target.is_symlink())
        self.assertEqual(target.read_bytes(), self.payload)
        self.assertEqual(victim.read_bytes(), b"do-not-touch")

    def test_swapped_pinned_directory_cannot_redirect_publication(self):
        app_path = self.home / ".local/opt/sovchat-omarchy"
        app_path.mkdir(parents=True, mode=0o700)
        held_path = app_path.with_name("sovchat-omarchy-held")
        victim = self.root / "victim-directory"
        victim.mkdir()

        home_chain = INSTALLER.open_home_chain(str(self.home))
        app_chain = INSTALLER.open_user_tree(
            home_chain.fd,
            ((".local", 0o700), ("opt", 0o700), ("sovchat-omarchy", 0o700)),
            "test application directory",
        )
        staged = INSTALLER.stage_bytes(app_chain.fd, b"safe", 0o644)
        try:
            app_path.rename(held_path)
            app_path.symlink_to(victim, target_is_directory=True)
            with self.assertRaises(INSTALLER.InstallError):
                INSTALLER.publish_unnamed_file(app_chain, "VERSION", staged)
        finally:
            os.close(staged)
            app_chain.close()
            home_chain.close()

        self.assertFalse((victim / "VERSION").exists())
        self.assertFalse((held_path / "VERSION").exists())

    def test_concurrent_final_creation_blocks_publication(self):
        app_path = self.home / ".local/opt/sovchat-omarchy"
        app_path.mkdir(parents=True, mode=0o700)
        victim = self.root / "victim-file"
        victim.write_bytes(b"do-not-touch")

        home_chain = INSTALLER.open_home_chain(str(self.home))
        app_chain = INSTALLER.open_user_tree(
            home_chain.fd,
            ((".local", 0o700), ("opt", 0o700), ("sovchat-omarchy", 0o700)),
            "test application directory",
        )
        staged = INSTALLER.stage_bytes(app_chain.fd, b"safe", 0o644)
        original_link = INSTALLER._link_unnamed_file

        def inject_symlink(source_fd, destination_fd, name):
            os.symlink(str(victim), name, dir_fd=destination_fd)
            original_link(source_fd, destination_fd, name)

        try:
            with mock.patch.object(INSTALLER, "_link_unnamed_file", side_effect=inject_symlink):
                with self.assertRaises(INSTALLER.InstallError):
                    INSTALLER.publish_unnamed_file(app_chain, "VERSION", staged)
        finally:
            os.close(staged)
            app_chain.close()
            home_chain.close()

        self.assertEqual(victim.read_bytes(), b"do-not-touch")
        self.assertTrue((app_path / "VERSION").is_symlink())


if __name__ == "__main__":
    unittest.main()
