/* game-covers.js - real cover art for catalogue games.

   assets/games/real/ holds in-game captures for the local /ugs, /mc and /gn
   builds (see real-shots.js, which is generated). This file is the other half:
   hand-picked cover art for popular catalogue and hosted games that would
   otherwise fall back to a generated letter tile. Keys are titles normalised
   to letters and digits only, so "Bloons TD 5", "bloons td 5" and "BLOONS-TD-5"
   all match one entry. The art was ported from the Titanium Network Incognito
   project's cover set (GPL-3.0); these are the games' own cover images, used
   here to identify the games.

   The games seed in app.js swaps a generated thumbnail for the cover at load
   time, so adding a line here is all it takes to give a game real art. */

window.ChalkGameCovers = {
  "2048": "/assets/games/covers/2048.png",   /* 2048 */
  "agario": "/assets/games/covers/miniagario.png",   /* miniagario */
  "bloonstd": "/assets/games/covers/bloonstd.jpg",   /* bloonstd */
  "bloonstd2": "/assets/games/covers/bloonstd2.png",   /* bloonstd2 */
  "bloonstd5": "/assets/games/covers/bloons.webp",   /* bloons */
  "bloxors": "/assets/games/covers/bloxors.png",   /* bloxors */
  "crossyroads": "/assets/games/covers/crossy-road.png",   /* crossy-road */
  "dadish": "/assets/games/covers/dadish.png",   /* dadish */
  "dadish2": "/assets/games/covers/dadish-2.png",   /* dadish-2 */
  "doodlejumpgoober": "/assets/games/covers/doodle-jump.png",   /* doodle-jump */
  "ducklife": "/assets/games/covers/ducklife.webp",   /* ducklife */
  "ducklife1": "/assets/games/covers/ducklife.webp",   /* ducklife */
  "ducklife2": "/assets/games/covers/ducklife2.jpg",   /* ducklife2 */
  "ducklife3": "/assets/games/covers/ducklife3.jpg",   /* ducklife3 */
  "emulatorjs": "/assets/games/covers/emulatorjs.png",   /* emulatorjs */
  "flashtetris": "/assets/games/covers/flashtetris.png",   /* flashtetris */
  "frogger": "/assets/games/covers/frogger.jpeg",   /* frogger */
  "geometrydash3d": "/assets/games/covers/geometrydash.png",   /* geometrydash */
  "geometrydashsubzero": "/assets/games/covers/geometrydash.png",   /* geometrydash */
  "geometrydashwave": "/assets/games/covers/geometrydash.png",   /* geometrydash */
  "hexgl": "/assets/games/covers/hexgl.jpg",   /* hexgl */
  "madalinstuntcars2": "/assets/games/covers/stuntcars2.png",   /* stuntcars2 */
  "pacman": "/assets/games/covers/gpacman.jpg",   /* gpacman */
  "riddleschool": "/assets/games/covers/riddleschool.webp",   /* riddleschool */
  "riddleschool2": "/assets/games/covers/riddleschool2.webp",   /* riddleschool2 */
  "riddleschool3": "/assets/games/covers/riddleschool3.jpg",   /* riddleschool3 */
  "riddleschool4": "/assets/games/covers/riddleschool4.jpg",   /* riddleschool4 */
  "riddleschool5": "/assets/games/covers/riddleschool5.webp",   /* riddleschool5 */
  "shellshockers": "/assets/games/covers/shellshock.png",   /* shellshock */
  "slitherio": "/assets/games/covers/slitherio.webp",   /* slitherio */
  "slope2": "/assets/games/covers/slope-2.png",   /* slope-2 */
  "snake": "/assets/games/covers/snake.png",   /* snake */
  "stack": "/assets/games/covers/stack.png",   /* stack */
  "supermario63": "/assets/games/covers/mario.webp",   /* mario */
  "supermariobros": "/assets/games/covers/mario.webp",   /* mario */
  "supersmashflash": "/assets/games/covers/ssf.jpeg",   /* ssf */
  "tanktrouble": "/assets/games/covers/tanktrouble.webp",   /* tanktrouble */
  "tunnelrush": "/assets/games/covers/tunnel-rush.jpg",   /* tunnel-rush */
  "vex3": "/assets/games/covers/vex3.png",   /* vex3 */
  "vex4": "/assets/games/covers/vex4.png",   /* vex4 */
  "vex5": "/assets/games/covers/vex5.jpeg",   /* vex5 */
  "vex6": "/assets/games/covers/vex6.jpeg",   /* vex6 */
  "vex7": "/assets/games/covers/vex7.png",   /* vex7 */
  "worldshardestgame2": "/assets/games/covers/the-worlds-hardest-game-2.jpg",   /* the-worlds-hardest-game-2 */
};
