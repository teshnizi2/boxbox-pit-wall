# BoxBox data + API contract (UI <-> server)

Server: FastAPI on http://localhost:8000, serves `app/static/` at `/` and JSON at `/data/...`.
All times are seconds (float). Laps are 1-based. Race = 2024 Dutch GP, 72 laps.

## GET /data/race.json
```json
{
  "season": 2024, "event": "Dutch Grand Prix", "laps_total": 72, "pit_loss_s": 21.0,
  "track": { "path": [[x, y], ...], "frac": [0.0, ..., 1.0] },
  "drivers": [
    { "code": "VER", "name": "Max Verstappen", "team": "Red Bull Racing", "color": "#3671C6",
      "grid": 2, "finish": 2,
      "lap_times": [80.1, 76.2, ...],          // 72 values, real lap times
      "cum": [80.1, 156.3, ...],              // 72 values, real cumulative race time at end of each lap
      "stints": [ {"compound": "MEDIUM", "start_lap": 1, "end_lap": 28, "start_age": 1}, ... ] }
  ]
}
```
- `track.path`: one reference lap's x/y, already scaled to a 0..1000 box (y up = screen up, flip if needed). `frac[i]` = fraction of lap TIME elapsed at point i (0..1). To place a car that is `f` (0..1) through its current lap: find i with frac[i] <= f, interpolate.
- Car position at race time T: lap k = first lap with cum[k] >= T; f = (T - cum[k-1]) / lap_times[k].

## GET /data/driver_{CODE}.json
```json
{
  "code": "VER",
  "start": {"compound": "MEDIUM", "age": 1},
  "cliff": {"SOFT": 22, "MEDIUM": 35, "HARD": 48},     // tyre age where the cliff starts (UI tyre health bar)
  "pred": {"SOFT": [[...72 lap times...] x 60 ages], "MEDIUM": [...], "HARD": [...]},
  "real_pred_cum": [ ...72 values... ],                // model cumulative time of the REAL strategy (pit loss included)
  "deg_note": "Soft +0.09 s/lap, Medium +0.05, Hard +0.03",
  "optimizer": {"stints": [...same shape as stints...], "delta_vs_real": -3.2},
  "jev": {"stints": [...], "delta_vs_real": -1.1,
          "calls": [{"lap": 1, "call": "STAY_OUT", "p_box": 0.04, "cliff_risk": 0.1, "undercut": 0.2}, ...]}
}
```
- `pred[c][age-1][lap-1]` = model lap time for race lap `lap` on compound `c` with tyre age `age` (cliff already included).

## Game math (client side, must match exactly)
- Player strategy = list of stints. Pitting "at the end of lap L" adds `pit_loss_s` to lap L; the new tyre has age 1 on lap L+1.
- player_pred_lap(L) = pred[compound][age-1][L-1] (+ pit_loss_s if pitting at end of L). player_pred_cum(L) = running sum.
- player_cum(L) = driver.cum[L-1] + (player_pred_cum(L) - real_pred_cum[L-1]).  Replaying the real strategy gives delta 0.
- Position at lap L = rank of player_cum(L) among the other 19 drivers' real cum[L-1].
- Rule: a dry race must use at least 2 different compounds, else DSQ at the flag.
- Final score = real finish position - player finish position (positions gained), tie-break by time delta (negative = faster).

## API (POST bodies JSON)
- `POST /api/jev` `{lap, laps_left, compound, age, position, gap_ahead, gap_behind, compounds_used:[...], gain_if_box:{SOFT:s,MEDIUM:s,HARD:s}}` -> `{call: "BOX_SOFT"|"BOX_MEDIUM"|"BOX_HARD"|"STAY_OUT", p_box, cliff_risk, undercut, ms}`
- `POST /api/radio` `{lap, driver, event, detail}` -> `{text}`  (short race-engineer line, Claude Sonnet 5 via Elastic ES|QL COMPLETION)
- `POST /api/debrief` `{driver, player_name, stints, finish, real_finish, delta_s, optimizer_delta, jev_delta}` -> `{text}`
- `POST /api/ask` `{question, conversation_id?}` -> `{answer, conversation_id, esql: [...]}`  (Elastic Agent Builder agent `boxbox-pitwall`)
- `POST /api/runs` `{player_name, driver, stints, finish, real_finish, positions_gained, delta_s, dsq}` -> `{ok, rank}`
- `GET /api/leaderboard` -> `[{player_name, driver, positions_gained, delta_s, finish, stints_label, stints}]`

## Multiplayer
- **Ghosts (must):** any `{player_name, driver, stints}` can be drawn as a ghost car with the same game math (its driver's `driver_{CODE}.json` + `race.json`). Before a race the player can tick up to 3 leaderboard ghosts to race against; ghosts show on the track map and in the timing tower (marked).
- **Live room (stretch):** `POST /api/room/{room}/state` `{player_name, driver, stints, lap}` (send on every BOX and every 5 laps) and `GET /api/room/{room}` -> `{started_at, players:[{player_name, driver, stints, lap}]}`. A "big screen" view (`/?room=X&screen=1`) polls every 1 s and draws all players as ghosts. The same ghost renderer is used for both.
