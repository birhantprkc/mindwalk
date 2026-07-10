import { memo } from "react";
import type { CityMap, Trace } from "../types";
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
            <div className="hud-quiet">
              <span data-hint="Files in the repository map">{stats.filesInRepo} files</span>
              <span data-hint="Reads that re-read a file unchanged since its last read">
                re-reads {pct(stats.regressionRate)}
              </span>
              <span data-hint="Tool calls that returned an error — press X to jump to the next one">
                errors {pct(stats.errorRate)}
              </span>
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

function basename(path: string): string {
  const clean = path.replace(/\/+$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1);
}
