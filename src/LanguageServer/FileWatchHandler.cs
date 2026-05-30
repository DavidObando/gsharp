// <copyright file="FileWatchHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using MediatR;
using Microsoft.Extensions.Logging;
using OmniSharp.Extensions.LanguageServer.Protocol.Client.Capabilities;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;
using OmniSharp.Extensions.LanguageServer.Protocol.Workspace;

namespace GSharp.LanguageServer;

/// <summary>
/// Handles workspace file system change notifications for <c>.gs</c> and <c>.gsproj</c> files.
/// </summary>
public class FileWatchHandler : DidChangeWatchedFilesHandlerBase
{
    private readonly WorkspaceState workspaceState;
    private readonly ILanguageServerFacade router;
    private readonly ILogger<FileWatchHandler> logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="FileWatchHandler"/> class.
    /// </summary>
    /// <param name="workspaceState"><see cref="WorkspaceState"/> instance.</param>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="logger">Logger instance.</param>
    public FileWatchHandler(WorkspaceState workspaceState, ILanguageServerFacade router, ILogger<FileWatchHandler> logger)
    {
        this.workspaceState = workspaceState;
        this.router = router;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public override Task<Unit> Handle(DidChangeWatchedFilesParams request, CancellationToken cancellationToken)
    {
        foreach (var change in request.Changes)
        {
            var filePath = change.Uri.GetFileSystemPath();
            if (string.IsNullOrEmpty(filePath))
            {
                continue;
            }

            if (filePath.EndsWith(".gsproj", StringComparison.OrdinalIgnoreCase))
            {
                this.HandleProjectFileChange(filePath, change.Type);
            }
            else if (filePath.EndsWith(".gs", StringComparison.OrdinalIgnoreCase))
            {
                this.HandleSourceFileChange(filePath, change.Type);
            }
        }

        return Unit.Task;
    }

    /// <inheritdoc/>
    protected override DidChangeWatchedFilesRegistrationOptions CreateRegistrationOptions(DidChangeWatchedFilesCapability capability, ClientCapabilities clientCapabilities)
    {
        return new DidChangeWatchedFilesRegistrationOptions
        {
            Watchers = new Container<OmniSharp.Extensions.LanguageServer.Protocol.Models.FileSystemWatcher>(
                new OmniSharp.Extensions.LanguageServer.Protocol.Models.FileSystemWatcher
                {
                    GlobPattern = "**/*.gs",
                    Kind = WatchKind.Create | WatchKind.Delete,
                },
                new OmniSharp.Extensions.LanguageServer.Protocol.Models.FileSystemWatcher
                {
                    GlobPattern = "**/*.gsproj",
                    Kind = WatchKind.Create | WatchKind.Change | WatchKind.Delete,
                }),
        };
    }

    private void HandleProjectFileChange(string filePath, FileChangeType changeType)
    {
        switch (changeType)
        {
            case FileChangeType.Created:
                this.logger.LogInformation("Project file created: {Path}", filePath);
                var discovered = ProjectDiscovery.DiscoverProject(filePath);
                if (discovered != null)
                {
                    var project = this.workspaceState.AddProject(discovered.ProjectFilePath);
                    foreach (var source in discovered.SourceFiles)
                    {
                        project.AddFileFromDisk(source);
                        this.workspaceState.RegisterFile(source, project);
                    }
                }

                break;

            case FileChangeType.Changed:
                this.logger.LogInformation("Project file changed: {Path}", filePath);
                var existing = this.workspaceState.GetProject(filePath);
                if (existing != null)
                {
                    // Re-scan sources for the project
                    var rediscovered = ProjectDiscovery.DiscoverProject(filePath);
                    if (rediscovered != null)
                    {
                        // Add new files, remove deleted files
                        foreach (var source in rediscovered.SourceFiles)
                        {
                            if (!existing.ContainsFile(source))
                            {
                                existing.AddFileFromDisk(source);
                                this.workspaceState.RegisterFile(source, existing);
                            }
                        }

                        foreach (var oldFile in existing.SourceFiles)
                        {
                            if (!rediscovered.SourceFiles.Contains(oldFile))
                            {
                                existing.RemoveFile(oldFile);
                                this.workspaceState.UnregisterFile(oldFile);
                            }
                        }
                    }
                }

                break;

            case FileChangeType.Deleted:
                this.logger.LogInformation("Project file deleted: {Path}", filePath);
                this.workspaceState.RemoveProject(filePath);
                break;
        }
    }

    private void HandleSourceFileChange(string filePath, FileChangeType changeType)
    {
        switch (changeType)
        {
            case FileChangeType.Created:
                var project = this.FindOwningProject(filePath);
                if (project != null)
                {
                    project.AddFileFromDisk(filePath);
                    this.workspaceState.RegisterFile(filePath, project);
                    this.logger.LogInformation("Source file added to project: {Path}", filePath);
                }

                break;

            case FileChangeType.Deleted:
                var owning = this.workspaceState.GetProjectForFile(filePath);
                if (owning != null)
                {
                    owning.RemoveFile(filePath);
                    this.workspaceState.UnregisterFile(filePath);
                    this.logger.LogInformation("Source file removed from project: {Path}", filePath);
                }

                break;
        }
    }

    private ProjectState FindOwningProject(string filePath)
    {
        // Find which project directory contains this file
        var fileDir = Path.GetDirectoryName(Path.GetFullPath(filePath));
        foreach (var project in this.workspaceState.Projects)
        {
            if (fileDir != null && fileDir.StartsWith(project.ProjectDirectory, StringComparison.OrdinalIgnoreCase))
            {
                return project;
            }
        }

        return this.workspaceState.GetOrCreateImplicitProject();
    }
}
