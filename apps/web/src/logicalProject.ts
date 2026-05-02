import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import type { ScopedProjectRef, SidebarProjectGroupingMode } from "@t3tools/contracts";
import {
  getBrowseDirectoryPath,
  inferProjectTitleFromPath,
  normalizeProjectPathForComparison,
} from "./lib/projectPaths";
import type { Project } from "./types";

export interface ProjectGroupingSettings {
  sidebarProjectGroupingMode: SidebarProjectGroupingMode;
  sidebarProjectManualGroups: Record<string, string>;
  sidebarProjectGroupingOverrides: Record<string, SidebarProjectGroupingMode>;
}

export type ProjectGroupingMode = SidebarProjectGroupingMode;
const MANUAL_PROJECT_GROUP_KEY_PREFIX = "manual-group:";

function uniqueNonEmptyValues(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function deriveRepositoryRelativeProjectPath(
  project: Pick<Project, "cwd" | "repositoryIdentity">,
): string | null {
  const rootPath = project.repositoryIdentity?.rootPath?.trim();
  if (!rootPath) {
    return null;
  }

  const normalizedProjectPath = normalizeProjectPathForComparison(project.cwd);
  const normalizedRootPath = normalizeProjectPathForComparison(rootPath);
  if (normalizedProjectPath.length === 0 || normalizedRootPath.length === 0) {
    return null;
  }

  if (normalizedProjectPath === normalizedRootPath) {
    return "";
  }

  const separator = normalizedRootPath.includes("\\") ? "\\" : "/";
  const rootPrefix = `${normalizedRootPath}${separator}`;
  if (!normalizedProjectPath.startsWith(rootPrefix)) {
    return null;
  }

  return normalizedProjectPath.slice(rootPrefix.length).replaceAll("\\", "/");
}

function deriveFilesystemParentPath(project: Pick<Project, "cwd">): string | null {
  const normalizedProjectPath = normalizeProjectPathForComparison(project.cwd);
  if (normalizedProjectPath.length === 0) {
    return null;
  }

  const directoryPath = getBrowseDirectoryPath(normalizedProjectPath);
  const parentPath = normalizeProjectPathForComparison(directoryPath);
  if (parentPath.length === 0 || parentPath === normalizedProjectPath) {
    return null;
  }

  return parentPath;
}

function deriveParentDirectoryGroupingKey(
  project: Pick<Project, "cwd" | "environmentId">,
): string | null {
  const parentDirectoryPath = deriveFilesystemParentPath(project);
  if (parentDirectoryPath === null) {
    return null;
  }

  return `${project.environmentId}::parent:${parentDirectoryPath}`;
}

export function derivePhysicalProjectKeyFromPath(environmentId: string, cwd: string): string {
  return `${environmentId}:${normalizeProjectPathForComparison(cwd)}`;
}

export function derivePhysicalProjectKey(project: Pick<Project, "environmentId" | "cwd">): string {
  return derivePhysicalProjectKeyFromPath(project.environmentId, project.cwd);
}

export function deriveProjectGroupingOverrideKey(
  project: Pick<Project, "environmentId" | "cwd">,
): string {
  return derivePhysicalProjectKey(project);
}

// Key under which a project's manual sort order (projectOrder) is stored.
// Must stay aligned with the writer side in `uiStateStore.syncProjects` and
// the drag handlers in `Sidebar` so readers and writers agree.
export function getProjectOrderKey(project: Pick<Project, "environmentId" | "cwd">): string {
  return derivePhysicalProjectKey(project);
}

function normalizeManualProjectGroupLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\s+/g, " ");
}

export function resolveManualProjectGroupLabel(
  project: Pick<Project, "environmentId" | "cwd">,
  settings: Pick<ProjectGroupingSettings, "sidebarProjectManualGroups">,
): string | null {
  return normalizeManualProjectGroupLabel(
    settings.sidebarProjectManualGroups?.[deriveProjectGroupingOverrideKey(project)],
  );
}

export function deriveManualProjectGroupKey(label: string): string {
  return `${MANUAL_PROJECT_GROUP_KEY_PREFIX}${label.toLocaleLowerCase()}`;
}

export function isManualProjectGroupKey(key: string): boolean {
  return key.startsWith(MANUAL_PROJECT_GROUP_KEY_PREFIX);
}

export function resolveProjectGroupingMode(
  project: Pick<Project, "environmentId" | "cwd">,
  settings: ProjectGroupingSettings,
): SidebarProjectGroupingMode {
  return (
    settings.sidebarProjectGroupingOverrides?.[deriveProjectGroupingOverrideKey(project)] ??
    settings.sidebarProjectGroupingMode
  );
}

function deriveRepositoryScopedKey(
  project: Pick<Project, "cwd" | "environmentId" | "repositoryIdentity">,
  groupingMode: SidebarProjectGroupingMode,
): string | null {
  const canonicalKey = project.repositoryIdentity?.canonicalKey;
  if (!canonicalKey) {
    return null;
  }

  if (groupingMode === "repository") {
    return canonicalKey;
  }

  if (groupingMode === "parent_directory") {
    return deriveParentDirectoryGroupingKey(project) ?? canonicalKey;
  }

  const relativeProjectPath = deriveRepositoryRelativeProjectPath(project);
  if (relativeProjectPath === null) {
    return canonicalKey;
  }

  return relativeProjectPath.length === 0
    ? canonicalKey
    : `${canonicalKey}::${relativeProjectPath}`;
}

export function deriveLogicalProjectKey(
  project: Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity">,
  options?: {
    groupingMode?: SidebarProjectGroupingMode;
  },
): string {
  const groupingMode = options?.groupingMode ?? "repository";
  if (groupingMode === "manual" || groupingMode === "separate") {
    return derivePhysicalProjectKey(project);
  }

  return (
    deriveRepositoryScopedKey(project, groupingMode) ??
    derivePhysicalProjectKey(project) ??
    scopedProjectKey(scopeProjectRef(project.environmentId, project.id))
  );
}

export function deriveLogicalProjectKeyFromSettings(
  project: Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity">,
  settings: ProjectGroupingSettings,
): string {
  const groupingMode = resolveProjectGroupingMode(project, settings);
  if (groupingMode === "manual") {
    const manualGroupLabel = resolveManualProjectGroupLabel(project, settings);
    if (manualGroupLabel) {
      return deriveManualProjectGroupKey(manualGroupLabel);
    }
  }

  return deriveLogicalProjectKey(project, {
    groupingMode,
  });
}

export function deriveLogicalProjectKeyFromRef(
  projectRef: ScopedProjectRef,
  project: Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity"> | null | undefined,
  options?: {
    groupingMode?: SidebarProjectGroupingMode;
  },
): string {
  return project ? deriveLogicalProjectKey(project, options) : scopedProjectKey(projectRef);
}

export function deriveProjectGroupLabel(input: {
  representative: Pick<Project, "name" | "cwd" | "repositoryIdentity">;
  members: ReadonlyArray<Pick<Project, "name" | "cwd" | "repositoryIdentity">>;
  groupingMode?: SidebarProjectGroupingMode;
}): string {
  if (input.groupingMode === "parent_directory") {
    const parentDirectoryPaths = uniqueNonEmptyValues(
      input.members.map((member) => deriveFilesystemParentPath(member)),
    );
    if (parentDirectoryPaths.length === 1) {
      return inferProjectTitleFromPath(parentDirectoryPaths[0]!);
    }
  }

  const sharedDisplayNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.displayName),
  );
  if (sharedDisplayNames.length === 1) {
    return sharedDisplayNames[0]!;
  }

  const sharedRepositoryNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.name),
  );
  if (sharedRepositoryNames.length === 1) {
    return sharedRepositoryNames[0]!;
  }

  return input.representative.name;
}
