// <copyright file="FindOwningProjectTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Server
import System
import System.IO
import System.Reflection
import Xunit

// Fixes #1661 (bonus bug): FindOwningProject used a plain StartsWith prefix check, so a
// project at "/repo/Lib" would incorrectly claim files under the unrelated sibling
// directory "/repo/Lib2". These tests exercise the private FindOwningProject method via
// reflection since it has no public seam of its own.
open class FindOwningProjectTests {
    @Fact
    func FindOwningProject_DoesNotMatchSiblingDirectoryWithSharedPrefix() {
        let root = Path.Combine(Path.GetTempPath(), "gsharp-fop-" + Guid.NewGuid().ToString("N"))
        let libDir = Path.Combine(root, "Lib")
        let lib2Dir = Path.Combine(root, "Lib2")
        Directory.CreateDirectory(libDir)
        Directory.CreateDirectory(lib2Dir)
        try {
            let workspaceState = WorkspaceState()
            workspaceState.AddProject(Path.Combine(libDir, "Lib.gsproj"))
            let server = LspServer(DocumentContentService(), workspaceState)
            let found ProjectState? = InvokeFindOwningProject(server, Path.Combine(lib2Dir, "foo.gs"))
            // Lib2 must not be claimed by the Lib project. With only one project registered,
            // GetOrCreateImplicitProject falls back to null (see WorkspaceState.projects.IsEmpty
            // guard), so the fix surfaces as a null result rather than the unrelated Lib project.
            Assert.Null(found)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func FindOwningProject_MatchesFileDirectlyUnderProjectDirectory() {
        let root = Path.Combine(Path.GetTempPath(), "gsharp-fop-" + Guid.NewGuid().ToString("N"))
        let libDir = Path.Combine(root, "Lib")
        Directory.CreateDirectory(libDir)
        try {
            let workspaceState = WorkspaceState()
            let project = workspaceState.AddProject(Path.Combine(libDir, "Lib.gsproj"))
            let server = LspServer(DocumentContentService(), workspaceState)
            let found ProjectState? = InvokeFindOwningProject(server, Path.Combine(libDir, "foo.gs"))
            Assert.Same(project, found)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func FindOwningProject_MatchesFileInSubdirectoryOfProjectDirectory() {
        let root = Path.Combine(Path.GetTempPath(), "gsharp-fop-" + Guid.NewGuid().ToString("N"))
        let libDir = Path.Combine(root, "Lib")
        let subDir = Path.Combine(libDir, "sub")
        Directory.CreateDirectory(subDir)
        try {
            let workspaceState = WorkspaceState()
            let project = workspaceState.AddProject(Path.Combine(libDir, "Lib.gsproj"))
            let server = LspServer(DocumentContentService(), workspaceState)
            let found ProjectState? = InvokeFindOwningProject(server, Path.Combine(subDir, "foo.gs"))
            Assert.Same(project, found)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    shared {
        private func InvokeFindOwningProject(server LspServer, filePath string) ProjectState? {
            let method MethodInfo? = typeof(LspServer).GetMethod(
                "FindOwningProject",
                BindingFlags.NonPublic | BindingFlags.Instance
            )
            return cast[ProjectState](method!!.Invoke(server, []object{filePath}))
        }
    }
}
