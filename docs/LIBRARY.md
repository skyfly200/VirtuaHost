# Sound library (OwnCloud and Google Drive)

Keep your sound effects and music beds in cloud storage you already use; the site reads them from there. Nothing is
uploaded or changed: the site only lists and downloads audio files (mp3, wav, ogg, m4a, flac). One folder per kind:

- **Sound effects**: short sounds. `Big Ding.mp3` becomes the tag `[sfx:big-ding]`.
- **Music**: beds that play under a whole clip. `Late Jazz.mp3` becomes `[music:late-jazz vol=0.2]`; it fades in before the
  first word and out after the last. Use one bed per clip.

Built-in effects (`ding`, `chime`, `whoosh`, ...) always exist and win a name clash. Files over about 5 MB are not passed through
(Netlify's response limit), so trim long music to a loop or a short bed. Use the Library tab to browse, play and copy tags.

## OwnCloud (also works with Nextcloud)

Create the folders (for example `/VirtuaHost/sfx` and `/VirtuaHost/music`), make an **app password** (Settings > Security),
and set these on the site and redeploy:

| Variable | Value |
|---|---|
| `OWNCLOUD_URL` | the server root, `https://cloud.example.com` |
| `OWNCLOUD_USER`, `OWNCLOUD_PASSWORD` | the account and its app password |
| `OWNCLOUD_SFX_PATH`, `OWNCLOUD_MUSIC_PATH` | the folders, for example `/VirtuaHost/sfx` (set either or both) |

## Google Drive

1. In Google Cloud, create a **service account** (no roles needed), enable the **Google Drive API**, and create a JSON key.
2. In Drive, **share each folder** with the service account's email address (Viewer is enough).
3. Set on the site and redeploy:

| Variable | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the key file's contents (raw JSON, or base64 of it) |
| `GDRIVE_SFX_FOLDER`, `GDRIVE_MUSIC_FOLDER` | a folder's id or its full URL |

With both configured, OwnCloud is listed first and wins when two files share a name. Listings are cached for a minute,
so a new file can take that long to show up.

## Using it

In the Generate tab, put the tags in the text (or in the line the AI wrote, before pressing "Make the audio"):
`[music:late-jazz vol=0.2] Good evening. [sfx:big-ding] You're listening to the station.` The preview is mixed in the
browser, and what you hear is what gets saved.

The **premix Action** (`scripts/premix.mjs`) reads the same library when `SITE_URL` (variable) and `ACCESS_KEY` (secret) are set: library
effects work as `[sfx:name]` and `[music:name vol=0.2]` puts a bed under the whole script. The station daemon plays finished clips, so it does
not need the library.
