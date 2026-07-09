import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CityFile, CityMap, Touch } from "../types";
import { touchRank, type FilePlayback } from "../playback/reducer";
import { disposeGroup, EMBER, prefersReducedMotion, SKY, touchColors } from "./sceneUtils";
import { computeTreeLayout, type TreeLayout } from "./treeLayout";
import { fireflyTexture, haloTexture, labelTexture } from "./textures";
import { TrailRenderer } from "./trail";

interface TreeSceneProps {
  city?: CityMap;
  playback: FilePlayback;
  selectedPath?: string;
  onSelect: (path?: string) => void;
}

// Firefly tree: the repo is a radial tree — directories fork, files are
// leaves. The walker is a firefly that lights leaves as it lands; attention
// depth shows as the pool of light it leaves behind on the ground.
const colors: Record<Touch | "unvisited" | "ghost" | "selected", THREE.Color> = {
  unvisited: new THREE.Color("#5a6375"),
  ghost: new THREE.Color("#404552"),
  ...touchColors
};
const EDGE_BASE = new THREE.Color("#3c424f");
const LEAF_Y = 0.7;

function haloRadius(touch: Touch, visits: number): number {
  const base = touch === "edit" ? 3.4 : touch === "read" ? 2.3 : 1.3;
  return base * (1 + 0.3 * Math.log2(Math.max(visits, 1)));
}

interface HaloSlot {
  fileId: number;
  target: number;
  color: THREE.Color;
}

// reverse lookup for touchRank: rank → strongest touch at that rank
const rankTouch: Touch[] = ["hit", "hit", "read", "edit"];

export function TreeScene({ city, playback, selectedPath, onSelect }: TreeSceneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const leafMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const haloMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const edgesRef = useRef<THREE.LineSegments | null>(null);
  const edgeMetaRef = useRef<{ childPath?: string; childFileId?: number; vertexCount: number }[]>([]);
  const filesRef = useRef<CityFile[]>([]);
  const layoutRef = useRef<TreeLayout | null>(null);
  const slotsRef = useRef<HaloSlot[]>([]);
  const radiiRef = useRef<Map<number, number>>(new Map());
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const trailRef = useRef<TrailRenderer | null>(null);
  const fireflyRef = useRef<THREE.Sprite | null>(null);
  const frameRef = useRef<number | null>(null);
  const reducedRef = useRef(false);

  const layout = useMemo(() => (city && city.files.length > 0 ? computeTreeLayout(city.files) : null), [city]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reduced = prefersReducedMotion();
    reducedRef.current = reduced;

    const scene = new THREE.Scene();
    scene.background = SKY;
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(38, host.clientWidth / host.clientHeight, 0.1, 2400);
    camera.position.set(60, 110, 90);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    rendererRef.current = renderer;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reduced;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.44;
    controls.autoRotate = !reduced;
    controls.autoRotateSpeed = -0.5;
    controls.addEventListener("start", () => {
      controls.autoRotate = false;
    });
    controlsRef.current = controls;

    const sky = new THREE.HemisphereLight("#66779b", "#161922", 1.7);
    scene.add(sky);
    const moon = new THREE.DirectionalLight("#b6c5de", 1.1);
    moon.position.set(-60, 120, -40);
    scene.add(moon);

    // screen-space nearest-leaf picking: tiny orbs are hostile raycast
    // targets, so select whatever leaf lands closest to the pointer
    const PICK_RADIUS = 18;
    const projected = new THREE.Vector3();
    let downAt: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!downAt) return;
      const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
      downAt = null;
      if (moved > 5) return;
      const treeLayout = layoutRef.current;
      if (!treeLayout || !cameraRef.current || !rendererRef.current) return;
      const rect = rendererRef.current.domElement.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      let bestPath: string | undefined;
      let bestD2 = PICK_RADIUS * PICK_RADIUS;
      for (const file of filesRef.current) {
        const pos = treeLayout.leaf.get(file.id);
        if (!pos) continue;
        projected.set(pos.x, LEAF_Y, pos.z).project(cameraRef.current);
        if (projected.z > 1) continue;
        const sx = ((projected.x + 1) / 2) * rect.width;
        const sy = ((1 - projected.y) / 2) * rect.height;
        const d2 = (sx - px) * (sx - px) + (sy - py) * (sy - py);
        if (d2 < bestD2) {
          bestD2 = d2;
          bestPath = file.path;
        }
      }
      onSelect(bestPath);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    const resize = () => {
      if (!hostRef.current) return;
      const w = hostRef.current.clientWidth;
      const h = hostRef.current.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const clock = new THREE.Clock();
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const render = () => {
      controls.update();

      // pools of light grow toward their attention radius
      const halos = haloMeshRef.current;
      const slots = slotsRef.current;
      const radii = radiiRef.current;
      const treeLayout = layoutRef.current;
      if (halos && treeLayout && slots.length > 0) {
        let moving = false;
        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          const pos = treeLayout.leaf.get(slot.fileId);
          if (!pos) continue;
          let cur = radii.get(slot.fileId) ?? 0;
          const diff = slot.target - cur;
          if (Math.abs(diff) > 0.015) {
            cur = reducedRef.current ? slot.target : cur + diff * 0.12;
            radii.set(slot.fileId, cur);
            moving = true;
          } else if (cur !== slot.target) {
            radii.set(slot.fileId, slot.target);
            cur = slot.target;
            moving = true;
          }
          matrix.compose(
            new THREE.Vector3(pos.x, 0.06, pos.z),
            quaternion,
            new THREE.Vector3(Math.max(cur, 0.01) * 2, Math.max(cur, 0.01) * 2, 1)
          );
          halos.setMatrixAt(i, matrix);
        }
        if (moving) halos.instanceMatrix.needsUpdate = true;
      }

      const firefly = fireflyRef.current;
      if (firefly?.visible) {
        const t = clock.getElapsedTime();
        const base = firefly.userData.baseScale as number;
        const pulse = reducedRef.current ? 1 : 1 + 0.1 * Math.sin(t * 2.4);
        firefly.scale.setScalar(base * pulse);
      }
      renderer.render(scene, camera);
      frameRef.current = requestAnimationFrame(render);
    };
    render();

    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      scene.clear();
    };
  }, [onSelect]);

  // grow the skeleton: ground, edges, leaves, labels
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    filesRef.current = city?.files ?? [];
    layoutRef.current = layout;
    slotsRef.current = [];
    radiiRef.current = new Map();
    if (!city || !layout) return;

    const group = new THREE.Group();
    const size = layout.radius * 2.3;

    scene.fog = new THREE.Fog(SKY, size * 2.1, size * 4.2);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 6, size * 6),
      new THREE.MeshStandardMaterial({ color: "#14171e", roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.25;
    group.add(ground);

    const grid = new THREE.GridHelper(size * 2.4, 40, "#1d222c", "#181c25");
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.4;
    grid.position.y = -0.24;
    group.add(grid);

    // branch skeleton, one segment soup with per-vertex colors
    const positions: number[] = [];
    const edgeMeta: { childPath?: string; childFileId?: number; vertexCount: number }[] = [];
    for (const edge of layout.edges) {
      let count = 0;
      for (let i = 0; i < edge.points.length - 1; i++) {
        positions.push(edge.points[i].x, 0.12, edge.points[i].z);
        positions.push(edge.points[i + 1].x, 0.12, edge.points[i + 1].z);
        count += 2;
      }
      edgeMeta.push({ childPath: edge.childPath, childFileId: edge.childFileId, vertexCount: count });
    }
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const edgeColors = new Float32Array(positions.length);
    edgeGeo.setAttribute("color", new THREE.BufferAttribute(edgeColors, 3));
    const edges = new THREE.LineSegments(
      edgeGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 })
    );
    edgesRef.current = edges;
    edgeMetaRef.current = edgeMeta;
    group.add(edges);

    // leaves: one orb per file, sized by sqrt(lines)
    const leafGeo = new THREE.SphereGeometry(0.5, 10, 8);
    const leafMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, city.files.length);
    leaves.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(city.files.length * 3), 3);
    const matrix = new THREE.Matrix4();
    for (const file of city.files) {
      const pos = layout.leaf.get(file.id);
      if (!pos) continue;
      let scale = Math.min(0.24 + Math.sqrt(Math.max(file.lines, 1)) * 0.045, 1.05);
      if (file.ghost) scale *= 0.7;
      matrix.compose(new THREE.Vector3(pos.x, LEAF_Y, pos.z), new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale));
      leaves.setMatrixAt(file.id, matrix);
      leaves.setColorAt(file.id, file.ghost ? colors.ghost : colors.unvisited);
    }
    leaves.instanceMatrix.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    leafMeshRef.current = leaves;
    group.add(leaves);

    // pools of light under visited leaves
    const halos = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: haloTexture(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false
      }),
      city.files.length
    );
    halos.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(city.files.length * 3), 3);
    halos.count = 0;
    halos.frustumCulled = false;
    halos.raycast = () => undefined;
    haloMeshRef.current = halos;
    group.add(halos);

    // directory labels on the big branches
    const labeled = [...layout.dirs]
      .filter((dir) => dir.depth <= 2 && dir.fileCount >= Math.max(3, city.files.length * 0.015))
      .sort((a, b) => b.fileCount - a.fileCount)
      .slice(0, 18);
    for (const dir of labeled) {
      const { texture, aspect } = labelTexture(dir.name);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false })
      );
      const h = dir.depth === 1 ? 2.6 : 1.9;
      sprite.scale.set(h * aspect * 0.58, h * 0.58, 1);
      sprite.position.set(dir.x, 1.8, dir.z);
      sprite.raycast = () => undefined;
      group.add(sprite);
    }

    const firefly = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: fireflyTexture(),
        color: EMBER,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true
      })
    );
    firefly.userData.baseScale = Math.max(size * 0.026, 2.2);
    firefly.visible = false;
    fireflyRef.current = firefly;
    group.add(firefly);

    const trail = new TrailRenderer(1.6);
    trailRef.current = trail;
    group.add(trail.object);

    groupRef.current = group;
    scene.add(group);

    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (camera && controls) {
      camera.position.set(size * 0.3, size * 0.66, size * 0.47);
      controls.target.set(0, 0, 0);
      controls.minDistance = size * 0.15;
      controls.maxDistance = size * 2.4;
      controls.update();
    }

    return () => {
      disposeGroup(group);
      scene.remove(group);
      groupRef.current = null;
      leafMeshRef.current = null;
      haloMeshRef.current = null;
      edgesRef.current = null;
      trailRef.current = null;
      fireflyRef.current = null;
    };
  }, [city, layout]);

  // playback → leaf colors, halo targets, branch tinting
  useEffect(() => {
    const leaves = leafMeshRef.current;
    const halos = haloMeshRef.current;
    const edges = edgesRef.current;
    if (!leaves || !halos || !edges || !city || !layout) return;

    const radii = radiiRef.current;
    const slots: HaloSlot[] = [];
    const present = new Set<number>();
    // max touch rank per directory path, propagated from touched files
    const dirRank = new Map<string, number>();
    for (const file of city.files) {
      const touch = playback.touchByFile.get(file.id);
      const selected = file.path === selectedPath;
      let leafColor = file.ghost ? colors.ghost : colors.unvisited;
      if (touch) {
        leafColor = colors[touch];
        if (file.ghost) leafColor = leafColor.clone().lerp(colors.ghost, 0.4);
        const visits = playback.visitsByFile.get(file.id) ?? 1;
        slots.push({
          fileId: file.id,
          target: haloRadius(touch, visits),
          color: selected ? colors.selected : colors[touch]
        });
        present.add(file.id);
        const rank = touchRank[touch];
        const parts = file.path.split("/");
        let path = "";
        for (let i = 0; i < parts.length - 1; i++) {
          path = path ? `${path}/${parts[i]}` : parts[i];
          if ((dirRank.get(path) ?? 0) < rank) dirRank.set(path, rank);
        }
      }
      leaves.setColorAt(file.id, selected ? colors.selected : leafColor);
    }
    for (const [fileId, cur] of radii) {
      if (cur > 0.04 && !present.has(fileId)) {
        slots.push({ fileId, target: 0, color: colors.unvisited });
      } else if (cur <= 0.04 && !present.has(fileId)) {
        radii.delete(fileId);
      }
    }
    slots.forEach((slot, i) => halos.setColorAt(i, slot.color));
    halos.count = slots.length;
    if (halos.instanceColor) halos.instanceColor.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    slotsRef.current = slots;

    // tint branches that lead to light
    const colorAttr = edges.geometry.getAttribute("color") as THREE.BufferAttribute;
    const tinted = new THREE.Color();
    let vertex = 0;
    for (const meta of edgeMetaRef.current) {
      let rank = 0;
      if (meta.childFileId !== undefined) {
        const touch = playback.touchByFile.get(meta.childFileId);
        rank = touch ? touchRank[touch] : 0;
      } else if (meta.childPath) {
        rank = dirRank.get(meta.childPath) ?? 0;
      }
      if (rank > 0) {
        tinted.copy(EDGE_BASE).lerp(colors[rankTouch[rank]], 0.55);
      } else {
        tinted.copy(EDGE_BASE);
      }
      for (let v = 0; v < meta.vertexCount; v++) {
        colorAttr.setXYZ(vertex++, tinted.r, tinted.g, tinted.b);
      }
    }
    colorAttr.needsUpdate = true;
  }, [city, layout, playback, selectedPath]);

  // trail arcs + firefly
  useEffect(() => {
    const trail = trailRef.current;
    if (!trail || !city || !layout) return;

    // playback resolves fileId with the same path key the citymap uses, so a
    // target still missing one has no leaf to land on
    const targetFiles = playback.recentTargets
      .map((target) => (target.fileId !== undefined ? city.files[target.fileId] : undefined))
      .filter((file): file is CityFile => Boolean(file && layout.leaf.get(file.id)));

    const firefly = fireflyRef.current;
    if (firefly) {
      const head = targetFiles[targetFiles.length - 1];
      if (head) {
        const pos = layout.leaf.get(head.id)!;
        firefly.position.set(pos.x, LEAF_Y + 1.7, pos.z);
        firefly.visible = true;
      } else {
        firefly.visible = false;
      }
    }

    trail.update(
      targetFiles.map((file) => {
        const pos = layout.leaf.get(file.id)!;
        return new THREE.Vector3(pos.x, LEAF_Y + 0.3, pos.z);
      })
    );
  }, [city, layout, playback]);

  return <div className="city-scene" ref={hostRef} aria-label="Firefly tree" />;
}
