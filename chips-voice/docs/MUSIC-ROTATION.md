# Rotating music from your cloud storage

The VPS only has room for part of the library (about 4-6 GB on the $2 plan).
`scripts/rotate_music.py` keeps a random subset on disk and swaps part of it
for other files from your cloud storage on a schedule, so over time the station
plays the whole library.

Each run:

1. Lists the audio files on the cloud side and on disk.
2. Keeps most of what is on disk, and drops a random fraction (`--replace`,
   default 25%) plus anything that no longer exists in the cloud.
3. Picks random files from the rest of the library until the disk budget
   (`--max-gb`) is filled.
4. Downloads them to a staging folder, moves complete files into place, then
   deletes the dropped ones. A failed download never shrinks the library.

Sub-folders are preserved, so folders keep working as playlists in the UI.
Playing files are safe to delete on Linux; Liquidsoap finishes the track.

## 1. Connect rclone to your cloud

The script reads the cloud with [rclone](https://rclone.org/), which supports
Nextcloud/ownCloud (WebDAV), Google Drive, Dropbox, OneDrive, S3, SFTP and more.
Which one is "your own cloud"? Whatever it is, the steps are the same:

```sh
sudo apt install rclone python3        # or install rclone from rclone.org
rclone config                          # create a remote, e.g. named "cloud"
rclone lsd cloud:                      # check it works
```

Use a read-only credential if the provider offers one (an app password or a
read-only share). The script only ever reads from the cloud.

## 2. Try it

```sh
python3 scripts/rotate_music.py cloud:Music /srv/music --max-gb 4 --dry-run
python3 scripts/rotate_music.py cloud:Music /srv/music --max-gb 4 --reload
```

| Option | Meaning |
|--------|---------|
| `--max-gb` | most music to keep on disk (required). Leave room for the OS and clips. |
| `--replace` | fraction of current files rotated out per run (default 0.25). |
| `--min-free-gb` | never let free disk fall below this (default 1). |
| `--reload` | ask Liquidsoap to reload the playlist afterwards (`radio.liq` also watches the folder). |
| `--dry-run` | show the plan, change nothing. |

The first run fills the empty folder. Choose `--max-gb` below the free space,
for example 4 on the 10 GB plan.

## 3. Schedule it

Daily at 04:00 with cron (`crontab -e` as the user that owns `/srv/music`):

```
0 4 * * * /usr/bin/python3 /opt/chipsvoice/scripts/rotate_music.py cloud:Music /srv/music --max-gb 4 --replace 0.15 --reload >> /var/log/rotate-music.log 2>&1
```

For weekly rotation use `0 4 * * 0` and a larger `--replace` (for example 0.5).
Rough guide: a daily 15% swap turns over about half the folder each week.

## Things to know

- Only audio files are touched (mp3, ogg, opus, flac, m4a, aac, wav). Other
  files in `/srv/music` are left alone.
- Files are copied as they are. FLAC and WAV are much larger than MP3, so the
  same budget holds far fewer tracks. If your cloud library is lossless, say so:
  converting to 128k MP3 on the server would fit about 5x as many tracks, and
  the stream is 128k anyway.
- Rotation is random, not scheduled by genre or time of day. Keep folders per
  mood or show if you want control; per-folder budgets are a possible addition.
- Downloads use the VPS's bandwidth and the cloud provider's rate limits. Each
  run is small.
- Tested here against a local stand-in for rclone, not a real cloud account.
