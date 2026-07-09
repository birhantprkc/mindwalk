import { memo } from "react";
import type { CityMap, Trace } from "../types";
import type { SceneView } from "../state/store";

interface HudProps {
  trace?: Trace;
  city?: CityMap;
  view: SceneView;
  onViewChange: (view: SceneView) => void;
}

// memo: the app re-renders every playback tick; the HUD only depends on the
// loaded session and the view toggle
export const Hud = memo(function Hud({ trace, city, view, onViewChange }: HudProps) {
  const stats = trace?.stats;
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
          <div className="hud-stats">
            <Stat label="files" value={stats.filesInRepo} hint="Files in the repository map" />
            <Stat label="fovea" value={stats.fovea} hint="Files the agent opened — read or edited" />
            <Stat label="parafovea" value={stats.parafovea} hint="Files only seen in search results, never opened" />
            <Stat label="edited" value={stats.edited} hint="Files the agent changed" />
            <Stat
              label="regression"
              value={`${Math.round(stats.regressionRate * 100)}%`}
              hint="Reads that re-read a file unchanged since its last read"
            />
            <Stat
              label="errors"
              value={`${Math.round(stats.errorRate * 100)}%`}
              hint="Tool calls that returned an error"
            />
          </div>
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
          <div className="legend">
          <div className="legend-row">
            <span className="legend-dot edit" />
            <span>edited</span>
          </div>
          <div className="legend-row">
            <span className="legend-dot read" />
            <span>read</span>
          </div>
          <div className="legend-row">
            <span className="legend-dot hit" />
            <span>search hit</span>
          </div>
          <div className="legend-row">
            <span className="legend-dot unvisited" />
            <span>unvisited</span>
          </div>
          <div className="legend-note">
            {view === "tree" ? "glow ∝ depth × revisits" : "height ∝ depth × revisits"}
          </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});

function Stat({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="stat" title={hint}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function basename(path: string): string {
  const clean = path.replace(/\/+$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1);
}
