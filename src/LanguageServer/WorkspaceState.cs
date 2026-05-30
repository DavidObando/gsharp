// <copyright file="WorkspaceState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace GSharp.LanguageServer;

/// <summary>
/// Manages all projects in the workspace and provides file-to-project mapping.
/// </summary>
public class WorkspaceState
{
    private readonly ConcurrentDictionary<string, ProjectState> projects = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, string> fileToProject = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Gets or sets the workspace root path.
    /// </summary>
    public string RootPath { get; set; }

    /// <summary>
    /// Gets all projects in the workspace.
    /// </summary>
    public IReadOnlyCollection<ProjectState> Projects => projects.Values.ToList();

    /// <summary>
    /// Adds a project to the workspace.
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c> file.</param>
    /// <returns>The created <see cref="ProjectState"/>.</returns>
    public ProjectState AddProject(string projectFilePath)
    {
        var normalized = Path.GetFullPath(projectFilePath);
        var project = new ProjectState(normalized);
        projects[normalized] = project;
        return project;
    }

    /// <summary>
    /// Removes a project from the workspace.
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c> file.</param>
    /// <returns>True if the project was found and removed.</returns>
    public bool RemoveProject(string projectFilePath)
    {
        var normalized = Path.GetFullPath(projectFilePath);
        if (projects.TryRemove(normalized, out var project))
        {
            foreach (var file in project.SourceFiles)
            {
                fileToProject.TryRemove(Path.GetFullPath(file), out _);
            }

            return true;
        }

        return false;
    }

    /// <summary>
    /// Gets the project that owns the given file.
    /// </summary>
    /// <param name="filePath">Absolute path to a <c>.gs</c> file.</param>
    /// <returns>The owning <see cref="ProjectState"/>, or null if not found.</returns>
    public ProjectState GetProjectForFile(string filePath)
    {
        var normalized = Path.GetFullPath(filePath);

        if (fileToProject.TryGetValue(normalized, out var projectPath) && projects.TryGetValue(projectPath, out var project))
        {
            return project;
        }

        // Fallback: search all projects
        foreach (var p in projects.Values)
        {
            if (p.ContainsFile(normalized))
            {
                fileToProject[normalized] = p.ProjectFilePath;
                return p;
            }
        }

        return null;
    }

    /// <summary>
    /// Gets a project by its project file path.
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c> file.</param>
    /// <returns>The <see cref="ProjectState"/>, or null if not found.</returns>
    public ProjectState GetProject(string projectFilePath)
    {
        var normalized = Path.GetFullPath(projectFilePath);
        return projects.TryGetValue(normalized, out var project) ? project : null;
    }

    /// <summary>
    /// Registers a file-to-project mapping.
    /// </summary>
    /// <param name="filePath">Absolute path to the <c>.gs</c> file.</param>
    /// <param name="project">The owning project.</param>
    public void RegisterFile(string filePath, ProjectState project)
    {
        var normalized = Path.GetFullPath(filePath);
        fileToProject[normalized] = project.ProjectFilePath;
    }

    /// <summary>
    /// Unregisters a file from the workspace mapping.
    /// </summary>
    /// <param name="filePath">Absolute path to the <c>.gs</c> file.</param>
    public void UnregisterFile(string filePath)
    {
        var normalized = Path.GetFullPath(filePath);
        fileToProject.TryRemove(normalized, out _);
    }

    /// <summary>
    /// Gets the fallback project for files not in any discovered project.
    /// Creates an implicit project if needed when no <c>.gsproj</c> exists.
    /// </summary>
    /// <returns>An implicit project for loose files, or null if real projects exist.</returns>
    public ProjectState GetOrCreateImplicitProject()
    {
        const string implicitKey = "<implicit>";
        if (projects.TryGetValue(implicitKey, out var existing))
        {
            return existing;
        }

        if (projects.IsEmpty)
        {
            var project = new ProjectState(implicitKey);
            projects[implicitKey] = project;
            return project;
        }

        return null;
    }

    /// <summary>
    /// Gets the referenced projects for a given project, resolving <c>ProjectReference</c> paths.
    /// </summary>
    /// <param name="project">The project to get references for.</param>
    /// <returns>The list of referenced <see cref="ProjectState"/> instances.</returns>
    public IReadOnlyList<ProjectState> GetReferencedProjects(ProjectState project)
    {
        if (project?.ProjectReferences == null || project.ProjectReferences.Count == 0)
        {
            return Array.Empty<ProjectState>();
        }

        var result = new List<ProjectState>();
        foreach (var refPath in project.ProjectReferences)
        {
            var refProject = GetProject(refPath);
            if (refProject != null)
            {
                result.Add(refProject);
            }
        }

        return result;
    }
}
