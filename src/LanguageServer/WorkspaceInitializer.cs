// <copyright file="WorkspaceInitializer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using OmniSharp.Extensions.LanguageServer.Protocol.Client.Capabilities;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using OmniSharp.Extensions.LanguageServer.Protocol.Server;
using OmniSharp.Extensions.LanguageServer.Protocol.Workspace;

namespace GSharp.LanguageServer;

/// <summary>
/// Handles workspace initialization by discovering projects and loading source files.
/// </summary>
public class WorkspaceInitializer : IOnLanguageServerInitialize
{
    private readonly ILanguageServerFacade router;
    private readonly WorkspaceState workspaceState;
    private readonly ILogger<WorkspaceInitializer> logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="WorkspaceInitializer"/> class.
    /// </summary>
    /// <param name="router"><see cref="ILanguageServerFacade"/> for LSP.</param>
    /// <param name="workspaceState"><see cref="WorkspaceState"/> instance.</param>
    /// <param name="logger">Logger instance.</param>
    public WorkspaceInitializer(ILanguageServerFacade router, WorkspaceState workspaceState, ILogger<WorkspaceInitializer> logger)
    {
        this.router = router;
        this.workspaceState = workspaceState;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public Task OnInitialize(ILanguageServer server, InitializeParams request, CancellationToken cancellationToken)
    {
        var rootPath = request.RootPath ?? request.RootUri?.GetFileSystemPath();
        if (string.IsNullOrEmpty(rootPath))
        {
            this.logger.LogWarning("No workspace root provided; multi-file support disabled.");
            return Task.CompletedTask;
        }

        this.workspaceState.RootPath = rootPath;
        this.LoadWorkspace(rootPath);
        return Task.CompletedTask;
    }

    private void LoadWorkspace(string rootPath)
    {
        var discovered = ProjectDiscovery.DiscoverProjects(rootPath);
        this.logger.LogInformation("Discovered {Count} project(s) in {Root}", discovered.Count, rootPath);

        foreach (var disc in discovered)
        {
            var project = this.workspaceState.AddProject(disc.ProjectFilePath);
            project.ProjectReferences = disc.ProjectReferences;
            foreach (var sourceFile in disc.SourceFiles)
            {
                project.AddFileFromDisk(sourceFile);
                this.workspaceState.RegisterFile(sourceFile, project);
            }

            this.logger.LogInformation("Loaded project {Project} with {FileCount} file(s)", disc.ProjectFilePath, disc.SourceFiles.Count);
        }

        if (discovered.Count == 0)
        {
            this.logger.LogInformation("No .gsproj found; using implicit project for workspace root.");
        }
    }
}
