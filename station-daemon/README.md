# Station daemon

Runs on the streaming server next to Icecast and Liquidsoap. It asks the site for clips, applies the requested effect
(the Chips Voice presets such as `underground`, through ffmpeg), puts them on air through Liquidsoap, and reports back.
The station only makes **outbound** HTTPS calls: no public address, no certificate, no AI keys here.

```
site (Netlify)  --  /api/queue, /api/station/*  <--poll--  station-daemon  --telnet-->  Liquidsoap  -->  Icecast
```

## Set up

1. On the site, set `STATION_MODE=queue` and `STATION_KEY=$(openssl rand -hex 24)`, then redeploy. From then on every saved
   clip is queued (and the Generate tab gets "Send to air" / "Send to station library" buttons on each clip).
   `STATION_AUTOPLAY`, `STATION_PREEMPT` and `STATION_FX` still set the defaults.
2. On the station, with Node 20+, ffmpeg, and Liquidsoap running `chips-voice/googleTextToSpeech1/radio.liq`:

   ```sh
   SITE_URL=https://your-site.netlify.app STATION_KEY=<the same key> node station-daemon/daemon.mjs
   ```

3. To keep it running, copy `station-daemon/station-daemon.service` to `/etc/systemd/system/`, edit the paths and key,
   then `systemctl enable --now station-daemon`.

Other settings: `STATION_DIR` (default `./clips`), `POLL_SECONDS` (5), `KEEP_FILES` (200), `LIQUIDSOAP_HOST`/`PORT`
(`127.0.0.1:1234`), `LIQUIDSOAP_QUEUE`/`LIQUIDSOAP_LIVE_QUEUE` (`announce` / `announce_live`).

## How it behaves

- A clip meant for air goes to Liquidsoap's `announce` queue, or `announce_live` when it may cut in over a live DJ. A normal clip
  pushed while a live DJ is on waits until they leave (Liquidsoap decides); mark it to preempt if it must be heard.
- A clip not meant for air (`play: false`) is only stored in `STATION_DIR`.
- If an effect fails (ffmpeg missing, bad audio) the clip plays unprocessed. If the audio cannot be fetched or Liquidsoap refuses
  it, the item is reported failed and shows in the queue.
- If the site is unreachable the daemon backs off (up to a minute) and keeps trying. A clip it claimed but never confirmed is
  offered again after 90 seconds, three times at most.
- Run one daemon per queue: two polling the same queue could claim the same clip.

Tests: `node --test test/*.test.mjs` in this folder (a fake site and a fake Liquidsoap server, no network).
