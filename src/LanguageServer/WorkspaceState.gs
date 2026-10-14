// <copyright file="WorkspaceState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis
import System.IO
import System.Linq

/// Manages all projects in the workspace and provides file-to-project mapping.
open class WorkspaceState {
    private let projects ConcurrentDictionary[string, ProjectState] = ConcurrentDictionary[string, ProjectState](
        StringComparer.OrdinalIgnoreCase
    )
    private let fileToProject ConcurrentDictionary[string, string] = ConcurrentDictionary[string, string](
        StringComparer.OrdinalIgnoreCase
    )
    private let openBuffers ConcurrentDictionary[string, string] = ConcurrentDictionary[string, string](
        StringComparer.OrdinalIgnoreCase
    )

    /// Gets or sets the workspace root path.
    prop RootPath string?

    /// Gets all projects in the workspace.
    prop Projects IReadOnlyCollection[ProjectState] -> projects.Values.ToList()

    /// Adds a project to the workspace.
    /// @param projectFilePath Absolute path to the `.gsproj` file.
    /// @returns The created (cref:ProjectState).
    func AddProject(projectFilePath string) ProjectState {
        let normalized = Path.GetFullPath(projectFilePath)
        let project = ProjectState(normalized)
        projects[normalized] = project
        return project
    }

    /// Removes a project from the workspace.
    /// @param projectFilePath Absolute path to the `.gsproj` file.
    /// @returns True if the project was found and removed.
    func RemoveProject(projectFilePath string) bool {
        let normalized = Path.GetFullPath(projectFilePath)
        if projects.TryRemove(normalized, out var project) {
            for file in project.SourceFiles {
                fileToProject.TryRemove(Path.GetFullPath(file), out _)
            }
            return true
        }
        return false
    }

    /// Gets the project that owns the given file.
    /// @param filePath Absolute path to a `.gs` file.
    /// @returns The owning (cref:ProjectState), or null if not found.
    func GetProjectForFile(filePath string) ProjectState? {
        let normalized = Path.GetFullPath(filePath)
        if fileToProject.TryGetValue(normalized, out var projectPath) && projects.TryGetValue(
            projectPath,
            out var project
        ) {
            return project
        }
        // Fallback: prefer the nearest containing project when nested projects both
        // include the same file through recursive default globs.
        let found ProjectState? = projects
            .Values
            .Where((p ProjectState) -> p.ContainsFile(normalized))
            .OrderByDescending((p ProjectState) -> ProjectSpecificity(normalized, p.ProjectFilePath))
            .FirstOrDefault()
        if found != nil {
            fileToProject[normalized] = found.ProjectFilePath
        }
        return found
    }

    /// Gets a project by its project file path.
    /// @param projectFilePath Absolute path to the `.gsproj` file.
    /// @returns The (cref:ProjectState), or null if not found.
    func GetProject(projectFilePath string) ProjectState? {
        let normalized = Path.GetFullPath(projectFilePath)
        return if projects.TryGetValue(normalized, out var project) {
            project
        } else {
            default(ProjectState?)
        }
    }

    /// Registers a file-to-project mapping.
    /// @param filePath Absolute path to the `.gs` file.
    /// @param project The owning project.
    func RegisterFile(filePath string, project ProjectState) {
        let normalized = Path.GetFullPath(filePath)
        fileToProject.AddOrUpdate(
            normalized,
            project.ProjectFilePath,
            (_ string, existing string) -> if ProjectSpecificity(
                normalized,
                project.ProjectFilePath
            ) > ProjectSpecificity(normalized, existing) {
                project.ProjectFilePath
            } else {
                existing
            }
        )
    }

    /// Unregisters a file from the workspace mapping.
    /// @param filePath Absolute path to the `.gs` file.
    func UnregisterFile(filePath string) {
        let normalized = Path.GetFullPath(filePath)
        fileToProject.TryRemove(normalized, out _)
    }

    /// Records the client's current in-memory buffer for a file (didOpen/didChange/didSave).
    /// Issue #1786 follow-up: the background workspace loader consults this so a file the
    /// client already has open is always registered with the client's buffer text, never
    /// stale disk text, regardless of how the two race.
    /// @param filePath Absolute path to the `.gs` file.
    /// @param text The client's current buffer text.
    func SetOpenBuffer(filePath string, text string) {
        openBuffers[Path.GetFullPath(filePath)] = text
    }

    /// Clears the recorded buffer for a file once the client closes it (didClose).
    /// @param filePath Absolute path to the `.gs` file.
    func ClearOpenBuffer(filePath string) {
        openBuffers.TryRemove(Path.GetFullPath(filePath), out _)
    }

    /// Gets the client's current buffer text for a file, if the client has it open.
    /// @param filePath Absolute path to the `.gs` file.
    /// @param text The buffer text, if present.
    /// @returns True if the file is currently open with a recorded buffer.
    func TryGetOpenBuffer(filePath string, out text string?) bool {
        return openBuffers.TryGetValue(Path.GetFullPath(filePath), out text)
    }

    /// Gets the fallback project for files not in any discovered project.
    /// Creates an implicit project if needed when no `.gsproj` exists.
    /// @returns An implicit project for loose files, or null if real projects exist.
    func GetOrCreateImplicitProject() ProjectState? {
        const implicitKey = "<implicit>"
        if projects.TryGetValue(implicitKey, out var existing) {
            return existing
        }
        if projects.IsEmpty {
            let project = ProjectState(implicitKey)
            projects[implicitKey] = project
            return project
        }
        return nil
    }

    /// Gets the referenced projects for a given project, resolving `ProjectReference` paths.
    /// @param project The project to get references for.
    /// @returns The list of referenced (cref:ProjectState) instances.
    func GetReferencedProjects(project ProjectState?) IReadOnlyList[ProjectState] {
        if project?.ProjectReferences == nil || project!!.ProjectReferences.Count == 0 {
            return Array.Empty[ProjectState]()
        }
        let result = List[ProjectState]()
        for refPath in project!!.ProjectReferences {
            let refProject ProjectState? = GetProject(refPath)
            if refProject != nil {
                result.Add(refProject)
            }
        }
        return result
    }

    /// Maps an imported assembly's file path back to the sibling G# project
    /// that produced it, if any. Cross-project Go-to-Definition uses this to
    /// jump from an `Imported*Symbol` loaded out of `obj/.../Lib.dll`
    /// (or `obj/.../refint/Lib.dll`) into the originating `.gsproj`
    /// project's syntax trees without having to read the PDB.
    /// @remarks Matching is by basename (case-insensitive on Windows): the SDK names the
    /// emitted DLL after `$(AssemblyName)`, which defaults to
    /// `$(TargetName)`, which in turn defaults to the project file's base
    /// name. Each (cref:ProjectState.AssemblyName) is populated by
    /// (cref:WorkspaceInitializer.Initialize) from
    /// (cref:ProjectDiscovery.DiscoverProject(string)); projects added
    /// outside of discovery (test scaffolding, the implicit project for loose
    /// files) fall through and return `false`.
    /// @param assemblyFilePath Absolute path to the imported assembly,
    /// as it appears in a
    /// (cref:GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver)
    /// reference list.
    /// @param project The matching sibling project on success.
    /// @returns `true` when a sibling G# project matched.
    func TryGetProjectByOutputAssembly(assemblyFilePath string, @NotNullWhen(true) out project ProjectState?) bool {
        project = nil
        if string.IsNullOrEmpty(assemblyFilePath) {
            return false
        }
        let assemblyName = Path.GetFileNameWithoutExtension(assemblyFilePath)
        if string.IsNullOrEmpty(assemblyName) {
            return false
        }
        for candidate in projects.Values {
            let candidateName = candidate.AssemblyName
            if string.IsNullOrEmpty(candidateName) {
                continue
            }
            if string.Equals(candidateName, assemblyName, StringComparison.OrdinalIgnoreCase) {
                project = candidate
                return true
            }
        }
        return false
    }

    shared {
        private func ProjectSpecificity(filePath string, projectFilePath string) int32 {
            let projectDirectory = Path.GetDirectoryName(projectFilePath)
            if string.IsNullOrEmpty(projectDirectory) {
                return -1
            }
            let relative = Path.GetRelativePath(projectDirectory, filePath)
            return if relative == ".." || relative.StartsWith(
                ".." + Path.DirectorySeparatorChar,
                StringComparison.Ordinal
            ) ||
                Path.IsPathRooted(relative) {
                -1
            } else {
                projectDirectory.Length
            }
        }
    }
}
