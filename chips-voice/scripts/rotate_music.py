#!/usr/bin/env python3
"""Keep a rotating subset of a large cloud music library on a small server.

Each run keeps most of the files already on disk, drops a random fraction of
them, and fills the freed space with random files from the cloud library, so the
station slowly cycles through the whole library without ever holding all of it.

The cloud side is read with rclone, so any storage rclone supports works
(Nextcloud/ownCloud via WebDAV, Google Drive, Dropbox, S3, SFTP, ...).

    rotate_music.py cloud:Music /srv/music --max-gb 4 --replace 0.25

Sub-folders are preserved, so they keep working as playlists.
Run it daily or weekly from cron or a systemd timer (see docs/MUSIC-ROTATION.md).
"""
import argparse
import json
import math
import os
import random
import shutil
import socket
import subprocess
import sys
import tempfile

AUDIO_EXTENSIONS = {'.mp3', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac', '.wav'}


def is_audio(path):
    return os.path.splitext(path)[1].lower() in AUDIO_EXTENSIONS


def safe_relative(path):
    """True for a plain relative path with no way out of the destination."""
    norm = os.path.normpath(path)
    return not (os.path.isabs(norm) or norm == '..' or norm.startswith('..' + os.sep))


def list_remote(remote):
    out = subprocess.run(
        ['rclone', 'lsjson', '-R', '--files-only', remote],
        check=True, capture_output=True, text=True).stdout
    return {e['Path']: e['Size'] for e in json.loads(out)
            if is_audio(e['Path']) and e['Size'] > 0 and safe_relative(e['Path'])}


def list_local(dest):
    files = {}
    for root, _dirs, names in os.walk(dest):
        for name in names:
            full = os.path.join(root, name)
            if is_audio(name) and not os.path.islink(full):
                files[os.path.relpath(full, dest)] = os.path.getsize(full)
    return files


def plan(remote, local, max_bytes, replace, rng):
    """Return (keep, drop, add) as sets of relative paths."""
    # Files that vanished from the cloud library are dropped.
    still_there = [p for p in local if p in remote]
    gone = set(local) - set(still_there)

    rng.shuffle(still_there)
    n_drop = math.ceil(len(still_there) * replace) if still_there else 0
    dropped_for_rotation = still_there[:n_drop]
    keep = still_there[n_drop:]

    # If the budget shrank, trim kept files until they fit.
    used = sum(local[p] for p in keep)
    while keep and used > max_bytes:
        used -= local[keep.pop()]

    # Fill the rest with random library files, excluding what was just rotated out.
    excluded = set(dropped_for_rotation) | set(keep)
    candidates = [p for p in remote if p not in excluded]
    rng.shuffle(candidates)
    add = []
    for p in candidates:
        if used + remote[p] <= max_bytes:
            add.append(p)
            used += remote[p]

    drop = gone | set(dropped_for_rotation) | (set(still_there) - set(keep) - set(dropped_for_rotation))
    return set(keep), drop, set(add)


def download(remote, dest, add, remote_sizes):
    """Fetch files into a staging directory next to dest, then move them in place."""
    staging = tempfile.mkdtemp(prefix='.incoming-', dir=os.path.dirname(os.path.abspath(dest)))
    try:
        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as lst:
            lst.write('\n'.join(sorted(add)) + '\n')
        try:
            subprocess.run(['rclone', 'copy', remote, staging, '--files-from', lst.name,
                            '--transfers', '2', '--checkers', '2'], check=True)
        finally:
            os.unlink(lst.name)
        fetched = []
        for rel in sorted(add):
            src = os.path.join(staging, rel)
            # Skip anything that did not arrive completely.
            if os.path.isfile(src) and os.path.getsize(src) == remote_sizes[rel]:
                target = os.path.join(dest, rel)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                os.replace(src, target)
                fetched.append(rel)
            else:
                print(f'warning: {rel} did not download completely; skipped', file=sys.stderr)
        return fetched
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def remove(dest, drop):
    for rel in sorted(drop):
        path = os.path.join(dest, rel)
        if os.path.isfile(path) and not os.path.islink(path):
            os.remove(path)
    # Prune empty sub-folders, never the root.
    for root, _dirs, _files in os.walk(dest, topdown=False):
        if root != dest and not os.listdir(root):
            os.rmdir(root)


def reload_liquidsoap(host, port):
    with socket.create_connection((host, port), timeout=5) as s:
        s.sendall(b'music.reload\nexit\n')
        s.recv(4096)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('remote', help='rclone source, e.g. cloud:Music')
    ap.add_argument('dest', help='local music directory, e.g. /srv/music')
    ap.add_argument('--max-gb', type=float, required=True, help='most music to keep on disk, in GB')
    ap.add_argument('--replace', type=float, default=0.25,
                    help='fraction of the current files to rotate out each run (default 0.25)')
    ap.add_argument('--min-free-gb', type=float, default=1.0,
                    help='never let free disk space fall below this (default 1)')
    ap.add_argument('--seed', type=int, help='fixed random seed (for testing)')
    ap.add_argument('--dry-run', action='store_true', help='show the plan, change nothing')
    ap.add_argument('--reload', action='store_true', help='tell Liquidsoap to reload the playlist afterwards')
    ap.add_argument('--liquidsoap-host', default='127.0.0.1')
    ap.add_argument('--liquidsoap-port', type=int, default=1234)
    args = ap.parse_args(argv)

    if not 0 <= args.replace <= 1:
        ap.error('--replace must be between 0 and 1')
    dest = os.path.abspath(args.dest)
    os.makedirs(dest, exist_ok=True)

    remote = list_remote(args.remote)
    if not remote:
        sys.exit('no audio files found on the remote; nothing changed')
    local = list_local(dest)
    rng = random.Random(args.seed)

    max_bytes = int(args.max_gb * 1e9)
    keep, drop, add = plan(remote, local, max_bytes, args.replace, rng)

    # Keep the free-space floor: drop additions until the download fits.
    free = shutil.disk_usage(dest).free
    floor = int(args.min_free_gb * 1e9)
    add = sorted(add)
    while add and sum(remote[p] for p in add) > free - floor:
        add.pop()
    add = set(add)

    gb = lambda n: f'{n / 1e9:.2f} GB'
    print(f'library: {len(remote)} files on remote, {len(local)} on disk ({gb(sum(local.values()))})')
    print(f'keep {len(keep)}, drop {len(drop)} ({gb(sum(local[p] for p in drop))}), '
          f'add {len(add)} ({gb(sum(remote[p] for p in add))})')
    if args.dry_run:
        return 0

    fetched = download(args.remote, dest, add, remote) if add else []
    # Drop only after the new files are in place, so a failed download never shrinks the library.
    remove(dest, drop)
    print(f'done: fetched {len(fetched)}, removed {len(drop)}')
    if args.reload:
        try:
            reload_liquidsoap(args.liquidsoap_host, args.liquidsoap_port)
        except OSError as err:
            print(f'warning: could not reload Liquidsoap: {err}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
