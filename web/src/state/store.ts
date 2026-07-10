import { create } from "zustand";
import type { CityMap, SessionMeta, Trace } from "../types";
import { loadFilters, saveFilters } from "./filters";

export type SceneView = "tree" | "terrain";

interface AppState {
  sessions: SessionMeta[];
  activeSessionKey?: string;
  trace?: Trace;
  city?: CityMap;
  currentSeq: number;
  selectedPath?: string;
  view: SceneView;
  loading: boolean;
  error?: string;
  hideEmpty: boolean;
  harnessFilter?: string;
  setView: (view: SceneView) => void;
  setSessions: (sessions: SessionMeta[]) => void;
  setActiveSession: (key: string) => void;
  setData: (trace: Trace, city: CityMap) => void;
  setCurrentSeq: (seq: number) => void;
  setSelectedPath: (path?: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error?: string) => void;
  setHideEmpty: (hideEmpty: boolean) => void;
  setHarnessFilter: (harness?: string) => void;
}

const initialFilters = loadFilters();

export const useAppStore = create<AppState>((set, get) => ({
  sessions: [],
  currentSeq: 0,
  view: "tree",
  loading: false,
  hideEmpty: initialFilters.hideEmpty,
  harnessFilter: initialFilters.harness,
  setView: (view) => set({ view }),
  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (activeSessionKey) =>
    set({ activeSessionKey, trace: undefined, city: undefined, currentSeq: 0 }),
  setData: (trace, city) => set({ trace, city, currentSeq: Math.max(0, trace.events.length - 1) }),
  setCurrentSeq: (currentSeq) => set({ currentSeq }),
  setSelectedPath: (selectedPath) => set({ selectedPath }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setHideEmpty: (hideEmpty) => {
    set({ hideEmpty });
    saveFilters({ hideEmpty, harness: get().harnessFilter });
  },
  setHarnessFilter: (harnessFilter) => {
    set({ harnessFilter });
    saveFilters({ hideEmpty: get().hideEmpty, harness: harnessFilter });
  }
}));
