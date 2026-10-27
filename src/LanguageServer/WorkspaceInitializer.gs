// <copyright file="WorkspaceInitializer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import System
import System.Collections.Generic
import System.Threading
import System.Threading.Tasks

/// Handles workspace initialization by discovering projects and loading source files.
shared class WorkspaceInitializer {
    /// Discovers projects under the workspace root and loads their source files into state.
    /// @param workspaceState (cref:WorkspaceState) instance.
    /// @param rootPath The workspace root path, or null for a single-file session without a workspace.
    /// @param cancellationToken Cancelled when the server shuts down mid-load.
    /// @param tryGetOpenBuffer Returns the client's current buffer text for a file
    /// path if the client already has it open, or null. When the caller races this method
    /// against didOpen/didChange (the LSP server does), this ensures the client's buffer
    /// always wins over disk text. Callers that run single-threaded (tests) can omit it.
    /// @param withGate Runs a single file's registration under the same gate used by
    /// didOpen/didChange/didSave, so registration and buffer edits never interleave and
    /// clobber each other. Callers that run single-threaded (tests) can omit it.
    /// @param waitForWarmUp Waits for project binding warm-up before returning.
    func Initialize(
        workspaceState WorkspaceState,
        rootPath string?,
        cancellationToken CancellationToken = default(CancellationToken),
        tryGetOpenBuffer((string) -> string?)? = nil,
        withGate((() -> void) -> void)? = nil,
        waitForWarmUp bool = false
    ) {
        if string.IsNullOrEmpty(rootPath) {
            return
        }
        workspaceState.RootPath = rootPath
        let discovered = ProjectDiscovery.DiscoverProjects(rootPath)
        for disc in discovered {
            cancellationToken.ThrowIfCancellationRequested()
            let project = workspaceState.AddProject(disc.ProjectFilePath)
            project.AssemblyName = disc.AssemblyName
            project.TargetFramework = disc.TargetFramework
            project.RootNamespace = disc.RootNamespace
            project.ProjectReferences = disc.ProjectReferences
            project.ReferenceSourcePath = disc.ReferenceSourcePath
            project.References = disc.References
            for sourceFile in disc.SourceFiles {
                cancellationToken.ThrowIfCancellationRequested()
                let RegisterFile = func () {
                    // Issue #1786 follow-up (B1): prefer the client's open buffer over disk so a
                    // didOpen/didChange that raced ahead of discovery is never clobbered with
                    // stale disk text.
                    let openText string? = tryGetOpenBuffer?(sourceFile)
                    if openText != nil {
                        project.UpdateFile(sourceFile, openText)
                    } else {
                        project.AddFileFromDisk(sourceFile)
                    }
                    workspaceState.RegisterFile(sourceFile, project)
                }
                if withGate != nil {
                    withGate(RegisterFile)
                } else {
                    RegisterFile()
                }
            }
        }
        // Warm up each project's compilation on the thread pool so the first
        // user-facing request (file open → diagnostics) doesn't pay the full
        // cold-bind cost (typically ~500ms for a project with a large reference
        // graph). The LSP waits for these tasks before enabling semantic
        // diagnostics so a cold pull cannot race a warm-up bind of the same
        // compilation. Direct callers retain the existing fire-and-forget behavior.
        let warmUps = List[Task]()
        for disc in discovered {
            if cancellationToken.IsCancellationRequested {
                break
            }
            let project ProjectState? = workspaceState.GetProject(disc.ProjectFilePath)
            if project != nil {
                warmUps.Add(
                    Task.Run(
                        () -> {
                            try {
                                if cancellationToken.IsCancellationRequested {
                                    return
                                }
                                let compilation = project.GetCompilation()
                                // ADR-0212 §7a: the diagnostics query is the warm-up; it binds the
                                // declarations and the bodies and keeps the answer.
                                let _ = compilation.GetDiagnostics(cancellationToken)
                                // Pre-build the LSP SemanticModel + references index so the
                                // first CodeLens / hover / FindReferences request after open
                                // hits a warm cache instead of paying ~500ms of tree walks.
                                SemanticLookup.WarmUp(compilation)
                            } catch { }
                        }
                    )
                )
            }
        }
        if waitForWarmUp {
            Task.WaitAll(warmUps.ToArray(), cancellationToken)
        }
    }
}
