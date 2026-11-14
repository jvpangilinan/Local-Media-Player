"""Title cleaning, episode parsing and franchise grouping (moviesort.py). Run:  python tests/test_moviesort.py
Pure functions only: no app start, no data folder, nothing on disk is touched."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from moviesort import clean_junk, clean_movie_title, group_franchises, parse_episode  # noqa: E402

TITLES = {
    "Ant-Man.2015.1080p.BluRay.x264-GRP": ("Ant-Man", 2015),
    "Thor Love and Thunder (2022) 1080p": ("Thor Love and Thunder", 2022),
    "Interstellar_2014_1080p_WEB-DL": ("Interstellar", 2014),
    "Guardians.Of.The.Galaxy.Vol.2.2017.1080p": ("Guardians Of The Galaxy Vol. 2", 2017),
    "Blade Runner 2049 (2017) 2160p HDR": ("Blade Runner 2049", 2017),   # a year inside the title stays
    "2012.2009.720p": ("2012", 2009),                                    # a film called 2012
    "1917 (2019) [1080p]": ("1917", 2019),
    "Valorant 2024 ace clip": ("Valorant 2024 ace clip", None),          # not junk after the year: not a release year
    "DTS 1080p x264 BLURAY Shrek 3": ("Shrek 3", None),                  # junk at the start
    "The Matrix": ("The Matrix", None),
}
for stem, want in TITLES.items():
    got = clean_movie_title(stem)
    assert got == want, f"clean_movie_title({stem!r}) = {got!r}, want {want!r}"

EPISODES = {
    "The.Boys.S03E05.1080p": ("The Boys", 3, 5),
    "Friends 2x14": ("Friends", 2, 14),
    "Lost Season 1 Episode 4": ("Lost", 1, 4),
    "Movie 2019": None,
    "S01E01": None,                                                      # no show name
}
for stem, want in EPISODES.items():
    got = parse_episode(stem)
    assert got == want, f"parse_episode({stem!r}) = {got!r}, want {want!r}"

assert clean_junk("Breaking.Bad.S01.1080p.BluRay.DTS.x264-GRP") == "Breaking Bad S01"

films = ["Spider-Man", "Spider-Man 2", "Spider-Man 3", "Iron Man", "Iron Man 2", "Black Swan", "Black Panther",
         "The Matrix", "The Matrix Reloaded", "Star Wars", "Star Wars Episode V", "Star Wars Episode VI", "Up", "Heat"]
groups = {name: sorted(films[i] for i in idx) for name, idx in group_franchises(films).items()}
assert groups == {
    "Spider-Man": ["Spider-Man", "Spider-Man 2", "Spider-Man 3"],
    "Iron Man": ["Iron Man", "Iron Man 2"],
    "The Matrix": ["The Matrix", "The Matrix Reloaded"],
    "Star Wars": ["Star Wars", "Star Wars Episode V", "Star Wars Episode VI"],   # the Episode sub-group folds in
}, groups                                                            # Black Swan / Black Panther stay apart
assert group_franchises([]) == {} and group_franchises(["Heat"]) == {}

print("moviesort OK")
