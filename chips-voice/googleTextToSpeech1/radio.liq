# Liquidsoap 2.x auto-DJ for the stream server.
#
#   music playlist ──┐
#                    ├─ fallback ─ announcements (duck music) ─> Icecast /stream
#   DJ on /live ─────┘   (announce_live clips cut in over the DJ when asked)
#
# The DJ (BUTT) connects to the Icecast mount /live. While it is connected it
# takes over; when it drops, the server-side music resumes automatically.
# Listeners always use /stream.
#
# Run:  liquidsoap /etc/liquidsoap/radio.liq
# Then start the backend with PLAYER=liquidsoap (see README).

settings.server.telnet := true
settings.server.telnet.bind_addr := "127.0.0.1"
settings.server.telnet.port := 1234

icecast_host     = "127.0.0.1"
icecast_port     = 8000
icecast_password = "CHANGE_ME"     # the Icecast *source* password
music_dir        = "/srv/music"

# Music volume is adjustable at runtime: telnet `var.set music_volume = 0.5`
music_volume = interactive.float("music_volume", 1.0)

music = playlist(id="music", mode="randomize", reload_mode="watch", music_dir)
music = amplify(music_volume, music)

# Announcement clips pushed by the backend: telnet `announce.push <file>`
announce = request.queue(id="announce")

# Announcements allowed to cut in over the live DJ (backend: "preempt": true).
# They replace the live audio while they play, then the DJ comes back.
announce_live = request.queue(id="announce_live")

# Music drops to 20% while an announcement plays, with a short smooth fade.
auto = smooth_add(delay=0.8, p=0.2, normal=music, special=announce)

# Live DJ input from the Icecast /live mount. Unavailable when nobody is connected.
live = input.http("http://#{icecast_host}:#{icecast_port}/live")

# Preempting clips first, then the live DJ, then the auto-DJ; switch immediately, not at the end of a track.
radio = fallback(track_sensitive=false, [announce_live, live, auto])
radio = mksafe(radio)

output.icecast(
  %mp3(bitrate=128),
  host=icecast_host, port=icecast_port, password=icecast_password,
  mount="/stream",
  name="Chips Voice",
  radio
)
