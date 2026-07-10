import { memo } from "react";
import type { ActionCounts, CityMap, Trace } from "../types";
import type { SceneView } from "../state/store";

interface HudProps {
  trace?: Trace;
  city?: CityMap;
  view: SceneView;
  // live counts at the playhead, passed as primitives so memo stays effective
  editedNow: number;
  readNow: number;
  seenNow: number;
  onViewChange: (view: SceneView) => void;
}

// memo: the app re-renders every playback tick; the HUD only changes when the
// session, the view toggle, or the touch counts under the playhead change
export const Hud = memo(function Hud({ trace, city, view, editedNow, readNow, seenNow, onViewChange }: HudProps) {
  const stats = trace?.stats;
  const readFinal = stats ? stats.fovea - stats.edited : 0;
  const unvisitedNow = stats ? Math.max(0, stats.filesInRepo - editedNow - readNow - seenNow) : 0;
  const unvisitedFinal = stats ? Math.max(0, stats.filesInRepo - stats.fovea - stats.parafovea) : 0;
  return (
    <div className="hud" aria-hidden={!city}>
      <div className="hud-left">
        <div className="hud-repo">{city ? basename(city.repo.root) : ""}</div>
        {city ? (
          <div className="hud-commit">
            <span>{city.repo.commit || "worktree"}</span>
            {city.repo.dirty ? <span className="dirty">● dirty</span> : null}
            {trace?.session.model ? <span>{trace.session.model}</span> : null}
          </div>
        ) : null}
        {stats ? (
          <>
            {/* the spectrum doubles as scene legend and live tally: each entry is
                a touch state, counted at the playhead → across the whole walk */}
            <div className="spectrum">
              <SpectrumStat
                kind="edit"
                label="edited"
                now={editedNow}
                final={stats.edited}
                hint="Files the agent changed"
              />
              <SpectrumStat
                kind="read"
                label="read"
                now={readNow}
                final={readFinal}
                hint="Files the agent opened and read, but never changed"
              />
              <SpectrumStat
                kind="hit"
                label="seen"
                now={seenNow}
                final={stats.parafovea}
                hint="Files that only appeared in search results, never opened"
              />
              <SpectrumStat
                kind="unvisited"
                label="unvisited"
                now={unvisitedNow}
                final={unvisitedFinal}
                hint="Files in the map the agent never touched"
              />
            </div>
            {/* two quiet rows: the session's shape, then its friction — final
                totals only, unlike the playhead-live spectrum above */}
            <div className="hud-quiet">
              <span data-hint="Files in the repository map">{stats.filesInRepo} files</span>
              <span data-hint={`Tool events — ${mixHint(stats.actions)}`}>
                {countActions(stats.actions)} events
              </span>
              <span data-hint="User messages — each one starts a turn of agent work">
                {stats.userTurns} turns
              </span>
              {stats.subagents > 0 ? (
                <span data-hint="Subagent launches (Task/Agent)">
                  {stats.subagents} subagent{stats.subagents === 1 ? "" : "s"}
                </span>
              ) : null}
              {stats.compactions > 0 ? (
                <span data-hint="Context compactions — the conversation was summarized to free memory">
                  {stats.compactions} compaction{stats.compactions === 1 ? "" : "s"}
                </span>
              ) : null}
              <span data-hint="Tool output the agent consumed over the session">
                {fmtBytes(stats.resultBytes)} output
              </span>
            </div>
            <div className="hud-quiet">
              <span data-hint="Reads that re-read a file unchanged since its last read">
                re-reads {pct(stats.regressionRate)}
              </span>
              <span
                data-hint={
                  countActions(stats.errors) > 0
                    ? `${mixHint(stats.errors)} — press X to jump to the next one`
                    : "Tool calls that returned an error"
                }
              >
                errors {countActions(stats.errors)}
              </span>
              <span
                className={stats.actions.verify === 0 && stats.actions.edit > 0 ? "warn" : ""}
                data-hint="Commands recognized as builds or tests (go test, make test, npm run build, …) — pass/fail is not tracked"
              >
                verify ×{stats.actions.verify}
              </span>
              {stats.actions.verify > 0 && stats.editsAfterLastVerify > 0 ? (
                <span className="warn" data-hint="Edit events after the session's last build or test run">
                  {stats.editsAfterLastVerify} edits after last verify
                </span>
              ) : null}
              {stats.churnFiles > 0 ? (
                <span
                  className="warn"
                  data-hint={`Files edited in 3+ separate events — the most-edited file took ${stats.maxEditsPerFile} edits`}
                >
                  churn {stats.churnFiles} file{stats.churnFiles === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      {city ? (
        <div className="hud-right">
          <div className="view-toggle" role="group" aria-label="Scene view">
            <button className={view === "tree" ? "active" : ""} onClick={() => onViewChange("tree")}>
              Tree
            </button>
            <button className={view === "terrain" ? "active" : ""} onClick={() => onViewChange("terrain")}>
              Terrain
            </button>
          </div>
          <div className="encode-note">
            {view === "tree" ? "glow ∝ depth × revisits" : "height ∝ depth × revisits"}
          </div>
        </div>
      ) : null}
    </div>
  );
});

function SpectrumStat({
  kind,
  label,
  now,
  final,
  hint
}: {
  kind: "edit" | "read" | "hit" | "unvisited";
  label: string;
  now: number;
  final: number;
  hint: string;
}) {
  return (
    <div className="spectrum-stat" data-hint={hint}>
      <span className={`legend-dot ${kind}`} />
      <span className="spectrum-label">{label}</span>
      <strong>{now === final ? final : `${now} → ${final}`}</strong>
    </div>
  );
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

const ACTION_ORDER = ["search", "read", "edit", "exec", "verify", "other"] as const;

function countActions(counts: ActionCounts): number {
  return ACTION_ORDER.reduce((sum, key) => sum + counts[key], 0);
}

function mixHint(counts: ActionCounts): string {
  const parts = ACTION_ORDER.filter((key) => counts[key] > 0).map((key) => `${counts[key]} ${key}`);
  return parts.length ? parts.join(" · ") : "none";
}

function fmtBytes(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} B`;
  if (kb < 1000) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function basename(path: string): string {
  const clean = path.replace(/\/+$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1);
}
