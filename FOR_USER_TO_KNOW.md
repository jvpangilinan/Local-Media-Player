# For you to know

Plain notes on how ULTRON handles your stuff, and what to do when something comes up.
Claude reads this file too: ask "check FOR_USER_TO_KNOW.md" in this folder and it knows the background.

---

## Moving ULTRON to another PC

**Where your stuff is:** not in the app folder. It's in `%APPDATA%\ZENO\data`
(paste that into the File Explorer address bar to open it). That folder holds your watch progress, ratings,
favorites, settings, your TMDB key, and all the posters ULTRON downloaded.

**What to do:**
1. Close ULTRON on the old PC (right-click the tray icon > Exit), so nothing is half-written.
2. Copy the whole `ZENO\data` folder to the same place on the new PC: `%APPDATA%\ZENO\data`.
3. Copy the app folder (with `ULTRON.exe`) and your videos / music / photos.
4. On the new PC, install what `SETUP.txt` lists (ffmpeg, libmpv). Without them videos won't play and clips get no picture.
5. Open ULTRON. If your videos sit on a different drive now, set the folders again in **Settings > Library**.

**Keep the inside of your videos folder the same** (`Action\Heat (1995).mkv` stays `Action\Heat (1995).mkv`).
The drive letter can change. ULTRON knows each movie by its path inside the videos folder, so the same layout means
your progress, posters and your own thumbnails all line up. It also recognises moved or renamed files by their
size and date, but the same layout is the safe choice.

**Don't use the Backup zip to move PCs (for now).** See "Known problem" below. Copying the folder is better anyway:
nothing has to be downloaded again.

---

## Known problem: posters after restoring a Backup

**What happens:** Settings > Your data > Backup makes a small zip. To keep it small it leaves the downloaded posters out.
But the database inside the zip still says every poster was already found, so after a restore ULTRON never downloads
them again. Your movies show a picture from the video instead of their real poster.

**What to do if it happens:** open Claude in this folder and paste:

> Fix TODO item 5 (posters after a backup restore)

It's a small fix (download the poster again when its file is missing). It's also written down in `TODO.md`, item 5.

---

## How the posters get downloaded

- **Only if you turn it on:** Settings > Smart genres and posters > "Look movies and music up online", plus a free
  TMDB key (from themoviedb.org) saved there. Otherwise nothing goes online.
- **Once per movie.** After every scan, new movies and series are looked up on TMDB by name and year. Each one is
  looked up only once, then remembered.
- **Only names with a year** (like `Dune (2021)`), plus series. Clips without a year keep a picture taken from the video.
  The private library is never sent anywhere.
- **Not sure which movie it is?** It goes to **Needs review** and you pick.
- **No internet?** Nothing is saved; it tries again after the next scan.
- **Which picture a card shows** (the first one that exists):
  1. A thumbnail you picked yourself (hover a card > picture button)
  2. An image file next to the video with the same name, like `Dune (2021).jpg`
  3. The poster found online
  4. A picture taken from the video (needs ffmpeg)

---

## How auto-sort works

- **It only reads names.** Nothing is ever moved or renamed on your disk.
- **Cleans names:** drops junk like `1080p`, `BluRay`, `x265`, `YIFY` and finds the year.
- **Groups things:** Iron Man 1, 2, 3 become one collection. `S01E02` or `1x02` files become a series.
  A folder with one movie plus extra videos is a movie, with the extras grouped as "Movie - Extras".
- **Your folders win:** `videos\Action\Heat.mkv` sits on the Action shelf. `videos\Comedy\The Office\...` is a series.
- **Catch-all folders** (`Movies`, `Downloads`, `New`, or loose in the videos folder): movies there go onto your genre
  shelves, using the genres from the online lookup. A sequel joins the rest of its films, animated films go where you
  keep yours, anything else goes to its first genre you have a folder for.
- **Your own changes stay.** Collection edits you make by hand are kept. The "Automatic sorting" button undoes them.
- Switches: Settings > Library > Movies ("Auto-sort movies", "Clean movie names").
