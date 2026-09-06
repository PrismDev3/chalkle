Backyard Football (1999, Humongous Entertainment) (ScummVM)
===================

Two ways to play, both fully offline and in the browser:

EASY (one file, zero clicks after setup)
----------------------------------------
Drop this game's single data file (the .gme from your own copy - the GOG
or Steam re-release) into this folder named exactly `game.gme`:

    assets/scummvm/games/backyard-football/game.gme

That is it. The game boots on click - no manifest, no tool, nothing to
upload. Saves are stored per-browser.

CLASSIC (multi-file, like the CD)
---------------------------------
Put the whole game folder's data files here (the .HE0 / .LA0 / .LT0 style
files from your own copy - the original CD). Then generate the manifest
the player reads:

    python tools/make-scummvm-manifest.py assets/scummvm/games/backyard-football

If neither is present, the game page shows a "Choose game files" button
that lets you pick the files right in the browser and play instantly -
still nothing is uploaded.
