import type { EnvironmentId, ProjectListDirectoryEntry } from "@t3tools/contracts";
import type { FileTreeDirectoryHandle, FileTreeIcons, GitStatusEntry } from "@pierre/trees";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import Editor, { loader, type BeforeMount, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import {
  Columns2Icon,
  FileTextIcon,
  GitBranchIcon,
  ListTreeIcon,
  Minimize2Icon,
  PanelRightCloseIcon,
  Loader2Icon,
  RefreshCwIcon,
  Rows3Icon,
  TextWrapIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { getSetiFileIconSymbol, getSetiFileIconUrl } from "../file-explorer-icons";
import { refreshGitStatus, useGitStatus } from "../lib/gitStatusState";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { PatchDiffViewer } from "./PatchDiffViewer";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import { stackedThreadToast, toastManager } from "./ui/toast";

loader.config({ monaco });

const ROOT_PATH = ".";
const WORKSPACE_EDITOR_STATE_STORAGE_PREFIX = "t3code:workspace-editor:v1:";
const DEFAULT_PANEL_WIDTH = 720;
const MIN_PANEL_WIDTH = 420;
const MIN_CHAT_WIDTH = 420;

interface WorkspaceEditorPanelProps {
  environmentId: EnvironmentId;
  cwd: string | null | undefined;
  fallbackCwd?: string | null | undefined;
  fallbackCwds?: ReadonlyArray<string | null | undefined>;
  openFileRequest?: { readonly relativePath: string; readonly requestId: number } | null;
  viewRequest?: { readonly view: WorkspaceEditorView; readonly requestId: number } | null;
  toggleShortcutLabel: string;
  onViewChange?: (view: WorkspaceEditorView) => void;
  onClose: () => void;
}

interface OpenFileState {
  readonly path: string;
  readonly savedContents: string;
  readonly draftContents: string;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
}

type WorkspaceEditorView = "git" | "trees";
type GitDiffRenderMode = "stacked" | "split";

interface GitDiffState {
  readonly path: string;
  readonly patch: string;
  readonly loading: boolean;
  readonly error: string | null;
}

type GitDiffCache = Readonly<Record<string, string>>;

interface PersistedWorkspaceEditorState {
  readonly openFilePath: string | null;
  readonly expandedDirectories: readonly string[];
  readonly panelWidth: number | null;
}

const DEFAULT_WORKSPACE_EDITOR_STATE: PersistedWorkspaceEditorState = {
  openFilePath: null,
  expandedDirectories: [ROOT_PATH],
  panelWidth: DEFAULT_PANEL_WIDTH,
};

const EMPTY_PATCH = "";
const monacoTypeScriptExtensions = new Set(["ts", "mts", "cts"]);
const monacoJavaScriptExtensions = new Set(["js", "mjs", "cjs"]);
const monacoCppExtensions = new Set(["c", "h", "cc", "cpp", "cxx", "hpp", "hxx", "hh"]);

const monacoLanguageByExtension: Record<string, string> = {
  css: "css",
  go: "go",
  html: "html",
  htm: "html",
  java: "java",
  json: "json",
  jsx: "javascript",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  pyw: "python",
  rb: "ruby",
  rs: "rust",
  sql: "sql",
  svg: "xml",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

function dirname(pathValue: string): string {
  const index = pathValue.lastIndexOf("/");
  return index === -1 ? ROOT_PATH : pathValue.slice(0, index);
}

function basename(pathValue: string): string {
  const index = pathValue.lastIndexOf("/");
  return index === -1 ? pathValue : pathValue.slice(index + 1);
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function setiTreeIconId(fileName: string): string {
  return `t3-seti-${hashString(fileName.toLowerCase())}`;
}

function ancestorDirectoryPaths(pathValue: string): string[] {
  const directories: string[] = [];
  let current = dirname(pathValue);
  while (current !== ROOT_PATH) {
    directories.unshift(current);
    current = dirname(current);
  }
  return directories;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function createUntrackedFilePatch(relativePath: string, contents: string): string {
  const lines = contents.length > 0 ? contents.replace(/\r\n/g, "\n").split("\n") : [];
  const lineCount = lines.at(-1) === "" ? Math.max(0, lines.length - 1) : lines.length;
  const addedLines = lines.slice(0, lineCount).map((line) => `+${line}`);
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lineCount} @@`,
    ...addedLines,
  ].join("\n");
}

function gitDiffCacheKey(relativePath: string, fullContext: boolean): string {
  return `${fullContext ? "full" : "hunks"}:${relativePath}`;
}

function clampWorkspaceEditorPanelWidth(width: number): number {
  const maxWidth =
    typeof window === "undefined"
      ? 960
      : Math.max(MIN_PANEL_WIDTH, window.innerWidth - MIN_CHAT_WIDTH);
  return Math.min(Math.max(width, MIN_PANEL_WIDTH), maxWidth);
}

function workspaceEditorStateStorageKey(environmentId: EnvironmentId, cwd: string): string {
  return `${WORKSPACE_EDITOR_STATE_STORAGE_PREFIX}${environmentId}:${cwd}`;
}

function normalizeWorkspaceEditorState(input: unknown): PersistedWorkspaceEditorState {
  if (!input || typeof input !== "object") {
    return DEFAULT_WORKSPACE_EDITOR_STATE;
  }
  const parsed = input as Partial<PersistedWorkspaceEditorState>;
  const expandedDirectories =
    Array.isArray(parsed.expandedDirectories) && parsed.expandedDirectories.length > 0
      ? parsed.expandedDirectories.filter(
          (path): path is string => typeof path === "string" && path.length > 0,
        )
      : DEFAULT_WORKSPACE_EDITOR_STATE.expandedDirectories;
  const openFilePath =
    typeof parsed.openFilePath === "string" && parsed.openFilePath.length > 0
      ? parsed.openFilePath
      : null;
  const panelWidth =
    typeof parsed.panelWidth === "number" && Number.isFinite(parsed.panelWidth)
      ? clampWorkspaceEditorPanelWidth(parsed.panelWidth)
      : DEFAULT_PANEL_WIDTH;

  return {
    openFilePath,
    expandedDirectories: Array.from(new Set([ROOT_PATH, ...expandedDirectories])),
    panelWidth,
  };
}

function readWorkspaceEditorState(storageKey: string): PersistedWorkspaceEditorState {
  if (typeof window === "undefined") return DEFAULT_WORKSPACE_EDITOR_STATE;

  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? normalizeWorkspaceEditorState(JSON.parse(raw)) : DEFAULT_WORKSPACE_EDITOR_STATE;
  } catch {
    return DEFAULT_WORKSPACE_EDITOR_STATE;
  }
}

function writeWorkspaceEditorState(storageKey: string, state: PersistedWorkspaceEditorState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Ignore localStorage failures; the editor should remain usable without persistence.
  }
}

function ExplorerEntryIcon(props: { path: string; kind: "file" | "directory" }) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  if (props.kind === "directory") {
    return null;
  }
  const iconUrl = getSetiFileIconUrl(props.path);
  if (failedIconUrl === iconUrl) {
    return <span className="size-4 shrink-0" />;
  }
  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      className="size-4 shrink-0"
      loading="lazy"
      onError={() => setFailedIconUrl(iconUrl)}
    />
  );
}

function GitChangeRow(props: {
  path: string;
  insertions: number;
  deletions: number;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  const slashIndex = props.path.lastIndexOf("/");
  const name = slashIndex >= 0 ? props.path.slice(slashIndex + 1) : props.path;
  const directory = slashIndex >= 0 ? props.path.slice(0, slashIndex) : "";

  return (
    <button
      type="button"
      className={cn(
        "flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 px-2 text-left text-xs transition-colors hover:bg-accent/60",
        props.selected && "bg-accent text-accent-foreground",
      )}
      title={props.path}
      onClick={() => props.onSelect(props.path)}
    >
      <ExplorerEntryIcon path={props.path} kind="file" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-foreground">{name}</span>
        {directory ? <span className="ml-1 text-muted-foreground">{directory}</span> : null}
      </span>
      <GitChangeCounts insertions={props.insertions} deletions={props.deletions} />
    </button>
  );
}

function GitChangeCounts(props: { readonly insertions: number; readonly deletions: number }) {
  if (props.insertions === 0 && props.deletions === 0) {
    return null;
  }
  return (
    <span className="flex shrink-0 items-center gap-1">
      {props.insertions > 0 ? (
        <span className="text-[11px] text-emerald-400">+{props.insertions}</span>
      ) : null}
      {props.deletions > 0 ? (
        <span className="text-[11px] text-red-400">-{props.deletions}</span>
      ) : null}
    </span>
  );
}

function basenameOfPath(pathValue: string): string {
  const lastSlashIndex = Math.max(pathValue.lastIndexOf("/"), pathValue.lastIndexOf("\\"));
  return lastSlashIndex === -1 ? pathValue : pathValue.slice(lastSlashIndex + 1);
}

function extensionOfBasename(basename: string): string {
  const extensionSeparatorIndex = basename.lastIndexOf(".");
  return extensionSeparatorIndex === -1 ? "" : basename.slice(extensionSeparatorIndex + 1);
}

function monacoLanguageForPath(pathValue: string): string {
  const basename = basenameOfPath(pathValue);
  const lowerBasename = basename.toLowerCase();
  const extension = extensionOfBasename(lowerBasename);

  if (lowerBasename === "dockerfile") return "dockerfile";
  if (lowerBasename === "makefile") return "makefile";
  if (lowerBasename === "tsconfig.json") return "json";
  if (monacoCppExtensions.has(extension)) return "cpp";
  if (monacoTypeScriptExtensions.has(extension)) return "typescript";
  if (monacoJavaScriptExtensions.has(extension)) return "javascript";
  if (monacoLanguageByExtension[extension]) return monacoLanguageByExtension[extension];
  return "plaintext";
}

function MonacoWorkspaceEditor(props: {
  readonly path: string;
  readonly value: string;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
  readonly onEditorMount?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
  readonly onSave: () => void;
}) {
  const onSaveRef = useRef(props.onSave);
  onSaveRef.current = props.onSave;
  const onEditorMountRef = useRef(props.onEditorMount);
  onEditorMountRef.current = props.onEditorMount;

  const beforeMount = useCallback<BeforeMount>((monaco) => {
    monaco.editor.defineTheme("t3code-monaco-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "7f848e" },
        { token: "keyword", foreground: "c678dd" },
        { token: "string", foreground: "98c379" },
        { token: "number", foreground: "d19a66" },
        { token: "type", foreground: "56b6c2" },
      ],
      colors: {
        "editor.background": "#151516",
        "editor.foreground": "#d4d4d8",
        "editor.inactiveSelectionBackground": "#2f3b523f",
        "editor.lineHighlightBackground": "#242426",
        "editor.selectionBackground": "#2f4f7f66",
        "editorCursor.foreground": "#e4e4e7",
        "editorGutter.background": "#151516",
        "editorIndentGuide.activeBackground1": "#4a4a4e",
        "editorIndentGuide.background1": "#2f2f32",
        "editorLineNumber.activeForeground": "#d4d4d8",
        "editorLineNumber.foreground": "#85858b",
        "minimap.background": "#151516",
        "minimapSlider.activeBackground": "#5f5f6680",
        "minimapSlider.background": "#5f5f6640",
        "minimapSlider.hoverBackground": "#5f5f6660",
        "scrollbar.shadow": "#00000000",
        "scrollbarSlider.activeBackground": "#71717a66",
        "scrollbarSlider.background": "#71717a33",
        "scrollbarSlider.hoverBackground": "#71717a55",
      },
    });
  }, []);

  const handleMount = useCallback<OnMount>((editor, monaco) => {
    onEditorMountRef.current?.(editor);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current();
    });
  }, []);

  return (
    <Editor
      path={props.path}
      value={props.value}
      language={monacoLanguageForPath(props.path)}
      theme="t3code-monaco-dark"
      beforeMount={beforeMount}
      onMount={handleMount}
      onChange={(value) => props.onChange(value ?? "")}
      options={{
        automaticLayout: true,
        bracketPairColorization: { enabled: true },
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
        fontLigatures: true,
        fontSize: 13,
        formatOnPaste: true,
        formatOnType: true,
        guides: {
          bracketPairs: true,
          indentation: true,
        },
        minimap: {
          enabled: true,
          renderCharacters: false,
          scale: 1,
          showSlider: "mouseover",
          side: "right",
        },
        padding: {
          bottom: 12,
          top: 12,
        },
        readOnly: Boolean(props.disabled),
        renderLineHighlight: "all",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2,
        wordWrap: "off",
      }}
    />
  );
}

function workspaceEditorHeaderLabel(input: {
  readonly activeView: WorkspaceEditorView;
  readonly dirty: boolean;
  readonly openFile: OpenFileState | null;
  readonly selectedGitPath: string | null;
}): string {
  if (input.activeView === "git") {
    return input.selectedGitPath ? `Diff: ${input.selectedGitPath}` : "No changes selected";
  }
  return input.openFile
    ? `Editor: ${input.openFile.path}${input.dirty ? " * Unsaved" : ""}`
    : "Editor";
}

function normalizeTreePath(pathValue: string): string {
  return pathValue.replace(/\/+$/, "");
}

function pathForTreeEntry(entry: ProjectListDirectoryEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function isFileTreeDirectoryHandle(
  item: ReturnType<ReturnType<typeof useFileTree>["model"]["getItem"]>,
): item is FileTreeDirectoryHandle {
  return item?.isDirectory() === true;
}

function gitStatusForTreeStatus(status: string): GitStatusEntry["status"] {
  if (status === "added") return "added";
  if (status === "deleted") return "deleted";
  if (status === "renamed") return "renamed";
  if (status === "untracked") return "untracked";
  return "modified";
}

function PierreWorkspaceFileTree(props: {
  readonly entriesByDirectory: Record<string, readonly ProjectListDirectoryEntry[]>;
  readonly expandedDirectories: ReadonlySet<string>;
  readonly gitFiles: readonly {
    readonly path: string;
    readonly status?: string;
    readonly tracked: boolean;
  }[];
  readonly loadingRoot: boolean;
  readonly openFilePath: string | null;
  readonly onLoadDirectory: (path: string) => void;
  readonly onOpenFile: (path: string, options?: { readonly focusEditor?: boolean }) => void;
  readonly onSelectDirectory: (path: string) => void;
  readonly registerCollapseAll: (collapseAll: (() => void) | null) => void;
}) {
  const callbacksRef = useRef({
    onLoadDirectory: props.onLoadDirectory,
    onOpenFile: props.onOpenFile,
    onSelectDirectory: props.onSelectDirectory,
  });
  const hasSyncedTreePathsRef = useRef(false);

  useEffect(() => {
    callbacksRef.current = {
      onLoadDirectory: props.onLoadDirectory,
      onOpenFile: props.onOpenFile,
      onSelectDirectory: props.onSelectDirectory,
    };
  }, [props.onLoadDirectory, props.onOpenFile, props.onSelectDirectory]);

  const treePaths = useMemo(() => {
    const paths = new Set<string>();
    for (const entries of Object.values(props.entriesByDirectory)) {
      for (const entry of entries) {
        paths.add(pathForTreeEntry(entry));
      }
    }
    return Array.from(paths);
  }, [props.entriesByDirectory]);

  const initialExpandedPaths = useMemo(
    () => Array.from(props.expandedDirectories).filter((path) => path !== ROOT_PATH),
    [props.expandedDirectories],
  );
  const treePathsSignature = useMemo(() => treePaths.join("\n"), [treePaths]);

  const gitStatus = useMemo<GitStatusEntry[]>(
    () =>
      props.gitFiles.map((file) => ({
        path: file.path,
        status: file.status ? gitStatusForTreeStatus(file.status) : "modified",
      })),
    [props.gitFiles],
  );
  const setiIcons = useMemo<FileTreeIcons>(() => {
    const symbolIds = new Set<string>();
    const symbols: string[] = [];
    const byFileName: Record<string, string> = {};

    for (const entries of Object.values(props.entriesByDirectory)) {
      for (const entry of entries) {
        if (entry.kind !== "file") continue;
        const fileName = basename(entry.path).toLowerCase();
        if (byFileName[fileName]) continue;
        const symbolId = setiTreeIconId(fileName);
        byFileName[fileName] = symbolId;
        if (symbolIds.has(symbolId)) continue;
        symbolIds.add(symbolId);
        symbols.push(getSetiFileIconSymbol(entry.path, symbolId));
      }
    }

    return {
      set: "minimal",
      colored: false,
      spriteSheet: `<svg aria-hidden="true" style="display:none">${symbols.join("")}</svg>`,
      byFileName,
    };
  }, [props.entriesByDirectory]);

  const { model } = useFileTree({
    paths: treePaths,
    initialExpandedPaths,
    initialSelectedPaths: props.openFilePath ? [props.openFilePath] : [],
    flattenEmptyDirectories: true,
    search: true,
    stickyFolders: true,
    density: "compact",
    icons: setiIcons,
    gitStatus,
    onSelectionChange: (selectedPaths) => {
      const selectedPath = selectedPaths.at(-1);
      if (!selectedPath) return;
      const normalizedPath = normalizeTreePath(selectedPath);
      const item = model.getItem(selectedPath) ?? model.getItem(normalizedPath);
      if (item?.isDirectory()) {
        callbacksRef.current.onSelectDirectory(normalizedPath);
        callbacksRef.current.onLoadDirectory(normalizedPath);
        return;
      }
      callbacksRef.current.onOpenFile(normalizedPath);
    },
    unsafeCSS: `
      :host {
        --trees-bg-override: color-mix(in srgb, var(--background) 98%, var(--foreground));
        --trees-bg-muted-override: var(--accent);
        --trees-fg-override: var(--foreground);
        --trees-fg-muted-override: var(--muted-foreground);
        --trees-selected-bg-override: var(--accent);
        --trees-selected-fg-override: var(--accent-foreground);
        --trees-border-color-override: var(--border);
        --trees-search-bg-override: var(--background);
        --trees-font-family-override: var(--font-sans);
        --trees-font-size-override: 12px;
        --truncate-marker-background-color: transparent;
        --truncate-marker-background-overlay-color: transparent;
        --truncate-marker-fade-width: 0px;
        --truncate-marker-gap: 0px;
        --truncate-marker-opacity: 0%;
        --truncate-middle-marker-opacity: 0%;
      }
      [data-truncate-marker],
      [data-truncate-marker]::before,
      [data-truncate-marker]::after {
        background: transparent !important;
        background-image: none !important;
        color: transparent !important;
      }
    `,
  });

  useEffect(() => {
    const expandedPaths = hasSyncedTreePathsRef.current
      ? treePaths.flatMap((path) => {
          const normalizedPath = normalizeTreePath(path);
          const item = model.getItem(path) ?? model.getItem(normalizedPath);
          return isFileTreeDirectoryHandle(item) && item.isExpanded() ? [normalizedPath] : [];
        })
      : initialExpandedPaths;
    model.resetPaths(treePaths, { initialExpandedPaths: expandedPaths });
    hasSyncedTreePathsRef.current = true;
    // Depend on the path signature so local expand/collapse state does not get
    // overwritten by parent expanded-directory bookkeeping.
  }, [model, treePathsSignature]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);

  useEffect(() => {
    model.setIcons(setiIcons);
  }, [model, setiIcons]);

  useEffect(() => {
    const focusSearchInput = () => {
      model.openSearch();
      window.requestAnimationFrame(() => {
        const searchInput = model
          .getFileTreeContainer()
          ?.shadowRoot?.querySelector("[data-file-tree-search-input]");
        if (searchInput instanceof HTMLInputElement) {
          searchInput.focus();
          searchInput.select();
        }
      });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "p") return;
      event.preventDefault();
      event.stopPropagation();
      focusSearchInput();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [model]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.altKey) return;

      const container = model.getFileTreeContainer();
      if (!container || !event.composedPath().includes(container)) return;

      const shadowRoot = container.shadowRoot;
      const getElementPath = (element: Element | null | undefined) => {
        const row = element?.closest("[data-item-path]");
        return row instanceof HTMLElement ? (row.dataset.itemPath ?? null) : null;
      };
      const activeElement =
        shadowRoot?.activeElement instanceof Element ? shadowRoot.activeElement : null;
      const activeDescendantId = activeElement?.getAttribute("aria-activedescendant");
      const activeDescendant =
        activeDescendantId && shadowRoot ? shadowRoot.getElementById(activeDescendantId) : null;
      const getQueriedPath = (selector: string) => {
        const row = shadowRoot?.querySelector(selector);
        return row instanceof HTMLElement ? (row.dataset.itemPath ?? null) : null;
      };
      const focusedDomPath =
        getElementPath(activeDescendant) ??
        getQueriedPath("[data-item-focused='true'][data-item-path]") ??
        getQueriedPath("[data-focused='true'][data-item-path]") ??
        getQueriedPath("[data-focus='true'][data-item-path]") ??
        getQueriedPath("[data-active='true'][data-item-path]") ??
        getQueriedPath("[tabindex='0'][data-item-path]");
      const targetPath = getElementPath(activeElement) ?? focusedDomPath;
      event.preventDefault();
      event.stopPropagation();
      if (!targetPath) {
        toastManager.add({
          type: "error",
          title: "Unable to identify the selected file.",
          description: "File tree selection is out of sync. Try clicking the file directly.",
        });
        return;
      }
      const normalizedPath = normalizeTreePath(targetPath);
      const item = model.getItem(targetPath) ?? model.getItem(normalizedPath);
      if (!item || item.isDirectory()) {
        toastManager.add({
          type: "error",
          title: "Unable to open selected file.",
          description: normalizedPath,
        });
        return;
      }
      callbacksRef.current.onOpenFile(normalizedPath, { focusEditor: true });
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [model]);

  useEffect(() => {
    if (!props.openFilePath) return;
    model.getItem(props.openFilePath)?.select();
    model.focusNearestPath(props.openFilePath);
  }, [model, props.openFilePath]);

  useEffect(() => {
    props.registerCollapseAll(() => {
      for (const path of treePaths) {
        const normalizedPath = normalizeTreePath(path);
        const item = model.getItem(path) ?? model.getItem(normalizedPath);
        if (isFileTreeDirectoryHandle(item) && item.isExpanded()) {
          item.collapse();
        }
      }
    });
    return () => props.registerCollapseAll(null);
  }, [model, props.registerCollapseAll, treePaths]);

  if (props.loadingRoot && treePaths.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-xs">
        <Loader2Icon className="size-3.5 animate-spin" />
        Loading files...
      </div>
    );
  }

  if (treePaths.length === 0) {
    return <div className="px-3 py-2 text-muted-foreground text-xs">No files loaded.</div>;
  }

  return <PierreFileTree model={model} className="h-full w-full" />;
}

export function WorkspaceEditorPanel({
  environmentId,
  cwd,
  fallbackCwd,
  fallbackCwds = [],
  openFileRequest,
  viewRequest,
  toggleShortcutLabel,
  onViewChange,
  onClose,
}: WorkspaceEditorPanelProps) {
  const [directoryEntries, setDirectoryEntries] = useState<
    Record<string, readonly ProjectListDirectoryEntry[]>
  >({});
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(
    () => new Set([ROOT_PATH]),
  );
  const [loadingDirectories, setLoadingDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [resolvedCwd, setResolvedCwd] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<readonly OpenFileState[]>([]);
  const [activeOpenFilePath, setActiveOpenFilePath] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<WorkspaceEditorView>("trees");
  const [selectedGitPath, setSelectedGitPath] = useState<string | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffState | null>(null);
  const [gitDiffCache, setGitDiffCache] = useState<GitDiffCache>({});
  const [gitDiffRenderMode, setGitDiffRenderMode] = useState<GitDiffRenderMode>("stacked");
  const [gitDiffWordWrap, setGitDiffWordWrap] = useState(false);
  const [gitDiffFullContext, setGitDiffFullContext] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const pendingRestoredOpenFilePathRef = useRef<string | null>(null);
  const collapseTreesDirectoriesRef = useRef<(() => void) | null>(null);
  const handledOpenFileRequestIdRef = useRef<number | null>(null);
  const handledViewRequestIdRef = useRef<number | null>(null);
  const restoredDirectoryLoadsRef = useRef<ReadonlySet<string>>(new Set());
  const hydratedWorkspaceStateKeyRef = useRef<string | null>(null);
  const loadVersionRef = useRef(0);
  const loadDirectoryRef = useRef<(relativePath: string) => Promise<void>>(async () => undefined);
  const monacoEditorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const focusEditorAfterOpenRef = useRef(false);
  const pendingEditorFocusPathRef = useRef<string | null>(null);

  const openFile = useMemo(
    () =>
      activeOpenFilePath
        ? (openFiles.find((file) => file.path === activeOpenFilePath) ?? null)
        : null,
    [activeOpenFilePath, openFiles],
  );
  const activeViewRef = useRef(activeView);
  const openFileRef = useRef(openFile);
  activeViewRef.current = activeView;
  openFileRef.current = openFile;

  const focusMonacoEditorWhenReady = useCallback((path?: string) => {
    focusEditorAfterOpenRef.current = true;
    pendingEditorFocusPathRef.current = path ?? pendingEditorFocusPathRef.current;
    let attemptCount = 0;

    const tryFocus = () => {
      if (!focusEditorAfterOpenRef.current) return;
      const pendingPath = pendingEditorFocusPathRef.current;
      const currentOpenFile = openFileRef.current;
      const editor = monacoEditorRef.current;
      const editorDomNode = editor?.getDomNode();

      if (
        activeViewRef.current === "trees" &&
        currentOpenFile &&
        !currentOpenFile.loading &&
        (!pendingPath || currentOpenFile.path === pendingPath) &&
        editor &&
        editorDomNode?.isConnected
      ) {
        focusEditorAfterOpenRef.current = false;
        pendingEditorFocusPathRef.current = null;
        editor.focus();
        return;
      }

      attemptCount += 1;
      if (attemptCount < 80) {
        window.setTimeout(tryFocus, 25);
      }
    };

    window.requestAnimationFrame(tryFocus);
  }, []);
  const dirty = openFile ? openFile.draftContents !== openFile.savedContents : false;
  const updateOpenFile = useCallback(
    (path: string, updater: (file: OpenFileState) => OpenFileState) => {
      setOpenFiles((previous) =>
        previous.map((file) => (file.path === path ? updater(file) : file)),
      );
    },
    [],
  );
  const dirtyOpenFilePaths = useMemo(
    () =>
      new Set(
        openFiles
          .filter((file) => file.draftContents !== file.savedContents)
          .map((file) => file.path),
      ),
    [openFiles],
  );
  const registerCollapseTreesDirectories = useCallback((collapseAll: (() => void) | null) => {
    collapseTreesDirectoriesRef.current = collapseAll;
  }, []);
  const collapseTreesDirectories = useCallback(() => {
    collapseTreesDirectoriesRef.current?.();
  }, []);
  const candidateCwds = useMemo(() => {
    const candidates: string[] = [];
    for (const value of [cwd, fallbackCwd, ...fallbackCwds]) {
      if (value && !candidates.includes(value)) {
        candidates.push(value);
      }
    }
    return candidates;
  }, [cwd, fallbackCwd, fallbackCwds]);
  const effectiveCwd = resolvedCwd ?? candidateCwds[0] ?? null;
  const gitStatus = useGitStatus({ environmentId, cwd: effectiveCwd });
  const gitFiles = useMemo(() => gitStatus.data?.workingTree.files ?? [], [gitStatus.data]);
  const trackedGitFiles = useMemo(() => gitFiles.filter((file) => file.tracked), [gitFiles]);
  const untrackedGitFiles = useMemo(() => gitFiles.filter((file) => !file.tracked), [gitFiles]);
  const selectedGitFile = useMemo(
    () => gitFiles.find((file) => file.path === selectedGitPath) ?? null,
    [gitFiles, selectedGitPath],
  );
  const gitFilesSignature = useMemo(
    () => gitFiles.map((file) => `${file.path}:${file.insertions}:${file.deletions}`).join("|"),
    [gitFiles],
  );
  const preloadedGitDiffs = useMemo(
    () =>
      gitFiles.flatMap((file) => {
        if (file.path === selectedGitPath) return [];
        const cacheKey = gitDiffCacheKey(file.path, gitDiffFullContext);
        const patch = gitDiffCache[cacheKey];
        return patch === undefined ? [] : [{ path: file.path, patch }];
      }),
    [gitDiffCache, gitDiffFullContext, gitFiles, selectedGitPath],
  );
  const headerLabel = workspaceEditorHeaderLabel({
    activeView,
    dirty,
    openFile,
    selectedGitPath,
  });
  const workspaceStateStorageKey = useMemo(
    () =>
      candidateCwds[0] ? workspaceEditorStateStorageKey(environmentId, candidateCwds[0]) : null,
    [candidateCwds, environmentId],
  );

  const loadDirectory = useCallback(
    async (relativePath: string) => {
      if (!effectiveCwd) return;
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        setDirectoryError("Environment API is unavailable.");
        return;
      }

      setLoadingDirectories((previous) => new Set(previous).add(relativePath));
      setDirectoryError(null);
      try {
        const rootsToTry = relativePath === ROOT_PATH ? candidateCwds : [effectiveCwd];
        let result: Awaited<ReturnType<typeof api.projects.listDirectory>> | null = null;
        let successfulCwd: string | null = null;
        let lastError: unknown = null;
        for (const candidateCwd of rootsToTry) {
          try {
            result = await api.projects.listDirectory({ cwd: candidateCwd, relativePath });
            successfulCwd = candidateCwd;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!result || !successfulCwd) {
          throw lastError ?? new Error("Unable to list workspace directory.");
        }
        setResolvedCwd(successfulCwd);
        setDirectoryEntries((previous) => ({
          ...previous,
          [result.relativePath]: result.entries,
        }));
        if (result.truncated) {
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Directory listing truncated",
              description: result.relativePath,
            }),
          );
        }
      } catch (error) {
        setDirectoryError(errorMessage(error));
      } finally {
        setLoadingDirectories((previous) => {
          const next = new Set(previous);
          next.delete(relativePath);
          return next;
        });
      }
    },
    [candidateCwds, effectiveCwd, environmentId],
  );

  useEffect(() => {
    loadDirectoryRef.current = loadDirectory;
  }, [loadDirectory]);

  useEffect(() => {
    loadVersionRef.current += 1;
    const restoredState = workspaceStateStorageKey
      ? readWorkspaceEditorState(workspaceStateStorageKey)
      : DEFAULT_WORKSPACE_EDITOR_STATE;
    pendingRestoredOpenFilePathRef.current = restoredState.openFilePath;
    restoredDirectoryLoadsRef.current = new Set([ROOT_PATH]);
    hydratedWorkspaceStateKeyRef.current = null;
    setDirectoryEntries({});
    setExpandedDirectories(new Set(restoredState.expandedDirectories));
    setPanelWidth(restoredState.panelWidth ?? DEFAULT_PANEL_WIDTH);
    setLoadingDirectories(new Set());
    setDirectoryError(null);
    setResolvedCwd(null);
    setOpenFiles([]);
    setActiveOpenFilePath(null);
    queueMicrotask(() => {
      hydratedWorkspaceStateKeyRef.current = workspaceStateStorageKey;
    });
    if (cwd || fallbackCwd) {
      void loadDirectoryRef.current(ROOT_PATH);
    }
  }, [cwd, fallbackCwd, fallbackCwds, workspaceStateStorageKey]);

  const openFilePath = useCallback(
    async (relativePath: string, _options?: { skipDirtyPrompt?: boolean }) => {
      void _options;
      if (!effectiveCwd) return;
      const existingOpenFile = openFiles.find((file) => file.path === relativePath);
      if (existingOpenFile) {
        setActiveOpenFilePath(relativePath);
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        toastManager.add({ type: "error", title: "Environment API is unavailable." });
        return;
      }

      const requestVersion = loadVersionRef.current;
      const loadingFile: OpenFileState = {
        path: relativePath,
        savedContents: "",
        draftContents: "",
        loading: true,
        saving: false,
        error: null,
      };
      setOpenFiles((previous) => [...previous, loadingFile]);
      setActiveOpenFilePath(relativePath);
      try {
        const result = await api.projects.readFile({ cwd: effectiveCwd, relativePath });
        if (requestVersion !== loadVersionRef.current) return;
        const loadedFile: OpenFileState = {
          path: result.relativePath,
          savedContents: result.contents,
          draftContents: result.contents,
          loading: false,
          saving: false,
          error: null,
        };
        setOpenFiles((previous) =>
          previous.map((file) => (file.path === relativePath ? loadedFile : file)),
        );
        setActiveOpenFilePath((current) =>
          current === relativePath ? result.relativePath : current,
        );
      } catch (error) {
        if (requestVersion !== loadVersionRef.current) return;
        updateOpenFile(relativePath, (file) => ({
          ...file,
          loading: false,
          error: errorMessage(error),
        }));
      }
    },
    [effectiveCwd, environmentId, openFiles, updateOpenFile],
  );

  const openProjectFileFromDiff = useCallback(
    (relativePath: string) => {
      const normalizedPath = relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
      const parentDirectories = ancestorDirectoryPaths(normalizedPath);
      setActiveView("trees");
      if (parentDirectories.length > 0) {
        setExpandedDirectories((previous) => new Set([...previous, ...parentDirectories]));
      }
      for (const directoryPath of parentDirectories) {
        if (directoryEntries[directoryPath] || loadingDirectories.has(directoryPath)) continue;
        void loadDirectory(directoryPath);
      }
      void openFilePath(normalizedPath);
    },
    [directoryEntries, loadDirectory, loadingDirectories, openFilePath],
  );

  useEffect(() => {
    if (!workspaceStateStorageKey) return;
    if (hydratedWorkspaceStateKeyRef.current !== workspaceStateStorageKey) return;
    writeWorkspaceEditorState(workspaceStateStorageKey, {
      openFilePath: openFile?.path ?? null,
      expandedDirectories: Array.from(expandedDirectories),
      panelWidth,
    });
  }, [expandedDirectories, openFile?.path, panelWidth, workspaceStateStorageKey]);

  useEffect(() => {
    if (activeView !== "git") return;
    if (selectedGitPath && gitFiles.some((file) => file.path === selectedGitPath)) return;
    setSelectedGitPath(gitFiles[0]?.path ?? null);
  }, [activeView, gitFiles, selectedGitPath]);

  useEffect(() => {
    setGitDiffCache({});
  }, [effectiveCwd, gitFilesSignature]);

  useEffect(() => {
    if (!effectiveCwd) return;
    if (!directoryEntries[ROOT_PATH]) return;

    for (const relativePath of expandedDirectories) {
      if (relativePath === ROOT_PATH) continue;
      if (directoryEntries[relativePath]) continue;
      if (loadingDirectories.has(relativePath)) continue;
      if (restoredDirectoryLoadsRef.current.has(relativePath)) continue;
      restoredDirectoryLoadsRef.current = new Set(restoredDirectoryLoadsRef.current).add(
        relativePath,
      );
      void loadDirectory(relativePath);
    }

    const restoredOpenFilePath = pendingRestoredOpenFilePathRef.current;
    if (!restoredOpenFilePath || openFile) return;
    pendingRestoredOpenFilePathRef.current = null;
    void openFilePath(restoredOpenFilePath, { skipDirtyPrompt: true });
  }, [
    directoryEntries,
    effectiveCwd,
    expandedDirectories,
    loadDirectory,
    loadingDirectories,
    openFile,
    openFilePath,
  ]);

  useEffect(() => {
    if (!openFileRequest) return;
    if (handledOpenFileRequestIdRef.current === openFileRequest.requestId) return;
    if (!effectiveCwd) return;
    if (!directoryEntries[ROOT_PATH]) return;

    handledOpenFileRequestIdRef.current = openFileRequest.requestId;
    const relativePath = openFileRequest.relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
    const parentDirectories = ancestorDirectoryPaths(relativePath);
    if (parentDirectories.length > 0) {
      setExpandedDirectories((previous) => new Set([...previous, ...parentDirectories]));
    }
    for (const directoryPath of parentDirectories) {
      if (directoryEntries[directoryPath] || loadingDirectories.has(directoryPath)) continue;
      void loadDirectory(directoryPath);
    }
    void openFilePath(relativePath);
  }, [
    directoryEntries,
    effectiveCwd,
    loadDirectory,
    loadingDirectories,
    openFilePath,
    openFileRequest,
  ]);

  useEffect(() => {
    if (!focusEditorAfterOpenRef.current) return;
    if (activeView !== "trees" || !openFile || openFile.loading) return;
    focusMonacoEditorWhenReady(openFile.path);
  }, [activeView, focusMonacoEditorWhenReady, openFile]);

  useEffect(() => {
    if (!viewRequest) return;
    if (handledViewRequestIdRef.current === viewRequest.requestId) return;
    handledViewRequestIdRef.current = viewRequest.requestId;
    setActiveView(viewRequest.view);
  }, [viewRequest]);

  useEffect(() => {
    onViewChange?.(activeView);
  }, [activeView, onViewChange]);

  const saveOpenFile = useCallback(async () => {
    if (!effectiveCwd || !openFile || !dirty) return;
    if (openFile.loading || openFile.saving) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      toastManager.add({ type: "error", title: "Environment API is unavailable." });
      return;
    }

    updateOpenFile(openFile.path, (file) => ({ ...file, saving: true, error: null }));
    try {
      const result = await api.projects.writeFile({
        cwd: effectiveCwd,
        relativePath: openFile.path,
        contents: openFile.draftContents,
      });
      updateOpenFile(openFile.path, (file) => ({
        ...file,
        path: result.relativePath,
        savedContents: file.draftContents,
        saving: false,
      }));
      setActiveOpenFilePath((current) =>
        current === openFile.path ? result.relativePath : current,
      );
      void loadDirectory(dirname(openFile.path));
    } catch (error) {
      updateOpenFile(openFile.path, (file) => ({
        ...file,
        saving: false,
        error: errorMessage(error),
      }));
    }
  }, [dirty, effectiveCwd, environmentId, loadDirectory, openFile, updateOpenFile]);

  const closeOpenFile = useCallback(
    (path: string) => {
      const file = openFiles.find((candidate) => candidate.path === path);
      if (!file) return;
      const fileDirty = file.draftContents !== file.savedContents;
      if (fileDirty && !window.confirm(`Discard unsaved changes in ${path}?`)) {
        return;
      }

      const closingIndex = openFiles.findIndex((candidate) => candidate.path === path);
      const nextActivePath =
        activeOpenFilePath === path
          ? (openFiles.filter((candidate) => candidate.path !== path)[
              Math.min(closingIndex, openFiles.length - 2)
            ]?.path ?? null)
          : activeOpenFilePath;
      setOpenFiles((previous) => {
        if (!previous.some((candidate) => candidate.path === path)) return previous;
        return previous.filter((candidate) => candidate.path !== path);
      });
      setActiveOpenFilePath(nextActivePath);
    },
    [activeOpenFilePath, openFiles],
  );

  const refreshSidebar = useCallback(() => {
    if (activeView === "git") {
      void refreshGitStatus({ environmentId, cwd: effectiveCwd });
      return;
    }
    void loadDirectory(ROOT_PATH);
  }, [activeView, effectiveCwd, environmentId, loadDirectory]);

  const loadGitDiffPatch = useCallback(
    async (relativePath: string, fullContext: boolean) => {
      if (!effectiveCwd) return EMPTY_PATCH;
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        throw new Error("Environment API is unavailable.");
      }

      const result = await api.git.getWorktreeFileDiff({
        cwd: effectiveCwd,
        relativePath,
        fullContext,
      });
      if (result.patch.trim().length > 0) {
        return result.patch;
      }

      const file = await api.projects.readFile({ cwd: effectiveCwd, relativePath });
      return createUntrackedFilePatch(relativePath, file.contents);
    },
    [effectiveCwd, environmentId],
  );

  useEffect(() => {
    if (activeView !== "git" || !selectedGitPath) {
      setGitDiff(null);
      return;
    }

    const cacheKey = gitDiffCacheKey(selectedGitPath, gitDiffFullContext);
    const cachedPatch = gitDiffCache[cacheKey];
    if (cachedPatch !== undefined) {
      setGitDiff({ path: selectedGitPath, patch: cachedPatch, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setGitDiff({ path: selectedGitPath, patch: EMPTY_PATCH, loading: true, error: null });
    void loadGitDiffPatch(selectedGitPath, gitDiffFullContext)
      .then((patch) => {
        if (cancelled) return;
        setGitDiffCache((previous) => ({ ...previous, [cacheKey]: patch }));
        setGitDiff({ path: selectedGitPath, patch, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setGitDiff({
          path: selectedGitPath,
          patch: EMPTY_PATCH,
          loading: false,
          error: errorMessage(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [activeView, gitDiffCache, gitDiffFullContext, loadGitDiffPatch, selectedGitPath]);

  useEffect(() => {
    if (activeView !== "git" || gitFiles.length === 0) return;

    let cancelled = false;
    const missingFiles = gitFiles.filter(
      (file) => gitDiffCache[gitDiffCacheKey(file.path, gitDiffFullContext)] === undefined,
    );
    if (missingFiles.length === 0) return;

    const prefetch = async (): Promise<void> => {
      let nextIndex = 0;

      const prefetchWorker = async (): Promise<void> => {
        while (true) {
          if (cancelled) return;
          const file = missingFiles[nextIndex];
          nextIndex += 1;
          if (!file) return;

          try {
            const cacheKey = gitDiffCacheKey(file.path, gitDiffFullContext);
            const patch = await loadGitDiffPatch(file.path, gitDiffFullContext);
            if (cancelled) return;
            setGitDiffCache((previous) =>
              previous[cacheKey] === undefined ? { ...previous, [cacheKey]: patch } : previous,
            );
          } catch {
            // Ignore prefetch failures; selecting the file will surface the error.
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(4, missingFiles.length) }, () => prefetchWorker()),
      );
    };

    void prefetch();
    return () => {
      cancelled = true;
    };
  }, [activeView, gitDiffCache, gitDiffFullContext, gitFiles, loadGitDiffPatch]);

  const startPanelResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panelWidth;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        setPanelWidth(clampWorkspaceEditorPanelWidth(startWidth + startX - moveEvent.clientX));
      };
      const handlePointerUp = () => {
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [panelWidth],
  );

  if (candidateCwds.length === 0) {
    return null;
  }

  return (
    <aside
      className="relative hidden min-h-0 shrink-0 border-l border-border bg-background xl:flex"
      style={{ width: panelWidth }}
    >
      <div
        aria-label="Resize workspace editor"
        className="-left-1 absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none hover:bg-primary/20"
        role="separator"
        onPointerDown={startPanelResize}
      />
      <section className="flex min-w-0 flex-1 flex-col">
        {activeView !== "trees" ? (
          <div className="flex h-9 min-w-0 items-center gap-2 border-b border-border px-2">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Hide workspace editor"
              title={`Hide workspace editor (${toggleShortcutLabel})`}
              onClick={onClose}
            >
              <PanelRightCloseIcon className="size-3.5" />
            </Button>
            <div className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
              {headerLabel}
            </div>
            {activeView === "git" && selectedGitFile ? (
              <GitChangeCounts
                insertions={selectedGitFile.insertions}
                deletions={selectedGitFile.deletions}
              />
            ) : null}
            <div className="flex shrink-0 items-center gap-1">
              <ToggleGroup
                className="shrink-0"
                variant="outline"
                size="xs"
                value={[gitDiffRenderMode]}
                onValueChange={(value) => {
                  const next = value[0];
                  if (next === "stacked" || next === "split") {
                    setGitDiffRenderMode(next);
                  }
                }}
              >
                <Toggle aria-label="Stacked diff view" title="Stacked diff view" value="stacked">
                  <Rows3Icon className="size-3" />
                </Toggle>
                <Toggle aria-label="Split diff view" title="Split diff view" value="split">
                  <Columns2Icon className="size-3" />
                </Toggle>
              </ToggleGroup>
              <Toggle
                aria-label={
                  gitDiffFullContext ? "Show changed hunks only" : "Show full file context"
                }
                title={gitDiffFullContext ? "Show changed hunks only" : "Show full file context"}
                variant="outline"
                size="xs"
                pressed={gitDiffFullContext}
                onPressedChange={(pressed) => setGitDiffFullContext(Boolean(pressed))}
              >
                <FileTextIcon className="size-3" />
              </Toggle>
              <Toggle
                aria-label={
                  gitDiffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"
                }
                title={gitDiffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
                variant="outline"
                size="xs"
                pressed={gitDiffWordWrap}
                onPressedChange={(pressed) => setGitDiffWordWrap(Boolean(pressed))}
              >
                <TextWrapIcon className="size-3" />
              </Toggle>
            </div>
          </div>
        ) : null}
        {activeView === "git" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {gitDiff?.error ? (
              <div className="border-b border-border bg-destructive/8 px-3 py-2 text-destructive text-xs">
                {gitDiff.error}
              </div>
            ) : null}
            {gitDiff?.loading ? (
              <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                Loading diff...
              </div>
            ) : selectedGitPath ? (
              <DiffWorkerPoolProvider>
                <PatchDiffViewer
                  patch={gitDiff?.patch ?? EMPTY_PATCH}
                  cacheScope={`worktree:${effectiveCwd ?? ""}:${selectedGitPath}:${gitDiffFullContext ? "full" : "hunks"}`}
                  emptyLabel="No diff available for this file."
                  onOpenFile={openProjectFileFromDiff}
                  renderMode={gitDiffRenderMode}
                  showChangeOverview={gitDiffFullContext}
                  wordWrap={gitDiffWordWrap}
                />
                {preloadedGitDiffs.length > 0 ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none fixed top-0 -left-[10000px] h-[720px] w-[960px] overflow-hidden opacity-0"
                  >
                    {preloadedGitDiffs.map((entry) => (
                      <PatchDiffViewer
                        key={`${entry.path}:${gitDiffFullContext ? "full" : "hunks"}`}
                        patch={entry.patch}
                        cacheScope={`worktree:${effectiveCwd ?? ""}:${entry.path}:${gitDiffFullContext ? "full" : "hunks"}`}
                        emptyLabel=""
                        renderMode={gitDiffRenderMode}
                        wordWrap={gitDiffWordWrap}
                      />
                    ))}
                  </div>
                ) : null}
              </DiffWorkerPoolProvider>
            ) : (
              <div className="flex flex-1 items-center justify-center px-4 text-center text-muted-foreground text-sm">
                No worktree changes.
              </div>
            )}
          </div>
        ) : openFile ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {activeView === "trees" && openFiles.length > 0 ? (
              <div className="flex h-9 shrink-0 items-center overflow-x-auto border-b border-border bg-background/95">
                {openFiles.map((file) => {
                  const fileDirty = dirtyOpenFilePaths.has(file.path);
                  const selected = file.path === openFile.path;
                  return (
                    <div
                      key={file.path}
                      title={file.path}
                      className={cn(
                        "group flex h-full max-w-52 min-w-0 items-center border-r border-border text-xs",
                        selected
                          ? "bg-muted text-foreground"
                          : "bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                      )}
                      onMouseDown={(event) => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        closeOpenFile(file.path);
                      }}
                    >
                      <button
                        type="button"
                        className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
                        onClick={() => setActiveOpenFilePath(file.path)}
                      >
                        <FileTextIcon className="size-3.5 shrink-0 opacity-70" />
                        <span className="min-w-0 truncate">{basename(file.path)}</span>
                        {fileDirty ? (
                          <span className="shrink-0 text-muted-foreground">*</span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        aria-label={`Close ${file.path}`}
                        title={`Close ${file.path}`}
                        className={cn(
                          "mr-1 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-accent hover:text-accent-foreground group-hover:opacity-100",
                          selected && "opacity-100",
                        )}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeOpenFile(file.path);
                        }}
                      >
                        <XIcon className="size-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {openFile.error ? (
              <div className="border-b border-border bg-destructive/8 px-3 py-2 text-destructive text-xs">
                {openFile.error}
              </div>
            ) : null}
            {openFile.loading ? (
              <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                Loading file...
              </div>
            ) : (
              <MonacoWorkspaceEditor
                path={openFile.path}
                value={openFile.draftContents}
                disabled={openFile.saving}
                onEditorMount={(editor) => {
                  monacoEditorRef.current = editor;
                  if (focusEditorAfterOpenRef.current) {
                    focusMonacoEditorWhenReady(openFile.path);
                  }
                }}
                onSave={saveOpenFile}
                onChange={(value) =>
                  updateOpenFile(openFile.path, (file) => ({
                    ...file,
                    draftContents: value,
                  }))
                }
              />
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-muted-foreground text-sm">
            Select a file from the explorer.
          </div>
        )}
      </section>

      <section className="flex min-h-0 w-64 shrink-0 flex-col border-l border-border bg-muted/20">
        <div className="flex h-9 items-center gap-2 border-b border-border px-2">
          <div className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {activeView === "git" ? `${gitFiles.length} Changes` : "Files"}
          </div>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={activeView === "git" ? "Refresh git status" : "Refresh files"}
            title={activeView === "git" ? "Refresh git status" : "Refresh files"}
            onClick={refreshSidebar}
          >
            <RefreshCwIcon className={cn("size-3.5", gitStatus.isPending && "animate-spin")} />
          </Button>
          {activeView === "trees" ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Collapse all directories"
              title="Collapse all directories"
              onClick={collapseTreesDirectories}
            >
              <Minimize2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
        {activeView === "trees" && directoryError ? (
          <div className="border-b border-border px-2 py-1.5 text-muted-foreground text-xs">
            {directoryError}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {activeView === "git" ? (
            gitStatus.isPending && gitFiles.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-xs">
                <Loader2Icon className="size-3.5 animate-spin" />
                Loading changes...
              </div>
            ) : !gitStatus.data?.isRepo ? (
              <div className="px-3 py-2 text-muted-foreground text-xs">
                Current workspace is not a git repository.
              </div>
            ) : gitFiles.length === 0 ? (
              <div className="px-3 py-2 text-muted-foreground text-xs">No worktree changes.</div>
            ) : (
              <div className="space-y-3">
                {trackedGitFiles.length > 0 ? (
                  <div>
                    <div className="px-2 pb-1 text-[11px] text-muted-foreground">Tracked</div>
                    {trackedGitFiles.map((file) => (
                      <GitChangeRow
                        key={file.path}
                        path={file.path}
                        insertions={file.insertions}
                        deletions={file.deletions}
                        selected={selectedGitPath === file.path}
                        onSelect={setSelectedGitPath}
                      />
                    ))}
                  </div>
                ) : null}
                {untrackedGitFiles.length > 0 ? (
                  <div>
                    <div className="px-2 pb-1 text-[11px] text-muted-foreground">Untracked</div>
                    {untrackedGitFiles.map((file) => (
                      <GitChangeRow
                        key={file.path}
                        path={file.path}
                        insertions={file.insertions}
                        deletions={file.deletions}
                        selected={selectedGitPath === file.path}
                        onSelect={setSelectedGitPath}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            )
          ) : (
            <PierreWorkspaceFileTree
              entriesByDirectory={directoryEntries}
              expandedDirectories={expandedDirectories}
              gitFiles={gitFiles}
              loadingRoot={loadingDirectories.has(ROOT_PATH)}
              openFilePath={openFile?.path ?? null}
              onLoadDirectory={(path) => {
                if (directoryEntries[path] || loadingDirectories.has(path)) return;
                void loadDirectory(path);
              }}
              onOpenFile={(path, options) => {
                if (options?.focusEditor) {
                  focusMonacoEditorWhenReady(path);
                }
                void openFilePath(path);
                if (options?.focusEditor && path === openFile?.path && !openFile.loading) {
                  focusMonacoEditorWhenReady(path);
                }
              }}
              onSelectDirectory={(path) =>
                setExpandedDirectories((previous) => new Set(previous).add(path))
              }
              registerCollapseAll={registerCollapseTreesDirectories}
            />
          )}
        </div>
        <div className="flex h-9 shrink-0 items-center justify-end gap-1 border-t border-border px-1">
          <Button
            size="icon-xs"
            variant={activeView === "git" ? "secondary" : "ghost"}
            aria-label="Git panel"
            title="Git panel"
            onClick={() => setActiveView("git")}
          >
            <GitBranchIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant={activeView === "trees" ? "secondary" : "ghost"}
            aria-label="Files panel"
            title="Files panel"
            onClick={() => setActiveView("trees")}
          >
            <ListTreeIcon className="size-3.5" />
          </Button>
        </div>
      </section>
    </aside>
  );
}
