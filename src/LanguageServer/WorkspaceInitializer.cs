// <copyright file="WorkspaceInitializer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
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
    /// <param name="cancellationToken">Cancelled when the server shuts down mid-load.</param>
    /// <param name="tryGetOpenBuffer">Returns the client's current buffer text for a file
    /// path if the client already has it open, or null. When the caller races this method
    /// against didOpen/didChange (the LSP server does), this ensures the client's buffer
    /// always wins over disk text. Callers that run single-threaded (tests) can omit it.</param>
    /// <param name="withGate">Runs a single file's registration under the same gate used by
    /// didOpen/didChange/didSave, so registration and buffer edits never interleave and
    /// clobber each other. Callers that run single-threaded (tests) can omit it.</param>
    public static void Initialize(
        WorkspaceState workspaceState,
        string rootPath,
        CancellationToken cancellationToken = default,
        Func<string, string> tryGetOpenBuffer = null,
        Action<Action> withGate = null)
    {
        if (string.IsNullOrEmpty(rootPath))
        {
            return;
        }

        workspaceState.RootPath = rootPath;

        var discovered = ProjectDiscovery.DiscoverProjects(rootPath);
        foreach (var disc in discovered)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var project = workspaceState.AddProject(disc.ProjectFilePath);
            project.AssemblyName = disc.AssemblyName;
            project.TargetFramework = disc.TargetFramework;
            project.ProjectReferences = disc.ProjectReferences;
            project.ReferenceSourcePath = disc.ReferenceSourcePath;
            project.References = disc.References;
            foreach (var sourceFile in disc.SourceFiles)
            {
                cancellationToken.ThrowIfCancellationRequested();

                void RegisterFile()
                {
                    // Issue #1786 follow-up (B1): prefer the client's open buffer over disk so a
                    // didOpen/didChange that raced ahead of discovery is never clobbered with
                    // stale disk text.
                    var openText = tryGetOpenBuffer?.Invoke(sourceFile);
                    if (openText != null)
                    {
                        project.UpdateFile(sourceFile, openText);
                    }
                    else
                    {
                        project.AddFileFromDisk(sourceFile);
                    }

                    workspaceState.RegisterFile(sourceFile, project);
                }

                if (withGate != null)
                {
                    withGate(RegisterFile);
                }
                else
                {
                    RegisterFile();
                }
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
            if (cancellationToken.IsCancellationRequested)
            {
                break;
            }

            var project = workspaceState.GetProject(disc.ProjectFilePath);
            if (project != null)
            {
                _ = Task.Run(() =>
                {
                    try
                    {
                        if (cancellationToken.IsCancellationRequested)
                        {
                            return;
                        }

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
