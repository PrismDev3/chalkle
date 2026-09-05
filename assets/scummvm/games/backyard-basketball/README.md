Backyard Basketball (2002, Humongous Entertainment)
===================================================

ScummVM needs this game's data files to run it. Put them in THIS folder
(assets/scummvm/games/backyard-basketball/). Use your own copy of the game -
the original CD, or the Backyard Basketball re-release by Mega Cat Studios /
Playground Productions (GOG or Steam). Do not upload or share the files.

What to copy
------------
The game's resource files (the .HE0 / .LA0 / .LT0 style data files, usually
the whole contents of the CD's game folder). The exact file names vary by
release; ScummVM detects them from the folder contents.

Once the files are here
-----------------------
1. Generate the manifest the player uses to load them:
     python tools/make-scummvm-manifest.py assets/scummvm/games/backyard-basketball
2. Open the game in the Games tab - it downloads the data and boots ScummVM.
   (Saves are stored per-browser, so they stick around between sessions.)