import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey, resolveDiffThemeName } from "../lib/diffRendering";
import { cn } from "~/lib/utils";

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";

const BORDERLESS_DIFF_RENDER_FILE_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  borderRadius: 0,
  overflow: "visible",
};

const DIFF_VIEWER_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;
  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));
  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));
  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--destructive));
  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  display: none !important;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}

[data-file] ::selection,
[data-diff] ::selection {
  background: color-mix(in srgb, var(--primary) 45%, transparent) !important;
  color: var(--foreground) !important;
}
`;

type RenderablePatch =
  | { readonly kind: "files"; readonly files: readonly FileDiffMetadata[] }
  | { readonly kind: "raw"; readonly text: string; readonly reason: string };

interface PatchDiffViewerProps {
  readonly patch: string;
  readonly cacheScope: string;
  readonly emptyLabel: string;
  readonly onOpenFile?: (path: string) => void;
  readonly renderMode?: DiffRenderMode;
  readonly showChangeOverview?: boolean;
  readonly wordWrap?: boolean;
}

interface ChangeOverviewMarker {
  readonly type: "addition" | "deletion";
  readonly startLine: number;
  readonly endLine: number;
}

interface ChangeOverviewData {
  readonly totalLines: number;
  readonly markers: readonly ChangeOverviewMarker[];
}

interface ScrollOverviewState {
  readonly topPercent: number;
  readonly heightPercent: number;
}

interface VisualOverviewMarker {
  readonly type: "addition" | "deletion";
  readonly top: number;
  readonly height: number;
}

function getRenderablePatch(patch: string, cacheScope: string): RenderablePatch | null {
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    return files.length > 0
      ? { kind: "files", files }
      : { kind: "raw", text: normalizedPatch, reason: "Unsupported diff format." };
  } catch {
    return { kind: "raw", text: normalizedPatch, reason: "Failed to parse patch." };
  }
}

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function parseChangeOverviewData(patch: string): ChangeOverviewData | null {
  const markers: ChangeOverviewMarker[] = [];
  let totalLines = 0;
  let newLine = 0;

  const pushMarker = (type: ChangeOverviewMarker["type"], line: number) => {
    const normalizedLine = Math.max(1, line);
    const previous = markers.at(-1);
    if (previous && previous.type === type && previous.endLine + 1 >= normalizedLine) {
      markers[markers.length - 1] = {
        ...previous,
        endLine: Math.max(previous.endLine, normalizedLine),
      };
      return;
    }
    markers.push({ type, startLine: normalizedLine, endLine: normalizedLine });
  };

  for (const line of patch.split(/\r?\n/g)) {
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch) {
      newLine = Number.parseInt(hunkMatch[2] ?? "1", 10);
      const newCount = Number.parseInt(hunkMatch[3] ?? "1", 10);
      totalLines = Math.max(totalLines, newLine + Math.max(0, newCount - 1));
      continue;
    }

    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      pushMarker("addition", newLine);
      newLine += 1;
      totalLines = Math.max(totalLines, newLine);
      continue;
    }
    if (line.startsWith("-")) {
      pushMarker("deletion", newLine);
      totalLines = Math.max(totalLines, newLine);
      continue;
    }
    if (line.startsWith(" ")) {
      newLine += 1;
      totalLines = Math.max(totalLines, newLine);
    }
  }

  return markers.length > 0 && totalLines > 0
    ? { totalLines, markers: mergeChangeOverviewMarkers(markers) }
    : null;
}

function mergeChangeOverviewMarkers(
  markers: readonly ChangeOverviewMarker[],
): readonly ChangeOverviewMarker[] {
  return (["addition", "deletion"] as const).flatMap((type) => {
    const typedMarkers = markers
      .filter((marker) => marker.type === type)
      .toSorted((left, right) => left.startLine - right.startLine);
    const merged: ChangeOverviewMarker[] = [];

    for (const marker of typedMarkers) {
      const previous = merged.at(-1);
      if (previous && previous.endLine + 1 >= marker.startLine) {
        merged[merged.length - 1] = {
          ...previous,
          endLine: Math.max(previous.endLine, marker.endLine),
        };
        continue;
      }
      merged.push(marker);
    }

    return merged;
  });
}

function findScrollableElement(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  return root.querySelector<HTMLElement>(".diff-render-surface") ?? root;
}

function readScrollOverviewState(scrollContainer: HTMLElement | null): ScrollOverviewState {
  if (!scrollContainer) {
    return { topPercent: 0, heightPercent: 100 };
  }
  const maxScroll = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
  if (maxScroll <= 2) {
    return { topPercent: 0, heightPercent: 100 };
  }
  return {
    topPercent: (scrollContainer.scrollTop / scrollContainer.scrollHeight) * 100,
    heightPercent: Math.min(
      100,
      (scrollContainer.clientHeight / scrollContainer.scrollHeight) * 100,
    ),
  };
}

function ChangeOverview(props: {
  readonly data: ChangeOverviewData;
  readonly scrollContainer: HTMLElement | null;
}) {
  const { data, scrollContainer } = props;
  const railRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pendingPointerYRef = useRef<number | null>(null);
  const pendingScrollFrameRef = useRef<number | null>(null);
  const visualMarkers = useMemo(() => buildVisualOverviewMarkers(data), [data]);

  useLayoutEffect(() => {
    if (!scrollContainer) return;
    const update = () => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const nextState = readScrollOverviewState(scrollContainer);
      viewport.style.top = `${nextState.topPercent}%`;
      viewport.style.height = `${Math.max(4, nextState.heightPercent)}%`;
    };

    update();
    const animationFrame = window.requestAnimationFrame(update);
    scrollContainer.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scrollContainer);
    for (const child of Array.from(scrollContainer.children)) {
      if (child instanceof HTMLElement) {
        observer.observe(child);
      }
    }
    return () => {
      window.cancelAnimationFrame(animationFrame);
      scrollContainer.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [scrollContainer]);

  const scrollToPointer = useCallback(
    (clientY: number) => {
      if (!scrollContainer || !railRef.current) return;
      const maxScroll = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      if (maxScroll <= 2) return;
      const rect = railRef.current.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height)));
      const targetScrollTop =
        ratio * scrollContainer.scrollHeight - scrollContainer.clientHeight / 2;
      scrollContainer.scrollTop = Math.min(Math.max(0, targetScrollTop), maxScroll);
    },
    [scrollContainer],
  );

  const scheduleScrollToPointer = useCallback(
    (clientY: number) => {
      pendingPointerYRef.current = clientY;
      if (pendingScrollFrameRef.current !== null) return;
      pendingScrollFrameRef.current = window.requestAnimationFrame(() => {
        pendingScrollFrameRef.current = null;
        const nextPointerY = pendingPointerYRef.current;
        if (nextPointerY === null) return;
        scrollToPointer(nextPointerY);
      });
    },
    [scrollToPointer],
  );

  useLayoutEffect(
    () => () => {
      if (pendingScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingScrollFrameRef.current);
      }
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      scheduleScrollToPointer(event.clientY);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [scheduleScrollToPointer],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      scheduleScrollToPointer(event.clientY);
    },
    [scheduleScrollToPointer],
  );

  return (
    <div
      ref={railRef}
      className="group absolute top-0 right-0 bottom-0 z-20 w-10 bg-muted/20 transition-colors hover:bg-muted/35"
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
    >
      <div
        ref={viewportRef}
        className="absolute right-0 left-0 bg-foreground/8 transition-colors group-hover:bg-foreground/14"
      />
      {visualMarkers.map((marker) => {
        return (
          <span
            key={`${marker.type}:${marker.top}:${marker.height}`}
            className={cn(
              "absolute transition-colors",
              marker.type === "addition"
                ? "left-0 w-1/2 bg-emerald-500/25 group-hover:bg-emerald-500/45"
                : "right-0 w-1/2 bg-red-500/25 group-hover:bg-red-500/45",
            )}
            style={{ top: `${marker.top}%`, height: `${marker.height}%` }}
          />
        );
      })}
    </div>
  );
}

function buildVisualOverviewMarkers(data: ChangeOverviewData): readonly VisualOverviewMarker[] {
  const minHeight = 1.2;
  return (["addition", "deletion"] as const).flatMap((type) => {
    const markers = data.markers
      .filter((marker) => marker.type === type)
      .map((marker) => {
        const top = ((marker.startLine - 1) / data.totalLines) * 100;
        const rawHeight = ((marker.endLine - marker.startLine + 1) / data.totalLines) * 100;
        return { type, top, height: Math.max(minHeight, rawHeight) };
      })
      .toSorted((left, right) => left.top - right.top);
    const merged: VisualOverviewMarker[] = [];

    for (const marker of markers) {
      const previous = merged.at(-1);
      if (previous && previous.top + previous.height >= marker.top) {
        const bottom = Math.max(previous.top + previous.height, marker.top + marker.height);
        merged[merged.length - 1] = {
          ...previous,
          height: bottom - previous.top,
        };
        continue;
      }
      merged.push(marker);
    }

    return merged;
  });
}

export function PatchDiffViewer({
  patch,
  cacheScope,
  emptyLabel,
  onOpenFile,
  renderMode = "stacked",
  showChangeOverview = false,
  wordWrap = false,
}: PatchDiffViewerProps) {
  const virtualizerWrapperRef = useRef<HTMLDivElement | null>(null);
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(null);
  const { resolvedTheme } = useTheme();
  const renderablePatch = useMemo(() => getRenderablePatch(patch, cacheScope), [cacheScope, patch]);
  const changeOverview = useMemo(
    () => (showChangeOverview ? parseChangeOverviewData(patch) : null),
    [patch, showChangeOverview],
  );

  useLayoutEffect(() => {
    const nextScrollContainer = findScrollableElement(virtualizerWrapperRef.current);
    setScrollContainer(nextScrollContainer);
  }, [renderablePatch, showChangeOverview]);

  if (!renderablePatch) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-muted-foreground text-sm">
        {emptyLabel}
      </div>
    );
  }

  if (renderablePatch.kind === "raw") {
    return (
      <div className="h-full overflow-auto p-2">
        <p className="mb-2 text-muted-foreground text-xs">{renderablePatch.reason}</p>
        <pre
          className={cn(
            "rounded-md border border-border bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground",
            wordWrap ? "whitespace-pre-wrap wrap-break-word" : "overflow-auto",
          )}
        >
          {renderablePatch.text}
        </pre>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <div ref={virtualizerWrapperRef} className="h-full min-h-0">
        <Virtualizer
          className={cn(
            "diff-render-surface h-full min-h-0 overflow-auto",
            changeOverview && "pr-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          )}
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          {renderablePatch.files.map((fileDiff) => {
            const filePath = resolveFileDiffPath(fileDiff);
            return (
              <div
                key={`${buildFileDiffRenderKey(fileDiff)}:${resolvedTheme}`}
                className="diff-render-file"
                style={BORDERLESS_DIFF_RENDER_FILE_STYLE}
                onClickCapture={(event) => {
                  if (!onOpenFile) return;
                  const nativeEvent = event.nativeEvent as MouseEvent;
                  const composedPath = nativeEvent.composedPath?.() ?? [];
                  const clickedHeader = composedPath.some(
                    (node) => node instanceof Element && node.hasAttribute("data-title"),
                  );
                  if (clickedHeader && filePath) {
                    onOpenFile(filePath);
                  }
                }}
              >
                <FileDiff
                  fileDiff={fileDiff}
                  options={{
                    diffStyle: renderMode === "split" ? "split" : "unified",
                    lineDiffType: "none",
                    overflow: wordWrap ? "wrap" : "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme as DiffThemeType,
                    unsafeCSS: DIFF_VIEWER_UNSAFE_CSS,
                  }}
                />
              </div>
            );
          })}
        </Virtualizer>
      </div>
      {changeOverview ? (
        <ChangeOverview data={changeOverview} scrollContainer={scrollContainer} />
      ) : null}
    </div>
  );
}
