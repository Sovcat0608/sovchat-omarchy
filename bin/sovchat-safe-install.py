#!/usr/bin/python3

import argparse
import ctypes
import errno
import fcntl
import hashlib
import io
import os
import re
import stat
import sys
from contextlib import ExitStack
from dataclasses import dataclass


APP_ID = "com.sovchat.omarchy"
APP_NAME = "SovChat Omarchy"
BUFFER_SIZE = 1024 * 1024
AT_FDCWD = -100
AT_SYMLINK_FOLLOW = 0x400
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW


class InstallError(RuntimeError):
    pass


@dataclass(frozen=True)
class InstallConfig:
    home: str
    version: str
    expected_bytes: int
    maximum_bytes: int
    sha512_hex: str
    icon_path: str


class DirectoryChain:
    def __init__(self, initial_fd: int, label: str):
        self.label = label
        self.fds = [initial_fd]
        self.bindings: list[tuple[int, str, int]] = []

    @property
    def fd(self) -> int:
        return self.fds[-1]

    def descend(self, name: str, *, create: bool, mode: int, require_user_owner: bool) -> None:
        _validate_leaf_name(name)
        parent_fd = self.fd
        child_fd = _open_child_directory(parent_fd, name, create=create, mode=mode)
        try:
            _validate_directory(
                child_fd,
                f"{self.label}/{name}",
                require_user_owner=require_user_owner,
            )
        except Exception:
            os.close(child_fd)
            raise
        self.fds.append(child_fd)
        self.bindings.append((parent_fd, name, child_fd))

    def verify(self) -> None:
        for parent_fd, name, child_fd in self.bindings:
            try:
                visible = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except OSError as error:
                raise InstallError(
                    f"Pinned {self.label} directory changed during installation: {name}"
                ) from error
            pinned = os.fstat(child_fd)
            if not stat.S_ISDIR(visible.st_mode) or (
                visible.st_dev,
                visible.st_ino,
            ) != (pinned.st_dev, pinned.st_ino):
                raise InstallError(
                    f"Pinned {self.label} directory changed during installation: {name}"
                )

    def close(self) -> None:
        for descriptor in reversed(self.fds):
            try:
                os.close(descriptor)
            except OSError:
                pass
        self.fds.clear()
        self.bindings.clear()


def _validate_leaf_name(name: str) -> None:
    if not name or name in {".", ".."} or "/" in name or "\x00" in name:
        raise InstallError(f"Unsafe installer path component: {name!r}")


def _validate_directory(fd: int, label: str, *, require_user_owner: bool) -> None:
    details = os.fstat(fd)
    if not stat.S_ISDIR(details.st_mode):
        raise InstallError(f"{label} is not a directory")
    if require_user_owner and details.st_uid != os.getuid():
        raise InstallError(f"{label} is not owned by the current user")
    if require_user_owner and details.st_mode & 0o022:
        raise InstallError(f"{label} is writable by another local identity")


def _open_child_directory(parent_fd: int, name: str, *, create: bool, mode: int) -> int:
    for _ in range(4):
        try:
            return os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
        except FileNotFoundError:
            if not create:
                raise InstallError(f"Required directory does not exist: {name}") from None
            try:
                os.mkdir(name, mode=mode, dir_fd=parent_fd)
            except FileExistsError:
                continue
        except OSError as error:
            if error.errno in {errno.ELOOP, errno.ENOTDIR}:
                raise InstallError(f"Refusing symlinked installer directory: {name}") from error
            raise
    raise InstallError(f"Installer directory changed repeatedly: {name}")


def open_home_chain(home: str) -> DirectoryChain:
    if not home or not os.path.isabs(home) or any(character in home for character in "\x00\r\n"):
        raise InstallError("HOME must be a clean absolute path")
    normalized = os.path.normpath(home)
    if normalized == "/":
        raise InstallError("Refusing to install into the filesystem root")

    chain = DirectoryChain(os.open("/", DIRECTORY_FLAGS), "HOME")
    try:
        for component in normalized.split("/"):
            if component:
                chain.descend(
                    component,
                    create=False,
                    mode=0o700,
                    require_user_owner=False,
                )
        _validate_directory(chain.fd, "HOME", require_user_owner=True)
        chain.verify()
        return chain
    except Exception:
        chain.close()
        raise


def open_user_tree(home_fd: int, components: tuple[tuple[str, int], ...], label: str) -> DirectoryChain:
    chain = DirectoryChain(os.dup(home_fd), label)
    try:
        for name, mode in components:
            chain.descend(name, create=True, mode=mode, require_user_owner=True)
        chain.verify()
        return chain
    except Exception:
        chain.close()
        raise


def acquire_install_lock(directory_fd: int) -> int:
    name = ".install.lock"
    flags = os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW
    try:
        descriptor = os.open(name, flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory_fd)
    except FileExistsError:
        try:
            descriptor = os.open(name, flags, dir_fd=directory_fd)
        except OSError as error:
            raise InstallError("The SovChat install lock is not a regular file") from error

    try:
        details = os.fstat(descriptor)
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != os.getuid()
            or details.st_nlink != 1
            or details.st_mode & 0o077
        ):
            raise InstallError("The SovChat install lock has unsafe ownership or permissions")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise InstallError("Another SovChat installation is already running") from error
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _open_unnamed_output(directory_fd: int, mode: int) -> int:
    if not hasattr(os, "O_TMPFILE"):
        raise InstallError("This Linux runtime does not support unnamed temporary files")
    try:
        descriptor = os.open(
            ".",
            os.O_WRONLY | os.O_CLOEXEC | os.O_TMPFILE,
            mode,
            dir_fd=directory_fd,
        )
    except OSError as error:
        if error.errno in {errno.EISDIR, errno.EOPNOTSUPP, errno.EINVAL}:
            raise InstallError(
                "The SovChat install filesystem does not support secure unnamed temporary files"
            ) from error
        raise
    os.fchmod(descriptor, mode)
    return descriptor


def _write_all(descriptor: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise InstallError("Unable to write the staged SovChat file")
        view = view[written:]


def stage_verified_stream(
    directory_fd: int,
    stream: io.BufferedReader,
    *,
    expected_bytes: int,
    maximum_bytes: int,
    expected_sha512: str,
    mode: int,
) -> int:
    descriptor = _open_unnamed_output(directory_fd, mode)
    digest = hashlib.sha512()
    total = 0
    try:
        while True:
            chunk = stream.read(BUFFER_SIZE)
            if not chunk:
                break
            total += len(chunk)
            if total > maximum_bytes:
                raise InstallError("The downloaded SovChat artifact exceeded the size ceiling")
            _write_all(descriptor, chunk)
            digest.update(chunk)

        if total != expected_bytes:
            raise InstallError("The downloaded SovChat artifact size did not match the reviewed release")
        if digest.hexdigest() != expected_sha512:
            raise InstallError("The downloaded SovChat checksum did not match the reviewed release")

        os.fsync(descriptor)
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def stage_bytes(directory_fd: int, payload: bytes, mode: int) -> int:
    descriptor = _open_unnamed_output(directory_fd, mode)
    try:
        _write_all(descriptor, payload)
        os.fsync(descriptor)
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _remove_existing_leaf(directory_fd: int, name: str) -> None:
    try:
        details = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if stat.S_ISDIR(details.st_mode):
        raise InstallError(f"Refusing to replace a directory at the SovChat target: {name}")
    if details.st_uid != os.getuid():
        raise InstallError(f"Refusing to replace a file owned by another identity: {name}")
    try:
        os.unlink(name, dir_fd=directory_fd)
    except FileNotFoundError:
        pass


def _link_unnamed_file(source_fd: int, destination_fd: int, name: str) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    linkat = libc.linkat
    linkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    linkat.restype = ctypes.c_int
    source = os.fsencode(f"/proc/self/fd/{source_fd}")
    destination = os.fsencode(name)
    result = linkat(AT_FDCWD, source, destination_fd, destination, AT_SYMLINK_FOLLOW)
    if result != 0:
        error_number = ctypes.get_errno()
        if error_number == errno.EEXIST:
            raise InstallError(f"SovChat target changed during publication: {name}")
        raise OSError(error_number, os.strerror(error_number), name)


def publish_unnamed_file(chain: DirectoryChain, name: str, source_fd: int) -> None:
    _validate_leaf_name(name)
    chain.verify()
    expected = os.fstat(source_fd)
    _remove_existing_leaf(chain.fd, name)
    _link_unnamed_file(source_fd, chain.fd, name)
    os.fsync(chain.fd)
    chain.verify()

    visible = os.stat(name, dir_fd=chain.fd, follow_symlinks=False)
    if not stat.S_ISREG(visible.st_mode) or (visible.st_dev, visible.st_ino) != (
        expected.st_dev,
        expected.st_ino,
    ):
        raise InstallError(f"Published SovChat target was replaced concurrently: {name}")


def publish_bytes(chain: DirectoryChain, name: str, payload: bytes, mode: int) -> None:
    descriptor = stage_bytes(chain.fd, payload, mode)
    try:
        publish_unnamed_file(chain, name, descriptor)
    finally:
        os.close(descriptor)


def read_regular_file(path: str, maximum_bytes: int) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except OSError as error:
        raise InstallError(f"Unable to open the bundled SovChat icon safely: {path}") from error
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_size > maximum_bytes:
            raise InstallError("The bundled SovChat icon is not a small regular file")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(BUFFER_SIZE, maximum_bytes - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > maximum_bytes:
                raise InstallError("The bundled SovChat icon exceeded its size ceiling")
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def desktop_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`").replace("$", "\\$")
    return f'"{escaped}"'


def desktop_entry(install_target: str, version: str) -> bytes:
    quoted_target = desktop_quote(install_target)
    return (
        "[Desktop Entry]\n"
        "Type=Application\n"
        f"Name={APP_NAME}\n"
        "Comment=Private voice, chat, and screen sharing\n"
        f"Exec={quoted_target}\n"
        f"TryExec={quoted_target}\n"
        f"Icon={APP_ID}\n"
        "Terminal=false\n"
        "Categories=Network;Chat;\n"
        f"StartupWMClass={APP_ID}\n"
        f"X-AppImage-Version={version}\n"
    ).encode("utf-8")


def validate_config(config: InstallConfig) -> None:
    if os.name != "posix" or not sys.platform.startswith("linux"):
        raise InstallError("The secure SovChat installer requires Linux")
    if os.getuid() == 0 or os.geteuid() != os.getuid():
        raise InstallError("The SovChat installer must run as an unprivileged user")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-.+][0-9A-Za-z.-]+)?", config.version):
        raise InstallError("The reviewed SovChat version is invalid")
    if not re.fullmatch(r"[0-9a-f]{128}", config.sha512_hex):
        raise InstallError("The reviewed SovChat checksum is invalid")
    if config.expected_bytes <= 0 or config.maximum_bytes < config.expected_bytes:
        raise InstallError("The reviewed SovChat size limits are invalid")


def install_from_stream(config: InstallConfig, stream: io.BufferedReader) -> str:
    validate_config(config)
    previous_umask = os.umask(0o077)
    try:
        with ExitStack() as resources:
            home_chain = open_home_chain(config.home)
            resources.callback(home_chain.close)

            app_chain = open_user_tree(
                home_chain.fd,
                ((".local", 0o700), ("opt", 0o700), ("sovchat-omarchy", 0o700)),
                "SovChat Omarchy application directory",
            )
            resources.callback(app_chain.close)
            icon_chain = open_user_tree(
                home_chain.fd,
                (
                    (".local", 0o700),
                    ("share", 0o700),
                    ("icons", 0o700),
                    ("hicolor", 0o700),
                    ("scalable", 0o700),
                    ("apps", 0o700),
                ),
                "SovChat icon directory",
            )
            resources.callback(icon_chain.close)
            desktop_chain = open_user_tree(
                home_chain.fd,
                ((".local", 0o700), ("share", 0o700), ("applications", 0o700)),
                "SovChat desktop entry directory",
            )
            resources.callback(desktop_chain.close)

            lock_fd = acquire_install_lock(app_chain.fd)
            resources.callback(os.close, lock_fd)
            icon_payload = read_regular_file(config.icon_path, 1024 * 1024)
            install_target = os.path.join(
                config.home,
                ".local",
                "opt",
                "sovchat-omarchy",
                "SovChat-Omarchy.AppImage",
            )
            desktop_payload = desktop_entry(install_target, config.version)

            artifact_fd = stage_verified_stream(
                app_chain.fd,
                stream,
                expected_bytes=config.expected_bytes,
                maximum_bytes=config.maximum_bytes,
                expected_sha512=config.sha512_hex,
                mode=0o755,
            )
            try:
                publish_unnamed_file(app_chain, "SovChat-Omarchy.AppImage", artifact_fd)
            finally:
                os.close(artifact_fd)

            publish_bytes(app_chain, "VERSION", f"{config.version}\n".encode("ascii"), 0o644)
            publish_bytes(icon_chain, f"{APP_ID}.svg", icon_payload, 0o644)
            publish_bytes(desktop_chain, f"{APP_ID}.desktop", desktop_payload, 0o644)

            home_chain.verify()
            app_chain.verify()
            icon_chain.verify()
            desktop_chain.verify()
            return install_target
    finally:
        os.umask(previous_umask)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install one reviewed SovChat AppImage stream")
    parser.add_argument("--version", required=True)
    parser.add_argument("--expected-bytes", required=True, type=int)
    parser.add_argument("--maximum-bytes", required=True, type=int)
    parser.add_argument("--sha512", required=True)
    parser.add_argument("--icon", required=True)
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    config = InstallConfig(
        home=os.environ.get("HOME", ""),
        version=arguments.version,
        expected_bytes=arguments.expected_bytes,
        maximum_bytes=arguments.maximum_bytes,
        sha512_hex=arguments.sha512,
        icon_path=arguments.icon,
    )
    try:
        target = install_from_stream(config, sys.stdin.buffer)
    except (InstallError, OSError) as error:
        print(f"Secure SovChat installation failed: {error}", file=sys.stderr)
        return 5
    print(f"Installed verified SovChat {config.version} to {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
