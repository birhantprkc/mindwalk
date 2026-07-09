import { useCallback, useEffect, useMemo, useRef } from "react";
import { describeError, getCityMap, getTrace, listSessions } from "./api/client";
import { PlaybackEngine } from "./playback/reducer";
import { CityScene } from "./scene/CityScene";
import { TreeScene } from "./scene/TreeScene";
import { sessionVisible } from "./state/filters";
import { useAppStore } from "./state/store";
import { Hud } from "./ui/Hud";
import { Inspector } from "./ui/Inspector";
import { SessionRail } from "./ui/SessionRail";
import { Timeline } from "./ui/Timeline";
import "./styles.css";

export default function App() {
  const {
    sessions,
    activeSessionId,
    trace,
    city,
    currentSeq,
    selectedPath,
    view,
    loading,
    error,
    hideEmpty,
    harnessFilter,
    setView,
    setSessions,
    setActiveSession,
    setData,
    setCurrentSeq,
    setSelectedPath,
    setLoading,
    setError,
    setHideEmpty,
    setHarnessFilter
  } = useAppStore();
  const urlSessionConsumed = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const data = await listSessions();
      setSessions(data);
      let preferred: string | undefined;
      if (!urlSessionConsumed.current) {
        urlSessionConsumed.current = true;
        const fromUrl = new URL(window.location.href).searchParams.get("session") ?? undefined;
        if (fromUrl && data.some((session) => session.id === fromUrl)) {
          preferred = fromUrl;
        } else if (fromUrl) {
          console.warn(`session "${fromUrl}" not found; falling back to the latest session`);
        }
      }
      // a session can disappear between scans; fall back instead of pinning a dead id
      const stillListed = activeSessionId !== undefined && data.some((session) => session.id === activeSessionId);
      // prefer a session the rail will actually show; if the filters hide
      // everything, the newest session still beats a blank stage
      const fallback = (
        data.find((session) => sessionVisible(session, { hideEmpty, harness: harnessFilter })) ?? data[0]
      )?.id;
      const next = preferred ?? (stillListed ? activeSessionId : fallback);
      if (next && next !== activeSessionId) {
        setActiveSession(next);
      }
    } catch (err) {
      setError(describeError(err, "scanning sessions"));
    } finally {
      setLoading(false);
    }
  }, [activeSessionId, harnessFilter, hideEmpty, setActiveSession, setError, setLoading, setSessions]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    // rapid session switches: a slow response for the previous session must
    // not overwrite the newer one, nor clear its loading state early
    let stale = false;
    setLoading(true);
    setError(undefined);
    Promise.all([getTrace(activeSessionId), getCityMap(activeSessionId)])
      .then(([nextTrace, nextCity]) => {
        if (stale) return;
        setData(nextTrace, nextCity);
        setSelectedPath(undefined);
      })
      .catch((err) => {
        if (!stale) setError(describeError(err, "loading the session"));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [activeSessionId, setData, setError, setLoading, setSelectedPath]);

  const engine = useMemo(() => new PlaybackEngine(trace, city), [trace, city]);
  const playback = useMemo(() => engine.snapshotAt(currentSeq), [engine, currentSeq]);
  const selectedFile = useMemo(
    () => (selectedPath ? city?.files.find((file) => file.path === selectedPath) : undefined),
    [city, selectedPath]
  );

  return (
    <main className="app-frame">
      <SessionRail
        sessions={sessions}
        activeId={activeSessionId}
        loading={loading}
        hideEmpty={hideEmpty}
        harnessFilter={harnessFilter}
        onSelect={setActiveSession}
        onRefresh={refresh}
        onHideEmptyChange={setHideEmpty}
        onHarnessFilterChange={setHarnessFilter}
      />
      <section className="stage">
        <div className="viewport">
          {view === "tree" ? (
            <TreeScene city={city} playback={playback} selectedPath={selectedPath} onSelect={setSelectedPath} />
          ) : (
            <CityScene city={city} playback={playback} selectedPath={selectedPath} onSelect={setSelectedPath} />
          )}
          <Hud trace={trace} city={city} view={view} onViewChange={setView} />
          {selectedFile ? (
            <Inspector
              file={selectedFile}
              touch={playback.touchByPath.get(selectedFile.path)}
              history={playback.historyByPath.get(selectedFile.path) ?? []}
              onClose={() => setSelectedPath(undefined)}
              onJumpTo={setCurrentSeq}
            />
          ) : null}
          {!loading && sessions.length === 0 ? (
            <div className="empty-stage">
              <div className="card">
                <h2>No sessions found</h2>
                <p>
                  mindwalk scans <code>~/.claude/projects</code> and <code>~/.codex/sessions</code> for agent
                  traces. Run a session there, then refresh.
                </p>
              </div>
            </div>
          ) : null}
          {loading ? (
            <div className="toast">{sessions.length === 0 ? "Scanning sessions…" : "Reading trace…"}</div>
          ) : null}
          {error ? <div className="toast error">{error}</div> : null}
        </div>
        <Timeline trace={trace} currentSeq={currentSeq} onChange={setCurrentSeq} />
      </section>
    </main>
  );
}
