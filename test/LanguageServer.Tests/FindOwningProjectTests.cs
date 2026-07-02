// <copyright file="FindOwningProjectTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

// Fixes #1661 (bonus bug): FindOwningProject used a plain StartsWith prefix check, so a
// project at "/repo/Lib" would incorrectly claim files under the unrelated sibling
// directory "/repo/Lib2". These tests exercise the private FindOwningProject method via
// reflection since it has no public seam of its own.
public class FindOwningProjectTests
{
    private static ProjectState InvokeFindOwningProject(LspServer server, string filePath)
    {
        var method = typeof(LspServer).GetMethod("FindOwningProject", BindingFlags.NonPublic | BindingFlags.Instance);
        return (ProjectState)method.Invoke(server, new object[] { filePath });
    }

    [Fact]
    public void FindOwningProject_DoesNotMatchSiblingDirectoryWithSharedPrefix()
    {
        var root = Path.Combine(Path.GetTempPath(), "gsharp-fop-" + Guid.NewGuid().ToString("N"));
        var libDir = Path.Combine(root, "Lib");
        var lib2Dir = Path.Combine(root, "Lib2");
        Directory.CreateDirectory(libDir);
        Directory.CreateDirectory(lib2Dir);

        try
        {
            var workspaceState = new WorkspaceState();
            workspaceState.AddProject(Path.Combine(libDir, "Lib.gsproj"));

            var server = new LspServer(new DocumentContentService(), workspaceState);

            var found = InvokeFindOwningProject(server, Path.Combine(lib2Dir, "foo.gs"));

            // Lib2 must not be claimed by the Lib project. With only one project registered,
            // GetOrCreateImplicitProject falls back to null (see WorkspaceState.projects.IsEmpty
            // guard), so the fix surfaces as a null result rather than the unrelated Lib project.
            Assert.Null(found);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void FindOwningProject_MatchesFileDirectlyUnderProjectDirectory()
    {
        var root = Path.Combine(Path.GetTempPath(), "gsharp-fop-" + Guid.NewGuid().ToString("N"));
        var libDir = Path.Combine(root, "Lib");
        Directory.CreateDirectory(libDir);

        try
        {
            var workspaceState = new WorkspaceState();
            var project = workspaceState.AddProject(Path.Combine(libDir, "Lib.gsproj"));

            var server = new LspServer(new DocumentContentService(), workspaceState);

            var found = InvokeFindOwningProject(server, Path.Combine(libDir, "foo.gs"));

            Assert.Same(project, found);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void FindOwningProject_MatchesFileInSubdirectoryOfProjectDirectory()
    {
        var root = Path.Combine(Path.GetTempPath(), "gsharp-fop-" + Guid.NewGuid().ToString("N"));
        var libDir = Path.Combine(root, "Lib");
        var subDir = Path.Combine(libDir, "sub");
        Directory.CreateDirectory(subDir);

        try
        {
            var workspaceState = new WorkspaceState();
            var project = workspaceState.AddProject(Path.Combine(libDir, "Lib.gsproj"));

            var server = new LspServer(new DocumentContentService(), workspaceState);

            var found = InvokeFindOwningProject(server, Path.Combine(subDir, "foo.gs"));

            Assert.Same(project, found);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
