# Relay fonts

Relay serves these fonts locally so desktop startup works offline and the renderer
needs no third-party font hosts. `app/src/fonts.css` retains Google Fonts' Unicode
subsets and uses `font-display: swap`.

Downloaded from the Google Fonts CSS API on 2026-10-11:

- Outfit: normal, variable weights 300–800.
- JetBrains Mono: normal, variable weights 300–700; italic weight 400.
- Orbitron: normal, variable weights 700–900.

Source: <https://fonts.googleapis.com/css2?family=Outfit:wght@300..800&family=JetBrains+Mono:ital,wght@0,300..700;1,400&family=Orbitron:wght@700..900&display=swap>

Each family's SIL Open Font License is included here, from the corresponding
`ofl/<family>/OFL.txt` in <https://github.com/google/fonts>.
