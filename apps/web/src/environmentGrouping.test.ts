import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { describe, expect, it } from "vitest";

import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarThreadsForProjectRef,
  selectSidebarThreadsForProjectRefs,
  type AppState,
  type EnvironmentState,
} from "./store";
import {
  deriveLogicalProjectKey,
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  resolveProjectGroupingMode,
} from "./logicalProject";
import { buildSidebarProjectSnapshots } from "./sidebarProjectGrouping";
import type { Project, SidebarThreadSummary } from "./types";
import { DEFAULT_INTERACTION_MODE } from "./types";

// ── Fixture Identifiers ──────────────────────────────────────────────

const primaryEnvId = EnvironmentId.make("env-primary");
const remoteEnvId = EnvironmentId.make("env-remote");

const sharedProjectPrimaryId = ProjectId.make("shared-proj-primary");
const sharedProjectRemoteId = ProjectId.make("shared-proj-remote");
const localOnlyProjectId = ProjectId.make("local-only-proj");
const remoteOnlyProjectId = ProjectId.make("remote-only-proj");

const threadP1 = ThreadId.make("thread-shared-primary-1");
const threadP2 = ThreadId.make("thread-shared-primary-2");
const threadR1 = ThreadId.make("thread-shared-remote-1");
const threadL1 = ThreadId.make("thread-local-only-1");
const threadRO1 = ThreadId.make("thread-remote-only-1");

const SHARED_REPO_CANONICAL_KEY = "github.com/example/shared-repo";
const DEFAULT_GROUPING_SETTINGS = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectManualGroups: {},
  sidebarProjectGroupingOverrides: {},
};
const SHARED_REPO_REMOTE_URL = "https://github.com/example/shared-repo.git";

// ── Factory Helpers ──────────────────────────────────────────────────

function makeProject(
  overrides: Partial<Project> & Pick<Project, "id" | "environmentId" | "name">,
): Project {
  return {
    cwd: `/tmp/${overrides.name}`,
    defaultModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function makeSidebarThreadSummary(
  overrides: Partial<SidebarThreadSummary> &
    Pick<SidebarThreadSummary, "id" | "environmentId" | "projectId" | "title">,
): SidebarThreadSummary {
  return {
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeSharedRepoProject(
  overrides: Partial<Project> &
    Pick<Project, "id" | "environmentId" | "name"> & {
      rootPath?: string;
    },
): Project {
  const { rootPath, ...projectOverrides } = overrides;

  return makeProject({
    ...projectOverrides,
    repositoryIdentity: {
      canonicalKey: SHARED_REPO_CANONICAL_KEY,
      ...(rootPath ? { rootPath } : {}),
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: SHARED_REPO_REMOTE_URL,
      },
    },
  });
}

function makeEmptyEnvironmentState(): EnvironmentState {
  return {
    projectIds: [],
    projectById: {},
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
}

// ── Fixture: Two environments, shared + local-only + remote-only projects ──

function makeFixtureState(): AppState {
  // Shared project: same repo in both envs
  const sharedProjectPrimary = makeSharedRepoProject({
    id: sharedProjectPrimaryId,
    environmentId: primaryEnvId,
    name: "shared-repo",
  });
  const sharedProjectRemote = makeSharedRepoProject({
    id: sharedProjectRemoteId,
    environmentId: remoteEnvId,
    name: "shared-repo",
  });
  // Local-only project
  const localOnlyProject = makeProject({
    id: localOnlyProjectId,
    environmentId: primaryEnvId,
    name: "local-only",
  });
  // Remote-only project
  const remoteOnlyProject = makeProject({
    id: remoteOnlyProjectId,
    environmentId: remoteEnvId,
    name: "remote-only",
  });

  // Threads
  const summaryP1 = makeSidebarThreadSummary({
    id: threadP1,
    environmentId: primaryEnvId,
    projectId: sharedProjectPrimaryId,
    title: "Shared primary thread 1",
  });
  const summaryP2 = makeSidebarThreadSummary({
    id: threadP2,
    environmentId: primaryEnvId,
    projectId: sharedProjectPrimaryId,
    title: "Shared primary thread 2",
  });
  const summaryR1 = makeSidebarThreadSummary({
    id: threadR1,
    environmentId: remoteEnvId,
    projectId: sharedProjectRemoteId,
    title: "Shared remote thread 1",
  });
  const summaryL1 = makeSidebarThreadSummary({
    id: threadL1,
    environmentId: primaryEnvId,
    projectId: localOnlyProjectId,
    title: "Local only thread 1",
  });
  const summaryRO1 = makeSidebarThreadSummary({
    id: threadRO1,
    environmentId: remoteEnvId,
    projectId: remoteOnlyProjectId,
    title: "Remote only thread 1",
  });

  const primaryEnvState: EnvironmentState = {
    ...makeEmptyEnvironmentState(),
    projectIds: [sharedProjectPrimaryId, localOnlyProjectId],
    projectById: {
      [sharedProjectPrimaryId]: sharedProjectPrimary,
      [localOnlyProjectId]: localOnlyProject,
    },
    threadIds: [threadP1, threadP2, threadL1],
    threadIdsByProjectId: {
      [sharedProjectPrimaryId]: [threadP1, threadP2],
      [localOnlyProjectId]: [threadL1],
    },
    sidebarThreadSummaryById: {
      [threadP1]: summaryP1,
      [threadP2]: summaryP2,
      [threadL1]: summaryL1,
    },
  };

  const remoteEnvState: EnvironmentState = {
    ...makeEmptyEnvironmentState(),
    projectIds: [sharedProjectRemoteId, remoteOnlyProjectId],
    projectById: {
      [sharedProjectRemoteId]: sharedProjectRemote,
      [remoteOnlyProjectId]: remoteOnlyProject,
    },
    threadIds: [threadR1, threadRO1],
    threadIdsByProjectId: {
      [sharedProjectRemoteId]: [threadR1],
      [remoteOnlyProjectId]: [threadRO1],
    },
    sidebarThreadSummaryById: {
      [threadR1]: summaryR1,
      [threadRO1]: summaryRO1,
    },
  };

  return {
    activeEnvironmentId: primaryEnvId,
    environmentStateById: {
      [primaryEnvId]: primaryEnvState,
      [remoteEnvId]: remoteEnvState,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("environment grouping", () => {
  describe("deriveLogicalProjectKey", () => {
    it("uses repositoryIdentity.canonicalKey when present", () => {
      const project = makeSharedRepoProject({
        id: sharedProjectPrimaryId,
        environmentId: primaryEnvId,
        name: "shared-repo",
      });
      expect(deriveLogicalProjectKey(project)).toBe(SHARED_REPO_CANONICAL_KEY);
    });

    it("falls back to scoped project key when no repositoryIdentity", () => {
      const project = makeProject({
        id: localOnlyProjectId,
        environmentId: primaryEnvId,
        name: "local-only",
      });
      expect(deriveLogicalProjectKey(project)).toBe(derivePhysicalProjectKey(project));
    });

    it("groups projects from different environments that share the same canonical key", () => {
      const primary = makeSharedRepoProject({
        id: sharedProjectPrimaryId,
        environmentId: primaryEnvId,
        name: "shared-repo",
      });
      const remote = makeSharedRepoProject({
        id: sharedProjectRemoteId,
        environmentId: remoteEnvId,
        name: "shared-repo",
      });
      expect(deriveLogicalProjectKey(primary)).toBe(deriveLogicalProjectKey(remote));
    });

    it("groups repo root and nested projects from the same repository by default", () => {
      const rootProject = makeSharedRepoProject({
        id: sharedProjectPrimaryId,
        environmentId: primaryEnvId,
        name: "shared-repo",
        cwd: "/workspace/repo",
        rootPath: "/workspace/repo",
      });
      const nestedProject = makeSharedRepoProject({
        id: localOnlyProjectId,
        environmentId: primaryEnvId,
        name: "web",
        cwd: "/workspace/repo/apps/web",
        rootPath: "/workspace/repo",
      });

      expect(deriveLogicalProjectKey(rootProject)).toBe(SHARED_REPO_CANONICAL_KEY);
      expect(deriveLogicalProjectKey(nestedProject)).toBe(SHARED_REPO_CANONICAL_KEY);
    });

    it("uses repository path grouping when requested", () => {
      const rootProject = makeSharedRepoProject({
        id: sharedProjectPrimaryId,
        environmentId: primaryEnvId,
        name: "shared-repo",
        cwd: "/workspace/repo",
        rootPath: "/workspace/repo",
      });
      const nestedProject = makeSharedRepoProject({
        id: localOnlyProjectId,
        environmentId: primaryEnvId,
        name: "web",
        cwd: "/workspace/repo/apps/web",
        rootPath: "/workspace/repo",
      });

      expect(
        deriveLogicalProjectKey(rootProject, {
          groupingMode: "repository_path",
        }),
      ).toBe(SHARED_REPO_CANONICAL_KEY);
      expect(
        deriveLogicalProjectKey(nestedProject, {
          groupingMode: "repository_path",
        }),
      ).toBe(`${SHARED_REPO_CANONICAL_KEY}::apps/web`);
    });

    it("uses parent directory grouping when requested", () => {
      const rootProject = makeSharedRepoProject({
        id: sharedProjectPrimaryId,
        environmentId: primaryEnvId,
        name: "shared-repo",
        cwd: "/workspace/repo",
        rootPath: "/workspace/repo",
      });
      const webProject = makeSharedRepoProject({
        id: localOnlyProjectId,
        environmentId: primaryEnvId,
        name: "web",
        cwd: "/workspace/repo/apps/web",
        rootPath: "/workspace/repo",
      });
      const docsProject = makeSharedRepoProject({
        id: remoteOnlyProjectId,
        environmentId: primaryEnvId,
        name: "docs",
        cwd: "/workspace/repo/apps/docs",
        rootPath: "/workspace/repo",
      });
      const rootChildProject = makeSharedRepoProject({
        id: sharedProjectRemoteId,
        environmentId: primaryEnvId,
        name: "scripts",
        cwd: "/workspace/repo/scripts",
        rootPath: "/workspace/repo",
      });

      expect(
        deriveLogicalProjectKey(rootProject, {
          groupingMode: "parent_directory",
        }),
      ).toBe(`${primaryEnvId}::parent:/workspace`);
      expect(
        deriveLogicalProjectKey(webProject, {
          groupingMode: "parent_directory",
        }),
      ).toBe(`${primaryEnvId}::parent:/workspace/repo/apps`);
      expect(
        deriveLogicalProjectKey(docsProject, {
          groupingMode: "parent_directory",
        }),
      ).toBe(`${primaryEnvId}::parent:/workspace/repo/apps`);
      expect(
        deriveLogicalProjectKey(rootChildProject, {
          groupingMode: "parent_directory",
        }),
      ).toBe(`${primaryEnvId}::parent:/workspace/repo`);
    });

    it("groups matching nested project paths across environments when repo roots differ", () => {
      const primary = makeSharedRepoProject({
        id: sharedProjectPrimaryId,
        environmentId: primaryEnvId,
        name: "web",
        cwd: "/workspace/repo/apps/web",
        rootPath: "/workspace/repo",
      });
      const remote = makeSharedRepoProject({
        id: sharedProjectRemoteId,
        environmentId: remoteEnvId,
        name: "web",
        cwd: "/srv/checkout/apps/web",
        rootPath: "/srv/checkout",
      });

      expect(
        deriveLogicalProjectKey(primary, {
          groupingMode: "repository_path",
        }),
      ).toBe(`${SHARED_REPO_CANONICAL_KEY}::apps/web`);
      expect(
        deriveLogicalProjectKey(primary, {
          groupingMode: "repository_path",
        }),
      ).toBe(
        deriveLogicalProjectKey(remote, {
          groupingMode: "repository_path",
        }),
      );
    });

    it("does not group matching parent directories across environments", () => {
      const primary = makeSharedRepoProject({
        id: sharedProjectPrimaryId,
        environmentId: primaryEnvId,
        name: "web",
        cwd: "/workspace/repo/apps/web",
        rootPath: "/workspace/repo",
      });
      const remote = makeSharedRepoProject({
        id: sharedProjectRemoteId,
        environmentId: remoteEnvId,
        name: "docs",
        cwd: "/srv/checkout/apps/docs",
        rootPath: "/srv/checkout",
      });

      expect(
        deriveLogicalProjectKey(primary, {
          groupingMode: "parent_directory",
        }),
      ).toBe(`${primaryEnvId}::parent:/workspace/repo/apps`);
      expect(
        deriveLogicalProjectKey(primary, {
          groupingMode: "parent_directory",
        }),
      ).not.toBe(
        deriveLogicalProjectKey(remote, {
          groupingMode: "parent_directory",
        }),
      );
    });

    it("does NOT group projects without shared canonical key", () => {
      const local = makeProject({
        id: localOnlyProjectId,
        environmentId: primaryEnvId,
        name: "local-only",
      });
      const remote = makeProject({
        id: remoteOnlyProjectId,
        environmentId: remoteEnvId,
        name: "remote-only",
      });
      expect(deriveLogicalProjectKey(local)).not.toBe(deriveLogicalProjectKey(remote));
    });

    it("uses per-project overrides from settings", () => {
      const project = makeSharedRepoProject({
        id: sharedProjectPrimaryId,
        environmentId: primaryEnvId,
        name: "shared-repo",
      });

      expect(resolveProjectGroupingMode(project, DEFAULT_GROUPING_SETTINGS)).toBe("repository");
      expect(
        deriveLogicalProjectKeyFromSettings(project, {
          ...DEFAULT_GROUPING_SETTINGS,
          sidebarProjectGroupingOverrides: {
            [derivePhysicalProjectKey(project)]: "separate",
          },
        }),
      ).toBe(derivePhysicalProjectKey(project));
    });

    it("uses a manual project group when manual grouping is active", () => {
      const local = makeProject({
        id: sharedProjectPrimaryId,
        environmentId: primaryEnvId,
        name: "frontend",
        cwd: "/workspace/client-a",
      });
      const remote = makeProject({
        id: remoteOnlyProjectId,
        environmentId: remoteEnvId,
        name: "backend",
        cwd: "/workspace/client-b",
      });

      expect(
        deriveLogicalProjectKeyFromSettings(local, {
          ...DEFAULT_GROUPING_SETTINGS,
          sidebarProjectGroupingMode: "manual",
          sidebarProjectManualGroups: {
            [derivePhysicalProjectKey(local)]: "Client work",
            [derivePhysicalProjectKey(remote)]: "Client work",
          },
        }),
      ).toBe(
        deriveLogicalProjectKeyFromSettings(remote, {
          ...DEFAULT_GROUPING_SETTINGS,
          sidebarProjectGroupingMode: "manual",
          sidebarProjectManualGroups: {
            [derivePhysicalProjectKey(local)]: "Client work",
            [derivePhysicalProjectKey(remote)]: "Client work",
          },
        }),
      );
    });

    it("ignores saved manual groups when another grouping mode is active", () => {
      const local = makeProject({
        id: sharedProjectPrimaryId,
        environmentId: primaryEnvId,
        name: "frontend",
        cwd: "/workspace/client-a",
      });
      const remote = makeProject({
        id: remoteOnlyProjectId,
        environmentId: remoteEnvId,
        name: "backend",
        cwd: "/workspace/client-b",
      });
      const manualGroups = {
        [derivePhysicalProjectKey(local)]: "Client work",
        [derivePhysicalProjectKey(remote)]: "Client work",
      };

      expect(
        deriveLogicalProjectKeyFromSettings(local, {
          ...DEFAULT_GROUPING_SETTINGS,
          sidebarProjectGroupingMode: "separate",
          sidebarProjectManualGroups: manualGroups,
        }),
      ).toBe(derivePhysicalProjectKey(local));
      expect(
        deriveLogicalProjectKeyFromSettings(remote, {
          ...DEFAULT_GROUPING_SETTINGS,
          sidebarProjectGroupingMode: "separate",
          sidebarProjectManualGroups: manualGroups,
        }),
      ).toBe(derivePhysicalProjectKey(remote));
    });
  });

  describe("selectProjectsAcrossEnvironments", () => {
    it("returns all projects from all environments", () => {
      const state = makeFixtureState();
      const projects = selectProjectsAcrossEnvironments(state);
      expect(projects).toHaveLength(4);
      const names = projects.map((p) => p.name).toSorted();
      expect(names).toEqual(["local-only", "remote-only", "shared-repo", "shared-repo"]);
    });
  });

  describe("selectSidebarThreadsAcrossEnvironments", () => {
    it("returns all sidebar thread summaries from all environments", () => {
      const state = makeFixtureState();
      const threads = selectSidebarThreadsAcrossEnvironments(state);
      expect(threads).toHaveLength(5);
      const ids = new Set(threads.map((t) => t.id));
      expect(ids).toContain(threadP1);
      expect(ids).toContain(threadP2);
      expect(ids).toContain(threadR1);
      expect(ids).toContain(threadL1);
      expect(ids).toContain(threadRO1);
    });
  });

  describe("selectSidebarThreadsForProjectRef", () => {
    it("returns threads for a single project ref", () => {
      const state = makeFixtureState();
      const ref = scopeProjectRef(primaryEnvId, sharedProjectPrimaryId);
      const threads = selectSidebarThreadsForProjectRef(state, ref);
      expect(threads).toHaveLength(2);
      expect(threads.map((t) => t.id)).toEqual([threadP1, threadP2]);
    });

    it("returns empty array for null ref", () => {
      const state = makeFixtureState();
      expect(selectSidebarThreadsForProjectRef(state, null)).toEqual([]);
    });

    it("returns empty array for nonexistent environment", () => {
      const state = makeFixtureState();
      const ref = scopeProjectRef(EnvironmentId.make("nonexistent"), sharedProjectPrimaryId);
      expect(selectSidebarThreadsForProjectRef(state, ref)).toEqual([]);
    });
  });

  describe("selectSidebarThreadsForProjectRefs", () => {
    it("returns empty for empty refs", () => {
      const state = makeFixtureState();
      expect(selectSidebarThreadsForProjectRefs(state, [])).toEqual([]);
    });

    it("returns threads for a single ref", () => {
      const state = makeFixtureState();
      const refs = [scopeProjectRef(primaryEnvId, sharedProjectPrimaryId)];
      const threads = selectSidebarThreadsForProjectRefs(state, refs);
      expect(threads).toHaveLength(2);
      expect(threads.map((t) => t.id)).toEqual([threadP1, threadP2]);
    });

    it("returns combined threads from multiple refs across environments", () => {
      const state = makeFixtureState();
      const refs = [
        scopeProjectRef(primaryEnvId, sharedProjectPrimaryId),
        scopeProjectRef(remoteEnvId, sharedProjectRemoteId),
      ];
      const threads = selectSidebarThreadsForProjectRefs(state, refs);
      expect(threads).toHaveLength(3);
      const ids = new Set(threads.map((t) => t.id));
      expect(ids).toContain(threadP1);
      expect(ids).toContain(threadP2);
      expect(ids).toContain(threadR1);
    });

    it("returns threads from remote-only project", () => {
      const state = makeFixtureState();
      const refs = [scopeProjectRef(remoteEnvId, remoteOnlyProjectId)];
      const threads = selectSidebarThreadsForProjectRefs(state, refs);
      expect(threads).toHaveLength(1);
      expect(threads[0]?.id).toBe(threadRO1);
    });

    it("returns threads from local-only project", () => {
      const state = makeFixtureState();
      const refs = [scopeProjectRef(primaryEnvId, localOnlyProjectId)];
      const threads = selectSidebarThreadsForProjectRefs(state, refs);
      expect(threads).toHaveLength(1);
      expect(threads[0]?.id).toBe(threadL1);
    });

    it("handles refs with nonexistent environment gracefully", () => {
      const state = makeFixtureState();
      const refs = [
        scopeProjectRef(primaryEnvId, sharedProjectPrimaryId),
        scopeProjectRef(EnvironmentId.make("nonexistent"), ProjectId.make("nope")),
      ];
      const threads = selectSidebarThreadsForProjectRefs(state, refs);
      // Only returns threads from the valid ref
      expect(threads).toHaveLength(2);
      expect(threads.map((t) => t.id)).toEqual([threadP1, threadP2]);
    });
  });

  describe("logical project grouping for sidebar", () => {
    it("computes correct logical key for grouped projects and aggregates threads", () => {
      const state = makeFixtureState();
      const allProjects = selectProjectsAcrossEnvironments(state);

      // Group by logical key
      const groups = new Map<string, Project[]>();
      for (const project of allProjects) {
        const key = deriveLogicalProjectKey(project);
        const existing = groups.get(key) ?? [];
        existing.push(project);
        groups.set(key, existing);
      }

      // Shared project should be grouped
      const sharedGroup = groups.get(SHARED_REPO_CANONICAL_KEY);
      expect(sharedGroup).toBeDefined();
      expect(sharedGroup).toHaveLength(2);
      expect(sharedGroup!.map((p) => p.environmentId).toSorted()).toEqual(
        [primaryEnvId, remoteEnvId].toSorted(),
      );

      // Build member refs for the grouped project and fetch threads
      const memberRefs = sharedGroup!.map((p) => scopeProjectRef(p.environmentId, p.id));
      const threads = selectSidebarThreadsForProjectRefs(state, memberRefs);
      expect(threads).toHaveLength(3);
      const threadIds = threads.map((t) => t.id);
      expect(threadIds).toContain(threadP1);
      expect(threadIds).toContain(threadP2);
      expect(threadIds).toContain(threadR1);
    });

    it("local-only and remote-only projects remain ungrouped", () => {
      const state = makeFixtureState();
      const allProjects = selectProjectsAcrossEnvironments(state);

      const groups = new Map<string, Project[]>();
      for (const project of allProjects) {
        const key = deriveLogicalProjectKey(project);
        const existing = groups.get(key) ?? [];
        existing.push(project);
        groups.set(key, existing);
      }

      // Should have 3 groups total: shared, local-only, remote-only
      expect(groups.size).toBe(3);

      // Local-only group
      const localKey = deriveLogicalProjectKey(
        allProjects.find((p) => p.id === localOnlyProjectId)!,
      );
      expect(groups.get(localKey)).toHaveLength(1);

      // Remote-only group
      const remoteKey = deriveLogicalProjectKey(
        allProjects.find((p) => p.id === remoteOnlyProjectId)!,
      );
      expect(groups.get(remoteKey)).toHaveLength(1);
    });

    it("uses the parent directory as the grouped sidebar label", () => {
      const snapshots = buildSidebarProjectSnapshots({
        projects: [
          makeSharedRepoProject({
            id: sharedProjectPrimaryId,
            environmentId: primaryEnvId,
            name: "web",
            cwd: "/workspace/repo/apps/web",
            rootPath: "/workspace/repo",
          }),
          makeSharedRepoProject({
            id: sharedProjectRemoteId,
            environmentId: primaryEnvId,
            name: "docs",
            cwd: "/workspace/repo/apps/docs",
            rootPath: "/workspace/repo",
          }),
        ],
        settings: {
          sidebarProjectGroupingMode: "parent_directory",
          sidebarProjectManualGroups: {},
          sidebarProjectGroupingOverrides: {},
        },
        primaryEnvironmentId: primaryEnvId,
        resolveEnvironmentLabel: () => null,
      });

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.displayName).toBe("apps");
      expect(snapshots[0]?.groupedProjectCount).toBe(2);
    });

    it("uses the manual group label as the sidebar label", () => {
      const projectA = makeProject({
        id: sharedProjectPrimaryId,
        environmentId: primaryEnvId,
        name: "client-a",
        cwd: "/workspace/client-a",
      });
      const projectB = makeProject({
        id: remoteOnlyProjectId,
        environmentId: remoteEnvId,
        name: "client-b",
        cwd: "/workspace/client-b",
      });

      const snapshots = buildSidebarProjectSnapshots({
        projects: [projectA, projectB],
        settings: {
          ...DEFAULT_GROUPING_SETTINGS,
          sidebarProjectGroupingMode: "manual",
          sidebarProjectManualGroups: {
            [derivePhysicalProjectKey(projectA)]: "Client work",
            [derivePhysicalProjectKey(projectB)]: "Client work",
          },
        },
        primaryEnvironmentId: primaryEnvId,
        resolveEnvironmentLabel: () => null,
      });

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.displayName).toBe("Client work");
      expect(snapshots[0]?.groupedProjectCount).toBe(2);
    });
  });
});
