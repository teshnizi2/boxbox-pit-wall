# BoxBox: Beat the Pit Wall

Built on 19 October 2026 at the Elastic x Hopsworks F1 Hack Night in Amsterdam. All code was written on the day.

Max Verstappen lost his home race at Zandvoort in 2024. BoxBox lets you be the strategist. You replay the real 2024 Dutch Grand Prix lap by lap, press BOX, pick a tyre, and see the race re-rank on the real track map. You race three AI pit walls:

- **the real team**, the strategy that was actually used;
- **the optimizer**, which searches every 1-stop and 2-stop plan with our lap-time model;
- **Jev**, the TypeSafe System One model, which makes a typed BOX / STAY OUT call each lap with a probability.

Finished runs go to a leaderboard in Elastic, and the next player can race them as ghosts.

## How it works

```
Elastic Serverless (f1-* indices: 3,531 laps, 2,869,213 telemetry samples)
  |  ES|QL feature extraction (laps, weather, one STATS over all telemetry)
  v
Hopsworks Feature Store
  FG lap_features      2,769 race laps: tyre state, weather, pace deltas, stints derived from tyre-age resets
  FG driver_style      driving fingerprints from telemetry, with a vector index ("style twin" search)
  FG jev_pitwall_calls Jev's typed judgments per lap, stored as reusable features
  Feature View laptime_fv -> model boxbox_laptime (Model Registry, MAE 0.47 s on held-out stints)
  Deployment boxboxlaptime (Hopsworks model serving)
  |
  v
strategy.py: per-driver lap-time tables, optimizer, Jev ghost strategies, backtest
  |
  v
server.py (FastAPI) + app/static (game UI, vanilla JS)
  /api/jev       live Jev call (TypeSafe System One)
  /api/radio     race-engineer radio line, Claude Sonnet 5 called inside ES|QL (COMPLETION)
  /api/debrief   post-race debrief, same path
  /api/ask       Elastic Agent Builder agent "BoxBox Pit Wall" with custom ES|QL tools
  /api/runs      leaderboard in Elastic (boxbox-runs), shown on the Kibana dashboard "BoxBox Live"
```

The counterfactual is fair to reality. Your car's time is its real race time plus (model time of your strategy minus model time of the real strategy). Traffic, mistakes and noise stay as they were, and only the strategy changes. A dry race must use two compounds, otherwise you are disqualified.

## What the data says

- A pit stop costs 24.0 s at Zandvoort 2024 (in-lap plus out-lap versus clean pace, over 26 stops).
- The source pit flags are always false, so stops are derived from tyre-age resets.
- The model finds the best 1-stop at lap 29, Medium to Hard. The real teams stopped on laps 27 to 30. Verstappen's best possible strategy gains only 0.15 s, so no strategy beats Norris.
- Most time left on the table: Albon 14.6 s, Tsunoda 12.6 s, Bottas 11.9 s, Russell 9.7 s.
- Jev's first stop lands within 3 laps of the real team for 8 of 20 drivers, and its strategy beats the real one for 10 of 20.
- 2023 was wet. On a drying track, slick lap times improve with tyre age, so the model is trained on 2024 only.

## Run it

Needs Python 3.12, an Elastic Serverless project, a Hopsworks project and a TypeSafe key.

1. Put the keys in `repo/.env`: `REMOTE_ELASTICSEARCH_URL`, `REMOTE_ELASTICSEARCH_API_KEY`, `HOPSWORKS_HOST`, `HOPSWORKS_PROJECT`, `HOPSWORKS_API_KEY`, plus `SOURCE_ES_URL` and `SOURCE_ES_READONLY_KEY` for the data copy. Put `TYPESAFE_API_KEY` in the environment.
2. Run the pipeline in this order:
   1. `run_reindex.py` copies the data.
   2. `fetch_basic.py`
   3. `write_lap_fg.py`
   4. `style_fg.py`
   5. `train.py 2024 --register`
   6. `export_race.py`
   7. `strategy.py`
   8. `jev_fg.py`
   9. `push_backtest.py`
   10. `push_predictions.py`
   11. `elastic_setup.py`
   12. `deploy_model.py`
3. Start the server with `uvicorn server:app --port 8000`, then open http://localhost:8000. Controls: B then S/M/H to box, Space to pause, 1 to 4 to change speed.

`app/CONTRACT.md` describes the data files, the game math and the API.
