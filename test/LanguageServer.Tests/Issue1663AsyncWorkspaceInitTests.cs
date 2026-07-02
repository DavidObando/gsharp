// <copyright file="Issue1663AsyncWorkspaceInitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Issue #1663: workspace discovery/parsing must not run inline in the "initialize" request —
/// it should happen in the background after "initialized" so the handshake returns promptly and
/// racing requests degrade gracefully instead of crashing or blocking.
/// </summary>
public class Issue1663AsyncWorkspaceInitTests
{
    [Fact]
    public async Task InitializeAsync_DoesNotSynchronouslyLoadWorkspaceProjects()
    {
        var rootDir = CreateSampleWorkspace();
        try
        {
            var workspace = new WorkspaceState();
            var server = new LspServer(new DocumentContentService(), workspace);

            await server.InitializeAsync(new InitializeParams { RootPath = rootDir });

            // The "initialize" response must return before any project discovery/parsing runs.
            Assert.Empty(workspace.Projects);
        }
        finally
        {
            Directory.Delete(rootDir, recursive: true);
        }
    }

    [Fact]
    public async Task Initialized_LoadsWorkspaceProjectsInBackground()
    {
        var rootDir = CreateSampleWorkspace();
        try
        {
            var workspace = new WorkspaceState();
            var server = new LspServer(new DocumentContentService(), workspace);

            await server.InitializeAsync(new InitializeParams { RootPath = rootDir });
            using var doc = JsonDocument.Parse("{}");
            server.Initialized(doc.RootElement.Clone());

            await WaitForAsync(() => workspace.Projects.Count > 0);

            var project = Assert.Single(workspace.Projects);
            Assert.Equal("Demo", project.AssemblyName);
            var compilation = project.GetCompilation();
            Assert.NotNull(compilation.BoundProgram);
        }
        finally
        {
            Directory.Delete(rootDir, recursive: true);
        }
    }

    [Fact]
    public async Task RequestRacingBackgroundLoad_ReturnsEmptyInsteadOfCrashing()
    {
        var rootDir = CreateSampleWorkspace();
        try
        {
            var workspace = new WorkspaceState();

            // Simulate a request landing before background discovery has registered any files:
            // GetProjectForFile must return null (handled gracefully by callers) rather than throw.
            var project = workspace.GetProjectForFile(Path.Combine(rootDir, "Demo", "Foo.gs"));
            Assert.Null(project);

            WorkspaceInitializer.Initialize(workspace, rootDir);

            var loaded = workspace.GetProjectForFile(Path.Combine(rootDir, "Demo", "Foo.gs"));
            Assert.NotNull(loaded);
        }
        finally
        {
            Directory.Delete(rootDir, recursive: true);
        }
    }

    private static string CreateSampleWorkspace()
    {
        var rootDir = Path.Combine(Path.GetTempPath(), "gsinit_" + Guid.NewGuid().ToString("N"));
        var projDir = Path.Combine(rootDir, "Demo");
        Directory.CreateDirectory(projDir);

        File.WriteAllText(
            Path.Combine(projDir, "Demo.gsproj"),
            "<Project Sdk=\"Gsharp.NET.Sdk\">\n  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>\n</Project>\n");

        File.WriteAllText(Path.Combine(projDir, "Foo.gs"), "func foo() {\n  var x = 1\n}\n");

        return rootDir;
    }

    private static async Task WaitForAsync(Func<bool> condition, int timeoutMs = 10000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
            {
                Assert.Fail("Timed out waiting for background workspace load to complete.");
            }

            await Task.Delay(25);
        }
    }
}
