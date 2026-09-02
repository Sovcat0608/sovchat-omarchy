#!/usr/bin/python3

import hashlib
import importlib.util
import io
import json
import os
import re
import stat
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

        self.assertEqual(manifest["version"], "0.1.4")
        self.assertRegex(control, r'readonly CLIENT_VERSION="0\.4\.6"')
        self.assertRegex(control, r'readonly CLIENT_ARTIFACT="SovChat-Omarchy-0\.4\.6-x86_64\.AppImage"')
        self.assertRegex(
            control,
            r'readonly CLIENT_URL="https://sovchat\.com/desktop-updates/omarchy/SovChat-Omarchy-0\.4\.6-x86_64\.AppImage"',
        )
        self.assertRegex(control, r'readonly CLIENT_RELEASE_READY="false"')
        self.assertRegex(control, r'readonly CLIENT_EXPECTED_BYTES=""')
        self.assertRegex(control, r'readonly CLIENT_SHA512_HEX=""')
        self.assertNotIn("${INSTALL_TARGET}.new", control)
        self.assertNotRegex(control, re.compile(r"\binstall\s+-[dm]"))
        self.assertNotIn("--location", control)


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
