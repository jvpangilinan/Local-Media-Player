# ULTRON - The Booth (Darkroom Edition)

A desktop player for your own videos, music and photos. A Flask backend serves a single-page
frontend inside a native window (pywebview). Everything runs locally and works **offline**: Tailwind CSS,
Font Awesome 6.4.0 and the Inter font are bundled in `vendor/`.

**First time? Read `SETUP.txt`** (what to install: Python packages, libmpv-2.dll, ffmpeg, the subtitle models, yt-dlp).

## V6: Smoother, sharper playback
Settings > Playback has a few new switches for the player window, and a **Picture** line that shows what the picture is doing.
- **Locked to the screen.** The player window now follows the monitor's own clock (display-resample) instead of the sound card's, so every frame lands on the screen at the same moment it should. A 23.976 fps film plays 0.1 % faster to fit 120 Hz exactly and the sound is stretched to match; you cannot hear it. Settings > Playback > Advanced > Sync > Audio clock brings the old behaviour back.
- **Film refresh rate.** If your screen runs at a rate films do not fit (165 Hz, for example), the screen moves to 120 Hz while a film or episode plays (24, 30 and 60 fps all fit 120 Hz exactly) and goes back when the player closes. The video pauses for the second the screen goes dark. The switch is temporary: Windows never saves it, it undoes it when the player stops or crashes, and ULTRON checks again when it starts. Short clips (under 15 minutes) never switch the screen. Nothing happens when your screen already runs at a fitting rate.
- **Smooth motion: Auto.** Frames are blended only when a video's frame rate still cannot fit the screen (25 and 50 fps on 120 Hz). Fitting videos stay frame-exact. Always and Off are still there.
- **High-quality picture** (on by default): mpv's high-quality profile with sharper scaling (ewa_lanczossharp), smoother gradients (no banding in skies and dark scenes).
- **HDR films on an SDR screen** measure each scene's real brightness and recover detail in the highlights. Balanced (spline) or Natural (BT.2446a, softer highlights).
- **Picture line:** the screen (resolution, refresh rate, bit depth, SDR / HDR, the rates it offers) and, while a video plays, its frame rate against the refresh rate, the sync, bit depth, HDR, GPU or CPU decoding, and dropped / late frames.

## V6: Real posters, found once
With **Settings > Smart genres and posters > Look movies and music up online** on and a free TMDB key saved, every movie and series gets its real poster from the internet instead of a frame from the video.
- **Automatic, and only once.** After each scan, new movies are looked up by themselves: the poster, the wide banner picture and the genre are saved on this PC and never asked for again. **Find posters and genres** does the same by hand and shows the progress.
- **Matched by name and year.** `Dune (2021).mkv` or a torrent folder like `Cars (2006) (1080p BluRay x265 Tigole)` is enough; edition words (Criterion, IMAX, Extended, Diamond, RM4K...) are ignored. Only names with a year get a poster, so clips and memes keep their own frame. When two movies fit equally, the item waits in **Needs review**, and the one you pick brings its poster.
- **Your pictures still win.** A thumbnail you set on a tile, or a poster file next to the video, is always used over the one found online. The private library is never looked up.
- **A folder that holds one movie is a movie.** `Finding Nemo (2003) (...)/` with the film and its featurettes used to show as a series. Now the film is a movie card, and the featurettes stay together as "Finding Nemo - Extras" in the Folders tab.
- **Piles sort themselves, the way you sort.** A movie lying in a catch-all folder (`Movies`, `Downloads`, `New`...) or loose in the videos folder shows on one of your genre shelves: a sequel joins the folder where you put the rest of its series (Shrek 2 next to your Shrek), animated films go where you keep yours (Family, if that is where your Shrek and WALL-E are), anything else to its first genre you have a folder for (Heat under Crime). A series you never sorted stays together. Nothing moves on disk: the Folders tab still shows where each file really is, and a movie you put in a genre folder yourself stays there.
- Edition words after the year (UpScaled, Criterion, RM4K, Diamond, Platinum) no longer hide the year, so `Hercules (1997) UpScaled` is now just *Hercules*, 1997.

## V6: Clearer cards and banner
- **Full titles.** Long movie titles wrap onto a second line instead of being cut after a few words; hover a title for the whole name if it is longer still.
- **Time left.** Continue watching cards say "1h 14m left" (or "Almost done"), and the Home banner adds when the movie ends ("ends around 4:01 PM"). A movie in a folder of its own no longer shows its name twice.
- **The banner** shows the movie's own wide picture, brighter, without the tall frame beside it. Only a real poster you put next to the video (for example `Dune (2021).jpg`) still appears there.
- **Row arrows** are small buttons on the middle of the covers instead of dark bars over the first card, and each one hides at its end of the row. Cinema rows no longer turn see-through while you hover them, and each Cinema row has one number (REEL 02) instead of two.
- **Cinema header.** With a Gallery, Colorful or Sync with time background, the Cinema bar (tabs, genre chips, Show / Sort) is solid again: titles no longer show through it as you scroll.

## V6: Holiday themes
ULTRON knows the date. On a holiday the accent colours follow the day and a quiet effect plays behind the page, with a one-line greeting the first time you open the app that day (once per holiday, plus on the big day itself).
- **Christmas** (Dec 1-26): snow, red and green. **New Year** (Dec 31-Jan 1): gold sparkles. **Lunar New Year** (first three days): red lanterns rising. **Valentine's Day** (Feb 14): hearts. **Easter** (Sunday and Monday, worked out for every year): spring petals. **Halloween** (Oct 25-31): bats crossing a dim orange moon. **All Saints & All Souls** (Nov 1-2): candle embers and a warm glow from below. **Your birthday**: confetti.
- Settings > Appearance > Holiday themes: on / off, your birthday (month and day), what is next ("Next: Christmas in 15 days"), and **Preview a holiday** to see any of them now (until you reload).
- The effect is one small canvas behind the page: it stops while a video plays, when the window is hidden, with reduced motion and with Minimal UI. Plain mode keeps its grey colours.

## V6: The Diner, a quiet room with a story
The mug button (sidebar, music bar, Now Playing) opens **The Diner**: a painted room on a rainy neon corner, with one framed painting, a jukebox that plays your own music, and a window onto the street.
- **Things answer a click.** The lamp, the string lights, the neon sign, the window (weather), the coffee, the sugar, the picture light, the plant, the cat, the jukebox. Drag on the window to draw in the fog. Finding all 12 unlocks fireworks.
- **The guest book (B).** A notebook on the table holds 27 pages written by people you never see: the cook, the radio voice, a child waiting for the bus. Each thing you use fills a page. Twelve more pages are secrets, and each blank page carries a hint. Nothing is timed against you.
- **A fifth night.** Reading the whole book adds a new night to the window.
- **Juno.** After a few pages, someone starts writing back in the margins. Later a second cup appears on the table: click it to talk. Nine nights, reply choices, four endings, and "Another night" on the last page of the book to play it again. Esc steps away from a conversation, and the cup waits for you.
- **Morning, day and night.** The street outside and the light in the room follow the clock: morning from 06:00, day from 12:00, night from 18:00. Rain and snow bring grey skies; "Clear" shows the sun. Press T to pin a time of day (press again to cycle back to the clock). The story skies stay night.
- **The way in.** In Gallery mode the painting behind the app becomes the first one on the diner's wall: it fills the window, then settles into the frame while the room's lights come on one by one. In other background modes the room fades in dark and the lights come on. With reduced motion it is a plain fade.
- **Your own stories.** Settings > Diner story > "Open stories folder" creates `stories\Example\story.txt` in your data folder. Each folder there is one story: a `story.txt` plus your own pictures. Pick it in Settings; the second cup then plays it. Juno's story stays the default and keeps her progress.
  - One line each, blank lines and `//` lines ignored. Header first: `title: X`, `characters: A, B`. `# Title` starts a scene. `Name: text` or `Name [mood]: text` is speech (Name must be in `characters`); any other text is narration. `? Label -> target` is a choice (consecutive lines form one). `= label` is a place to jump to, `-> label` jumps (`-> end` ends the scene). `remember: flag` sets a flag, `if flag -> label` jumps when it is set. `picture: file.jpg` hangs a picture in the frame, `picture: none` gives the frame back.
  - Pictures sit in the same folder. Characters: `<name>.png` or `<name>-<mood>.png` (lower case, spaces to `-`; `.webp` also works), transparent background, about 1200 px tall; a missing one just means no portrait. Scenes: `.jpg`, `.jpeg`, `.png` or `.webp`, 1920x1080 suggested. Mistakes are listed in Settings as `line N: message`, and the Diner falls back to Juno until they are fixed.
- **Keys:** Space / Right next painting, Left back, N empty frame, M hide the player, T time of day, B guest book, Esc leave.
- Progress is kept on this PC (in the page's local storage). `node tools/diner_story_check.js` checks the story script.

## V6: Gallery, Good by day and Evil by night
A fourth background, **Gallery** (Settings > Background), shows open-access paintings from the National Gallery of Art behind the app.
- **Two sides.** By day (06:00-18:00) the paintings are **Good**: light, grace, dawn, with gilt and sky accents. At night they turn **Evil**: storms, hell, candlelight, with ember and blood accents. Under the Gallery tile you can pick **Auto / Good / Evil**.
- **The Turning.** If the app is open at 06:00 or 18:00, the painting slowly crossfades (12 s) to the other side and the accents follow.
- **The sigil.** In Gallery mode the theme button is a sun or a flame. Click it to switch sides until the next Turning (stay in the light until dawn, or look at the dark until dusk). Shift+click still changes the background mode.
- **Still while you work.** One painting at a time, no motion. A new one at each launch and every 10 minutes, never while a video plays. A small plaque (title, artist, year) shows for a few seconds after each change.
- **Gallery view.** After 3 idle minutes with no video playing, or when you click the plaque, the app fades out and the painting fills the window with a slow pan and zoom. Any key, click or mouse move brings you back, and that input doesn't also press anything underneath. In Gallery mode it replaces the clock screensaver, follows the same Screensaver switch, and "Preview screensaver" shows it. With reduced motion turned on in Windows, the picture stays still.
- **Offline.** 6 paintings ship with the app, so it works with no network at all. **Download the collection** in Settings fetches all 80 (about 105 MB) from the NGA image server into your data folder, one at a time. It picks up where it left off, and **Remove** deletes them again.
- Behind it: `/api/art/status|install|list`, `DELETE /api/art`, `/art/<id>.jpg`; prefs `bg_mode: "art"` and `art_side`. The list is `assets/art/manifest.json`, made with `tools/art_curate.py`. Test: `tests/test_art.py`.

## V6: private videos start quiet

- **Auto-mute.** Private videos start muted in the native (libmpv) player, the pop-out and the in-window player, with a short "Press M for sound" notice. The mute is released for normal videos and resets at every lock.
- **Headphones first.** Before a private video starts, a prompt asks you to put headphones on. "Play with sound" only unlocks after you tick "I am wearing headphones"; "Play muted" is always there. It cannot detect real headphones, so it is an honest checkbox. Settings > Privacy: **Headphones prompt** (once per unlock / before every video / off), **Private videos start muted**, **Blur private covers**.
- **Private tab strip.** A sort menu (Newest / Oldest / A-Z, newest first by default) for the loose videos. Panic key, look-away blur and vault doors are unchanged.
- **Auto-lock.** The vault no longer auto-locks under a private video that is playing in the native window (the native player sends a heartbeat while it plays).
- **Photos password.** "Add a password" at the top of the Photos tab turns on the Photos lock. It shares the private-library password (Settings > Photos > Ask for the password on Photos).

## V5: your data follows you, and the private library has its own search

- **Your data survives a new version.** Before V5 everything (password, favorites, progress, playlists, settings) lived in `data/` inside the app folder, so unzipping a newer version started from zero. Now, if the app folder has no data of its own, ZENO keeps it in a fixed per-user folder (Windows: `%APPDATA%\ZENO\data`) and, the first time, **copies** the data of the newest older ZENO folder it finds *next to* the new one (same parent folder). The old version keeps its data and keeps working. A folder that already has a `data/` (an existing install) keeps using it, so nothing moves under you.
- **Settings > Your data** shows where the data folder is, opens it, and has **Export database / Import database** (the same one .zip as before: database, settings, password, tile pictures, generated subtitles). Use it to carry everything to another PC or to a version that was not unzipped next to the old one.
- **Restoring an older backup no longer removes your password**: if the file has none, the current one is kept.
- **Private search.** A search box sits in the Private library (next to Videos / Photos; press **/** to jump to it). It searches private videos, series and photos and nothing else. The main search (Ctrl+K) never shows anything private, and the private search never shows anything public. Results are cleared the moment the library locks.
- Advanced: set the environment variable `ZENO_DATA_DIR` to choose the data folder yourself.
- Your **media** folders (`media/videos`, `media/private`, ...) are still next to the app and are not copied. Move them into the new folder, or point the app at the old ones in Settings > Library.

## Backup and restore

- **Settings > Backup > Export backup** saves one .zip with your favorites and hearts, watch progress, ratings, playlists, plays, collection edits, settings, your own tile pictures and the generated subtitle files. Posters and thumbnails are left out: they rebuild by themselves.
- **Restore backup** puts it all back. It saves a safety copy of the current data first (data/backups, newest 5 kept), and it never changes where your media folders are, so a backup from another PC works too.
- The backup holds your password lock and any API keys. Keep the file private.
- Every 7 days the app also makes a quiet **auto-weekly** backup in data/backups when it starts (newest 4 kept). Copy that folder somewhere else now and then.
- **Music keys**: Space play/pause (already there), **Shift + Right / Left** next / previous song, **Shift + Up / Down** volume. They are listed in the `?` shortcuts sheet.
- The Music Home header shows a short hint while Plays and Playlists are both 0.

## Faster page load (new)

- The page used to load ~25 stylesheets and ~21 scripts one after another. The app now merges them, in the same order, when it serves the page (measured: about 40-50% faster to a usable page). Your files are untouched and edits are picked up automatically.
- If merging ever fails, the original page is served and the reason goes to app.log.
- To debug with real file names and line numbers open `/?nobundle=1`, or set the environment variable `ZENO_NO_BUNDLE=1`. A syntax error in one script breaks its whole merged chunk, so use this switch when you edit the scripts.
- Fixed: pressing `?` opened two shortcut sheets at once. The DJ sheet now only opens on the Now Playing screen.

## Disk-friendly (made for people who torrent)
- **Downloads are left alone.** A file written to in the last 2 minutes (or ending in .part, .!qB, .!ut, .crdownload, .aria2...) gets no thumbnail, no probe and no black-bar scan, so the app never reads half a movie, never caches a wrong thumbnail and never competes with the torrent for the same file. It is processed once, after it has been quiet for 2 minutes.
- **No rescan storms.** The folder watcher used to walk the whole library every 12 s and rescan on every change. Now it checks every 30 s, ignores files still downloading, and rescans once, after the folders have gone quiet. A finished torrent triggers one rescan.
- **Rescans write only what changed.** Before, every rescan rewrote every video row in the database. Now unchanged rows are not touched.
- **Lowest disk priority.** Background thumbnail work, the music indexer and every ffmpeg/ffprobe process run at "background" CPU priority and "very low" disk priority (Windows), so the torrent client and playback always get the disk first. A short pause between thumbnails; already-made thumbnails cost nothing.
- **Fewer database syncs.** SQLite runs with synchronous=NORMAL (safe with the WAL mode already used), a bigger page cache and in-memory temp files. Playback position is saved every 10 s instead of 5 s, and the settings mirror file is only rewritten when something actually changed.
- **Kept from before:** 2 ffmpeg at a time, clip export 1 at a time, thumbnails and probes cached forever on disk.
- Tip: point your torrent client's *incomplete* folder outside the media folders if you can; the app copes either way.

## One copy, one window, few ffmpeg
- **One copy of the app:** starting ZENO a second time no longer opens a second copy. It brings the running window to the front and quits. (Uses a local lock on 127.0.0.1:47399, released automatically when the app closes or crashes.)
- **One window or tab:** opening the app address in a second tab or browser shows "ALREADY OPEN" instead of loading. Reloading the page still works.
- **ffmpeg cap:** at most 2 ffmpeg/ffprobe processes at once (thumbnails, probes, crop detection, preview strips) and 1 clip export at a time, all at below-normal priority so playback and the UI stay smooth. Extra jobs wait their turn.
- **No leftovers:** on Windows every child process (ffmpeg, yt-dlp...) is tied to the app and is killed when the app exits or crashes.

## Smart genres (new)
Finds the genre of every movie, series and song once, remembers it, and works offline afterwards.
- **Settings > Smart genres.** Turn on "Look genres up online", paste a free **TMDB key** (themoviedb.org > Settings > API; either the "API Key" or the long "Read Access Token" works), press **Detect movie genres**. Press **Detect music genres** for songs.
- **Movies / series:** the file name is cleaned (title + year) and looked up on TMDB. The year confirms the match. Sure matches are applied; unsure ones go to **Needs review** where you tap the right one (or "None of these").
- **Music:** the file's own genre tag is used first (no internet). Songs without one are looked up by artist on MusicBrainz (no key; about 1 request per second, so a big first scan takes a while and keeps running in the background). A free Last.fm key is optional and improves results.
- **Where it shows:** Cinema gets a **Genre** dropdown next to Show/Sort. Music Home gets extra genre mixes, and the song filters get the new genres.
- **Safe:** nothing is renamed, moved or written into your files. Answers live in the app's database (tables `auto_genres` and `genre_cache`); a genre you pick yourself always wins. The private library is never sent anywhere. Keys stay in `data/settings.json` on this PC. Pause / Stop any time; "Forget detected genres" wipes automatic answers.
- **Needs:** internet only while scanning; no new Python packages (uses the standard library). Offline, "Detect music genres" still reads the files' own tags.

## Section 4 changes: Favorites
- Every movie, series and collection tile has a **heart** (top-left of the cover; always visible once hearted, otherwise on hover). Hearts are saved in the app's database, so rescans never forget them.
- The Collections page has a fourth chip, **Favorites** (Collections / Singles / All / Favorites): your hearted collections, movies and series together, with a count. Un-hearting a tile there removes it from the list right away.

## Section 3 changes
- **Settings > Appearance > Moving picture on tile hover** (default **Off**). On: hovering a movie, series or collection tile plays a short muted clip inside the square (a collection plays its first film). Off: tiles stay still. The older "Hover previews" switch now only covers the Home banner and private-library cards.
- **Fixed**: Singles showed the title and the small line twice under each tile; now once.
- **Fixed**: a small black box showed above the music bar (the empty, parked selection bar); it is hidden until you use Select.
- **Music > Home**: "Your playlists" (which only showed "New playlist") is replaced by **Fresh picks**: 10 random songs as square tiles. **Shuffle** picks 10 others, **Play all** plays them shuffled. Playlists are still under the Playlists button and in the quick tiles.

## Square tiles and your own thumbnails (tiles.css / tiles.js)
- Movies, series and collections show as square tiles like the Music tab. Collections are labelled by size (Single, Duology, Trilogy ...). Thumbnails are cut from the video itself (black bars trimmed, no blur) and cached in `data/tiles`.
- **Your own thumbnail**: hover any tile and press the picture button, then **Choose picture** (JPG / PNG / WEBP, centre-cropped to a square) or **Back to automatic**. Pictures are kept in `data/custom_tiles`; no video file is touched. A collection's picture is tied to its name.

## Look (Darkroom Edition)
Flat chassis instead of glass, a full-height rail of vertical index tabs (01 Home ... 06 Downloads), condensed uppercase headings with numbered sections,
mono labels, contact-sheet cards with crop marks, a readout column on Home (clock, greeting, quick actions). The prism colors live in thin spectral
hairlines; the flat accent follows Settings > Appearance > Accent palette. Light mode inverts the dark design as before. Only CSS and text changed: no
backend or feature logic was touched.

## Features
- Home (date + resume + new), Cinema (Collections / Series / All videos), Music hub, Photos, Downloader (yt-dlp), Private library behind a password.
- **Settings > Background**: Ambient (the Now Playing style glow that follows the artwork on screen), Ambient (soft) or Black. Settings > Appearance > Accent palette (Prism, Ember, Tide, Moss, Mono). The Music section is "the booth": index column, command strip, square sleeves, patch-list tracks.
- Optional corner clock (**Settings > Show clock**, default off).
- Cinema bar: collapse button and the **B** key (remembered), **Settings > Cinema bar: Always show / Auto-hide / Hidden**. Auto-hide fades it after ~2.5 s of mouse inactivity on Movies; hover the top edge to bring it back. It is always hidden during video playback and in Now Playing.
- Mini player (pop-out window): mouse wheel seeks (Ctrl/Shift + wheel = volume), `C` subtitles, `N` next episode, `E` expand, `Esc` close.
- Playlists: drag rows to reorder, double-click the title to rename, empty genres can be deleted.
- Moved or renamed video files are re-linked on Rescan (same size + same mtime or duration), so views, ratings, progress and custom titles survive.

## New in ULTRON: Flair (flair.css / flair.js)
Front end only, loaded last. Every effect has a switch in **Settings > Flair** (saved as `lmpv9_fx_<name>`), and all motion stops when Windows "reduce motion" is on. A "What's new" card shows once on first launch (**Settings > Flair > What's new** replays it). Settings you saved in LMPV7/LMPV8 are copied over automatically.
- **Music that moves**: the music bar, logo, sidebar edge and Now Playing glow with the real bass of the song (read from the audio, with a kick detector), four live spectrum bars sit next to the title, and the play button and cover pulse on the beat.
- **Cover colour**: the music bar takes the dominant colour of the album art. Songs change with a slide and a cover pop.
- **Atmosphere**: click ripples, a cursor comet, floating dust that speeds up with the bass, a slow aurora in your palette, posters and cards that rise in as they appear.
- **Screensaver**: after 3 idle minutes, a big clock, the date and what is playing. Move the mouse to wake it.
- **Little things**: the song in the window title (and a live favicon in a browser tab), a lit edge on the active sidebar tab, button press squish, back-to-top button with a progress ring, styled toasts, accent selection and focus rings.
- **Shortcuts**: `Alt+1`..`Alt+5` switch palette, `Alt+F` opens Flair settings, `Alt+I` previews the screensaver.
- **Secrets**: type `party`, `rave` or `ultron` anywhere (not in a text box).

## Albums you make yourself
Open any artist (or playlist / mix), press **Select songs**, click songs (Shift-click picks a range), then **Make into album**. Choose the name, the album artist and the track order.
- Nothing in your files changes: the album is stored in the app's database (`album_overrides`), so it survives rescans and moves nothing on disk.
- Typing the name of an album you already made adds the songs to it. Albums you made show a disc icon; open one to **Rename album** or **Ungroup album**, or select songs inside it and use **Remove from album**.
- The same selection bar also has **Add to playlist**.

## Downloads that fit the rest of the app
Downloads now has a **Save as** choice, so a link ends up where you want it instead of as loose files:
- **MP3 / FLAC**: Separate songs, One album, A playlist, or Album + playlist. The order of the link is kept. Leave the name empty to use the playlist's title; type the name of an existing playlist to add to it. Albums get their own folder inside the music folder. "Show in library" opens the new album or playlist.
- **Video**: Separate videos or One series (the playlist becomes a series; needs a genre). **Save to** picks Library or Private (unlock the private library first).
- Retrying a failed download keeps these choices.

## Cinema (was Browse) (browse-hub.js / browse-hub.css)
- **Collections is the main tab** and the page you land on. It is laid out like Music > Albums: a big heading, three chips and a grid with the name and a small grey line under every tile.
  - **Collections** = duologies, trilogies and bigger sets (made from file names, or by you). **Singles** = every movie that is not in a collection. **All** = both together. The Overview tab is still there, last in the row.
  - **Add movies** (button on the Collections page and on every collection page): type the name of a collection you have (the movie joins it) or a new name (a new collection is made), tick the movies, press Add. The auto-sorter keeps working for everything else; what you place by hand wins and is remembered across rescans. Nothing is moved or renamed on disk.
  - **Select** (button in the top bar): click posters to pick several movies, then **Add to collection** or **Take out of collection** (the movie goes to Singles and stays out). The pencil on a collection page renames it. **Back to automatic sorting** forgets every hand-made change.
- Names: the junk in release names (1080p, DTS, x264, BluRay, YIFY ...) is now removed everywhere in Cinema: movies, collections, series names, episode titles and the folder pick-lists. A name you set yourself with the pencil always wins. Settings > Movies > Clean names turns it off. The private library is not touched.
- The Cinema page uses a unified hub for Collections, All, Series, Folders and Overview, with combined search, filters, sorting, poster sizing and keyboard navigation.
- The hub reuses the existing public-library data and card/player actions; it does not move media files or alter the private library.
- The hub assets are loaded after `movies.js` so its Browse-page navigation hooks can wrap the existing app.

## New: Movies (movies.js / movies.css / moviesort.py)
- **Browse = Movies.** Discover is gone. The page is: Continue Watching, then your auto-sorted collections (Spider-Man, Iron Man ...), then the folders you made yourself. Series stays its own tab.
- **Auto-sort** (Settings > Movies): files dropped loose in the video folder sort themselves. Movies that share the start of their name become a collection; `Show.S03E05` style names become a series. Nothing is moved or renamed on disk, and any folder you made yourself always wins. Press **Sort now** after adding files. The toggle turns it off completely.
- **Clean names**: 1080p, BluRay, x264, YIFY, RARBG and the rest are hidden (the year is kept for ordering). Rename a movie yourself (pencil) and your name wins.
- **Expanding cards**: hover a poster and it grows into a wide card that plays a muted preview.
- **Picture** (Settings > Movies, or **A** while playing): Smart = black bars stay pure black and bars baked into the file (2.39:1, 2.35:1, 4:3 pillarbox ...) are cropped away, so the picture is shown at its real shape inside black bars; Fit = whole frame; Fill = crop to the window. The top bar shows the real ratio.
- **FFmpeg is optional.** Videos are played by libmpv as they are (see Native player below), so nothing is converted any more. ffmpeg + ffprobe are still used for black-bar detection, the precision trimmer, clips, auto subtitles and the downloader; on first launch ULTRON offers a one-click download and a **Skip for now** button.
- **Precision trimmer** (scissors button or **T**): zoomable filmstrip with IN / OUT handles, frame stepping, timecode, A-B play / loop / stop at OUT, and **Save clip** (no re-encode, goes to Videos/Clips; the cut lands on the keyframe before IN).

## Native player (libmpv): MKV and everything else, no conversion
ULTRON plays videos with **libmpv** (through `python-mpv`), the engine inside mpv. MKV, MP4, AVI, MOV, WebM, HEVC, AV1, 10-bit H.264, AC3, E-AC3, DTS, TrueHD and ASS/SSA subtitles all play **as they are**; the file is never converted, copied or touched. The old "make a playable copy" (MKV to MP4) code, the `data/compat` folder, the batch converter and the tray item for it are gone.

- **Why mpv and not VLC:** one DLL, a real GPU video path (`gpu-next`, D3D11), hardware decoding for H.264 / HEVC / VP9 / AV1, a display-synced clock, WASAPI with device choice, and a window that can be placed exactly over the player area. VLC could do the playing too, but embedding it cleanly in this window is much harder, so there is one engine instead of two.
- **How it fits the window:** mpv draws the picture in a child window that lives INSIDE the ULTRON window (mpv's `--wid`) and sits exactly over the picture area (between the title bar and the control bar). Windows itself moves, hides and destroys it together with the ULTRON window, so there is no polling thread and nothing can be left on screen when you close or minimise the app. The page still draws the title bar and controls and talks to mpv through `assets/js/mpv-player.js`, which makes the `<video id="player">` element behave as before (play, pause, seek, volume, speed, subtitles, audio tracks, screenshots, picture modes). In fullscreen mpv covers the window and shows its own on-screen controls. The **mini player** is a separate always-on-top mpv window.
- **Native trimmer (scissors button or `T`)**: a panel above the control bar with a zoomable filmstrip, ruler, IN / OUT flags, an overview of the whole film, frame stepping (`,` `.` also step while it is open), A-B play with LOOP on/off (off = stops at OUT) and **Save clip** (no re-encode, goes to Videos/Clips; the cut starts at the keyframe before IN). `I` / `O` set IN / OUT, `\` clears, `Esc` closes. IN / OUT are the same points as the `B` loop. Not available for private videos or in the mini player.
- **Fallback:** if `libmpv-2.dll` is missing, or Settings > Playback > Use libmpv is off, ULTRON uses the built-in web player (MP4 / WebM) like before and says so once.
- **Files:** `mpv_backend.py` (engines, options, window placement), the "native player" section in `app.py` (`/api/player/*`), `assets/js/mpv-player.js`, `assets/css/mpv.css`.

**Tuned for this PC** (Radeon RX 6950 XT, i7-12700F, M-Audio Duo into the FiiO FT1 headphones, DDR4-3600). All of it is in Settings > Playback:
- **Video:** `vo=gpu-next` on D3D11 with `hwdec=d3d11va` (the Radeon decodes H.264 / HEVC / VP9 / AV1; the 12700F has no iGPU to pick by mistake), direct rendering, `hwdec-codecs=all`. CPU decoding is only the fallback.
- **Sync:** `video-sync=display-resample`: the monitor clock leads and the audio is resampled by a tiny amount, so there are no dropped or doubled frames. Smooth motion (frame blending to the refresh rate) is optional. The diagnostics line shows the decoder, A/V offset and dropped frames while a video plays.
- **Audio:** WASAPI, and the output device is picked by name (default `M-Audio Duo`; if it is not found the Windows default is used and Settings says so). 5.1 / 7.1 is folded down to stereo for headphones. **Exclusive audio** (off by default) sends the sound bit-perfect to the interface but silences other apps while a video plays.
- **Memory:** a 512 MiB read-ahead (plenty with 3600 MT/s RAM and a big HDD library) keeps large remuxes smooth after seeking; seeks are frame exact.
- **Advanced:** one `key=value` per line (for example `scale=ewa_lanczossharp`). Options that could run scripts or open sockets are ignored.

## Requirements
- Windows 10/11 (macOS/Linux work with `python app.py` for development).
- Python 3.12 from python.org (tick "Add Python to PATH").
- Packages: see `requirements.txt` (`flask`, `pywebview`, `python-mpv`, `pystray`, `mutagen`, `langdetect`, `opencv-python-headless`, `numpy`, `pillow`, `pyinstaller`).
- **libmpv** (`libmpv-2.dll`, 64-bit) for playback: take it from the `mpv-dev-x86_64-*.7z` archive of the shinchiro / zhongfly mpv Windows builds. Keep it next to `ULTRON.exe` (or in `data\mpv`), or pick its folder in Settings > Playback. It is deliberately **not** packed into the exe any more: a 100+ MB DLL inside a one-file exe is unpacked to a temp folder on every launch.
- Optional: your own `yt-dlp`, `ffmpeg`, `ffprobe` (folder set in Settings) for the Downloader.

## Install and run
```
pip install -r requirements.txt
python app.py                      # desktop window
python app.py --browser            # normal browser tab (handy for debugging)
python app.py --videos "D:\Videos" --music "E:\Music"
```

## Project structure
```
app.py                  Flask backend, scanner, SQLite, pywebview launcher, mini player page
templates/index.html    the page shell: markup only (build_exe.bat moves index.html here if it sits next to it)
assets/css/*.css        (flair.css = small visual touches; library.css = Select songs + Downloads "Save as") the app's own styles, loaded in the order index.html lists them (later files override earlier ones)
assets/js/*.js          app.js (main), menu.js, browse.js, time.js, dj-deck.js, studio.js (ULTRON toys for Videos/Photos/Private/Downloads); a few tiny bootstrap scripts stay inline in index.html
vendor/                 tailwind.css, fontawesome/ (css + webfonts), inter/ (variable font)
tailwind.config.js      Tailwind config (colors: accent, lm-base / lm-card / lm-text)
tailwind.input.css      Tailwind entry file
build_exe.bat           one-click Windows build
requirements.txt
artist_rules.txt        artist names that must not be split into collaborators (auto-created)
logo.png                optional logo / exe icon
media/videos | music | private | Photos      your libraries (auto-created)
data/                   SQLite database, posters, thumbnails, settings.json
app.log                 structured log (rotating, 1 MB x 3); error.log only on a fatal start-up crash
```

Library layout: `media/videos/<Genre>/<video>` is a stand-alone video; `media/videos/<Genre>/<Series>/<episodes>` is a series.
Subtitles: put `<video>.srt` / `.vtt` (or `.en.srt`) next to the video.

## Build the .exe
1. Keep `app.py`, `index.html` (or `templates/`), `vendor/`, `assets/`, `requirements.txt`, `logo.png` and `build_exe.bat` together.
2. Double-click `build_exe.bat`. It installs the packages, makes an icon from `logo.png` and runs PyInstaller with
   `--onefile --noconsole --name ULTRON --add-data "templates;templates" --add-data "vendor;vendor"`.
3. Run `ULTRON.exe` from the same folder (the `media/`, `data/` and `artist_rules.txt` live next to it).

Edited `index.html` and added new Tailwind classes? Rebuild the CSS (needs Node.js once):
```
npm i -D tailwindcss@3.4.17
npx tailwindcss -c tailwind.config.js -i tailwind.input.css -o vendor/tailwind.css --minify
```

## Security notes
- The private library is a convenience lock, not encryption. Unlocking sets an `HttpOnly`, `SameSite=Strict` session cookie (8 h); private media URLs never contain a token. API calls may also use the `X-Private-Token` header.
- Every `POST`/`PUT`/`PATCH`/`DELETE` request must send `X-LMP: 1` or it is rejected with 403.
- Extra yt-dlp arguments (Settings > Downloader) pass an exact allow-list; anything else is dropped and reported.
- Locking wipes every private title from the page's JavaScript state.

## Troubleshooting
- Look at `app.log` (and `error.log` if the app will not start).
- Private video does not play in the mini window: the mini window must share the main window's cookies (it does with WebView2); if your backend does not, use the full player.

## ULTRON
- Music home redesigned (masthead, numbered channel list, record crates) so it no longer mimics Spotify.
- Now Playing: drag the record like a DJ. Forward drag plays forward, backward drag plays the song reversed; hold still to stop the platter. (Needs no backend; the song is decoded in the browser.)

## Earlier bug-fix pass
- RESET ALL (DJ tools) now also resets the FILTER slider and filter node, stops ECHO, clears the MATCH BPM box, resets waveform zoom and stops reverse play / loop roll.
- A new song starts at normal speed: the speed slider used to keep showing the old tempo while the browser had already reset the real playback rate.
- A loop set on one song no longer follows you into the next one (it could yank the new song to an old loop point when Now Playing was closed).
- Now Playing: only the right-hand column scrolls (the old CSS made every `.min-w-0` scroll, including the Up Next rows), with a slim scrollbar, so the seek bar and time row are no longer clipped at the top.
- Settings: the "DJ deck" and "Easter eggs" sections had no tab (they were added after the tabs were built, so they stayed hidden). They now have tabs 09 and 10. The left tab list no longer shows a stray horizontal scrollbar.
- The front end is no longer one 600 KB file: CSS and the big scripts live in `assets/` (served by the new `/assets/` route and bundled by `build_exe.bat`). `index.html` is about 78 KB.
- Songs without embedded cover art now get a neutral placeholder sleeve instead of a broken image (Now Playing, the player bar and library tiles).

## System tray (Windows)
Closing the window with the X no longer quits: ULTRON hides next to the clock (in the hidden-icons arrow). Music keeps playing, and the private library locks itself while you are away.
- Click the tray icon (or **Open ULTRON**) to bring the window back. Right-click for **Play / Pause music** and **Exit**.
- The sidebar **Exit** button (press twice) and the tray **Exit** really quit the app.
- Turn it off in **Settings > Display > Close to the system tray** (restart the app to apply). Needs `pystray` (installed by `build_exe.bat`); without it the X simply quits.

## ULTRON: the Studio update (Videos, Photos, Private, Downloads)
The neglected tabs finally get the Music treatment. All of it lives in `assets/js/studio.js` + `assets/css/studio.css` (front end only, no backend changes, still 100% offline).

**Video player**
- **Ambient glow** (`G`): the colors of the picture bleed into the black bars, drawn live from the video. Remembered.
- **Hover preview** on the seek bar: a little thumbnail of the exact spot you point at.
- **A-B loop**: `[` sets the start, `]` the end, `\` clears. The loop shows on the seek bar.
- **Frame step**: `,` and `.` while paused.
- **Frame grab** (`S` copies the current frame to the clipboard, `Shift+S` saves a PNG).
- **Sleep timer** (`Z`): 15 / 30 / 45 / 60 minutes, the picture dims in the last 30 seconds, then it pauses.
- **Movie night Roulette** (button in the Browse bar, and in the Private tab when unlocked): pick a mood (Anything, Never watched, Unfinished, Favorites), spin the reel, play what lands. Series resume where you left off.

**Photos**
- **Film looks** (`V`, or the wand button): Noir, Sepia, Faded, Cine, Pop, Cold. Non-destructive, only for viewing.
- **Slideshow** (`P`, or the play button, or the Slideshow button above any album): slow Ken Burns drift, `+` / `-` change the speed, chrome fades away, move the mouse to bring it back.
- **Surprise** button: opens a random photo from the current view.

**Private**
- **Panic key**: press the backtick key (`) twice. Locks the library, closes the player and the viewer, jumps to Home.
- **Blur when I look away**: when the window loses focus while private content is on screen, it is blurred and a private video is paused. Switch it off in the lock menu.
- **Vault doors**: a short door-opening animation when you unlock.

**Downloads**
- **Presets** (Best video, 1080p, 720p lite, 4K, MP3, Music FLAC), **Paste links from clipboard**, and **drop a link anywhere in the window** to queue it.
- **Loading dock** strip (unloading / waiting / delivered / stuck), animated progress bars and an optional finish chime.

Note: the old saved palette choice is carried over; the internal storage keys of the accent palette are now `lmpv9_*`.

## Offline
Nothing is loaded from the internet: Tailwind, Font Awesome and Inter are bundled, and the page makes no external requests (checked in a real browser). Only two features you start yourself need a connection: the song-language lookup (lrclib.net, Settings > Library) and the yt-dlp Downloader.

## ULTRON changes
- Renamed everything from ULTRON to ULTRON (window title, exe, tray, easter eggs, CSS/JS ids). Saved appearance settings from ULTRON are copied over on first start.
- Music: shelves no longer overlap (the "Something new to try" caption sits inside its card). Home is Spotify-style: quick tiles, Your playlists, Language mixes ("English Mix", ...), most-listened artists with your most played songs.
- Removed the "More like <artist>" / similar-to recommendations and the "Made for you" genre mixes.
- Video: one shared volume/mute for the music bar, Now Playing and the video player; new player styling (player.css); fullscreen falls back to element fullscreen if the window still shows borders; mouse wheel also scrolls a row when the pointer is over its arrows.
- Library: new genre folders and files dropped in by hand are picked up automatically (folder watcher + page refresh), no Rescan press needed.

## ULTRON STAR theme
Settings > Appearance > Accent palette > **ULTRON STAR**: pure black, white stars (drawn by assets/js/ultron-star.js), liquid-chrome buttons and headings, and the round chrome logo in the rail (assets/css/ultron-chrome.css). Use the Dark background.

Stars: Settings > Flair > Stars (ULTRON STAR), or Alt+S.

## Photos: albums, zoom and the editor (assets/js/photos-pro.js, assets/css/photos-pro.css)
**Albums.** An album is a folder inside the gallery (media/Photos, or media/private/Photos for the private gallery), so everything stays plain files.
- **New album** (Photos > Albums screen, or the All photos view) makes an empty album. Empty albums show up with a picture icon.
- **Select** (inside any album, Favorites or All photos): tap photos, then **Add to album** (type a new name or tap an existing one) or **Move out of album**. Photos are moved, never copied or deleted. Hearts follow the photos.
- Inside an album: **Rename** and **Ungroup** (photos go back to the main gallery, the folder is removed, nothing is deleted).
- In the viewer, the folder-plus button adds the photo you are looking at to an album.

**Zoom in the viewer.** Scroll wheel (or pinch) zooms toward the pointer, drag to pan, double-click toggles 2.6x, `+` `-` `0` zoom in / out / fit. The % chip in the top bar returns to fit. Photo to photo navigation: arrow keys, Space, or the side buttons (the wheel zooms now). Fullscreen is still Enter or the expand button.

**Editor** (sliders icon in the viewer, or `E`):
- Crop with a draggable box, aspect presets (Free, Original, 1:1, 4:3, 3:2, 16:9, 3:4, 2:3, 9:16), rotate left/right, flip. The crop is applied when you press Apply crop, change tab or save.
- Adjust sliders: exposure, contrast, fade, saturation, hue, warmth, tint, sharpen, blur, grain, vignette (negative = light glow), black and white, sepia. Double-click a slider name to reset it.
- 12 one-tap filters with live thumbnails.
- Resize: width and height in pixels with a lock for the shape, scale presets (25% to 200%), export format JPG / PNG / WebP and quality.
- Undo / redo (Ctrl+Z, Ctrl+Y), Hold to compare, Reset all.
- **Save as a copy** writes `name-edited.jpg` next to the original. **Replace original** overwrites it (JPG, PNG, WebP only) and keeps the untouched original in `data/photo_originals/`. Animated GIFs cannot be edited.
- Needs Pillow (already in requirements.txt) on the Python side to verify the saved picture. Effect previews need a Chromium based window (the Windows WebView2 build is).

New backend routes: `/api/photos|pphotos/albums/{create,move,rename,ungroup}` and `/api/photos|pphotos/edit` (private ones need the unlock cookie like the rest of the private gallery).


## Photos lock (optional, same password as the private library)
Settings -> PHOTOS LOCK turns the lock on for the Photos section. There is only one password: the one for the private
library (if none exists yet, turning the lock on asks you to pick it). Entering it in either place opens both.
While locked, the gallery, thumbnails, Home photo shelves and every photo action are refused.
Photos lock again after the idle time, with Ctrl+L, or with the Lock Photos button above the gallery.
Change the password from the lock icon in the sidebar (Change password); it changes for both.
Like the private lock it is a convenience lock, not encryption: the pictures are still ordinary files in media/Photos.

## Tray icon
Right-click the tray icon: now playing, Play/Pause, Next, Previous, Mute, Lock private library, Open folder (videos, music, photos, data/logs), Open ULTRON, Exit. Hover shows what is playing.

## Auto subtitles (Whisper + NLLB, 100% local)
In the player press **CC > Generate subtitles...**, pick the language to translate into (80 languages, or "Original language"), the spoken language (Auto-detect works) and the quality, then press Generate. You can close the panel and keep watching: a small pill shows progress and the subtitles switch on by themselves when they are ready.
- **How it works:** ffmpeg pulls the audio out, **faster-whisper** (Whisper large-v3-turbo, int8, on the CPU) writes the text with timestamps, **NLLB-200** (CTranslate2, int8) translates every line, and the result is saved as WebVTT in `data/autosubs`. Nothing leaves your PC after the models are downloaded.
- **Models** live in `models/` next to the exe: `whisper-large-v3-turbo` (Accurate, 1.6 GB), `whisper-small` (Fast, 0.5 GB) and `nllb-600m` (the translator, 0.65 GB). `build_exe.bat` downloads them once (it runs `download_models.py`); Settings > Subtitles > Download models does the same from inside the app. To use the better 1.3B translator, convert it with `ct2-transformers-converter --model facebook/nllb-200-distilled-1.3B --quantization int8 --output_dir models/nllb-1.3b` and copy `sentencepiece.bpe.model` into that folder: it is picked up first.
- **Speed:** the first pass of a film is not real time (CPU). Fast is several times quicker than Accurate. The transcript is saved, so a second language for the same video only needs the translation step. Use `ULTRON_ASUB_THREADS=8` (an environment variable) to change how many CPU threads it uses.
- **Settings > Subtitles:** default language and quality, model status / download, **Generate for all videos** (queues every public video without subtitles, one after another, handy overnight) and Stop. Private videos are never queued by this; generate those from the player after unlocking.
- Delete a generated track from the same panel. Subtitle files you put next to a video (`name.srt`) keep working as before and are never overwritten.
