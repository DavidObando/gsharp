// <copyright file="WorkspaceInitializer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Tasks;

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
            project.AssemblyName = disc.AssemblyName;
            project.TargetFramework = disc.TargetFramework;
            project.ProjectReferences = disc.ProjectReferences;
            project.ReferenceSourcePath = disc.ReferenceSourcePath;
            project.References = disc.References;
            foreach (var sourceFile in disc.SourceFiles)
            {
                project.AddFileFromDisk(sourceFile);
                workspaceState.RegisterFile(sourceFile, project);
            }
        }

        // Warm up each project's compilation on the thread pool so the first
        // user-facing request (file open → diagnostics) doesn't pay the full
        // cold-bind cost (typically ~500ms for a project with a large reference
        // graph). Fire-and-forget is fine — every public consumer goes through
        // ProjectState.GetCompilation which locks and lazy-initializes, so the
        // background warm-up just races with the first real request to populate
        // the cache. If discovery turns up an unbindable project the binder
        // surfaces those diagnostics through the normal path; we swallow any
        // exception here so warm-up never crashes the LSP startup path.
        foreach (var disc in discovered)
        {
            var project = workspaceState.GetProject(disc.ProjectFilePath);
            if (project != null)
            {
                _ = Task.Run(() =>
                {
                    try
                    {
                        var compilation = project.GetCompilation();
                        _ = compilation.BoundProgram;

                        // Pre-build the LSP SemanticModel + references index so the
                        // first CodeLens / hover / FindReferences request after open
                        // hits a warm cache instead of paying ~500ms of tree walks.
                        SemanticLookup.WarmUp(compilation);
                    }
                    catch
                    {
                    }
                });
            }
        }
    }
}
