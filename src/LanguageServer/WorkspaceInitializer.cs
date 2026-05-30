// <copyright file="WorkspaceInitializer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.LanguageServer;

/// <summary>
/// Handles workspace initialization by discovering projects and loading source files.
/// </summary>
public static class WorkspaceInitializer
{
    /// <summary>
    /// Discovers projects under the workspace root and loads their source files into state.
    /// </summary>
    /// <param name="workspaceState"><see cref="WorkspaceState"/> instance.</param>
    /// <param name="rootPath">The workspace root path.</param>
    public static void Initialize(WorkspaceState workspaceState, string rootPath)
    {
        if (string.IsNullOrEmpty(rootPath))
        {
            return;
        }

        workspaceState.RootPath = rootPath;

        var discovered = ProjectDiscovery.DiscoverProjects(rootPath);
        foreach (var disc in discovered)
        {
            var project = workspaceState.AddProject(disc.ProjectFilePath);
            project.ProjectReferences = disc.ProjectReferences;
            foreach (var sourceFile in disc.SourceFiles)
            {
                project.AddFileFromDisk(sourceFile);
                workspaceState.RegisterFile(sourceFile, project);
            }
        }
    }
}
