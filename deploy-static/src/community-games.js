/* Curated open-source browser games and game hubs.
   These entries are metadata only: the projects remain hosted by their authors,
   and each card links back to the original repository for attribution. */
(function () {
  "use strict";

  var repoArt = function (repo) {
    return "https://opengraph.githubassets.com/1/" + repo;
  };

  window.ChalkCommunityGames = [
    {
      title: "2048 Lite",
      url: "https://attogram.github.io/2048-lite/",
      category: "Puzzle",
      thumb: repoArt("attogram/2048-lite"),
      sourceRepo: "https://github.com/attogram/2048-lite",
      license: "MIT",
      sourceLabel: "Open source pick",
      desc: "A clean, ad-free 2048 puzzle from the Attogram project."
    },
    {
      title: "Pac-Man Lite",
      url: "https://attogram.github.io/pacman-lite/",
      category: "Arcade",
      thumb: repoArt("attogram/pacman-lite"),
      sourceRepo: "https://github.com/attogram/pacman-lite",
      license: "GPL-3.0",
      sourceLabel: "Open source pick",
      desc: "Responsive HTML5 Pac-Man with keyboard controls."
    },
    {
      title: "Clumsy Bird",
      url: "https://ellisonleao.github.io/clumsy-bird/",
      category: "Arcade",
      thumb: repoArt("ellisonleao/clumsy-bird"),
      sourceRepo: "https://github.com/ellisonleao/clumsy-bird",
      license: "GPL-3.0",
      sourceLabel: "Open source pick",
      desc: "A MelonJS browser game inspired by Flappy Bird."
    },
    {
      title: "Canvas Vampire Survivors",
      url: "https://ricardo-foundry.github.io/canvas-vampire-survivors/",
      category: "Action",
      thumb: repoArt("ricardo-foundry/canvas-vampire-survivors"),
      sourceRepo: "https://github.com/ricardo-foundry/canvas-vampire-survivors",
      license: "MIT",
      sourceLabel: "Open source pick",
      desc: "A zero-runtime-dependency HTML5 canvas survivor game."
    },
    {
      title: "Sausi Games Hub",
      url: "https://sausi-7.github.io/games/",
      category: "Game hub",
      thumb: repoArt("sausi-7/games"),
      sourceRepo: "https://github.com/sausi-7/games",
      license: "MIT",
      sourceLabel: "Open source hub",
      desc: "A static collection of playable browser games with categories and search."
    },
    {
      title: "Attogram Open Source Arcade",
      url: "https://fosiper.com/games/",
      category: "Game hub",
      thumb: repoArt("attogram/games"),
      sourceRepo: "https://github.com/attogram/games",
      license: "MIT",
      sourceLabel: "Open source hub",
      desc: "A directory of open-source web games assembled by the Attogram builder."
    }
  ];
})();
