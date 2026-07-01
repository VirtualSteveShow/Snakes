# Snake — To-Do List

| Status | Item | Notes |
|--------|------|-------|
| ⬜ To Do | Coyote time experiments | Try: (1) wall coyote — 1 tick of grace if snake just clipped the wall, reverse direction instead of dying; (2) self-collision grace — currently tail tip is already excluded (`slice(0,-1)`), experiment with excluding 2 tail segments; (3) input buffer window — queue up to 2 direction inputs instead of 1 so fast double-turns feel more responsive. |
| ⬜ To Do | Snake trail system | Snake leaves a visible dirt/worn-grass trail on the bg where it has traveled. Track visited cells in a Map; overlay a semi-transparent dirt color per cell each draw frame. No second image needed — just a colored rect overlay between the bg and the snake. Optional: trail fades slowly over time so only recent path is dark. |
| ⬜ To Do | Food sprite variants | 3–5 fruit sprites (apple, strawberry, watermelon, cherry, grape) randomly assigned each spawn. 256×256, magenta BG for removal. |
| ✅ Done | v1.13 visual juice | Grass BG, bobbing food with shadow, debris particles, snake shadow, screen shake on eat, score pop (+1). |
| ✅ Done | v1.09 Advanced mode | Coins, shop block, 3 abilities (Tongue / Slow Time / Sidekick), ability bar UI, shop overlay. |
| ✅ Done | Per-mode/difficulty score tracking | Scores stored as `"${mode}-${difficulty}"` key; leaderboard filters by active mode+diff. |
| ✅ Done | Scale texture | Snake body uses `snake_scale.png` canvas pattern, anchored per-segment with setTransform. |
