// <copyright file="ProjectDiscoveryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import System
import System.IO
import System.Linq
import Xunit

open class ProjectDiscoveryTests {
    @Fact
    func DiscoverProjects_FindsGsprojFiles() {
        // Use the real samples directory
        let samplesDir string? = FindSamplesDir()
        if samplesDir == nil {
            return // Skip if not running from expected location

        }
        let projects = ProjectDiscovery.DiscoverProjects(samplesDir)
        Assert.NotEmpty(projects)
        Assert.All(projects, (p DiscoveredProject) -> Assert.EndsWith(".gsproj", p.ProjectFilePath))
    }

    @Fact
    func DiscoverProjects_ReturnsEmptyForNonexistentDir() {
        let projects = ProjectDiscovery.DiscoverProjects("/nonexistent/path")
        Assert.Empty(projects)
    }

    @Fact
    func DiscoverProjects_ReturnsEmptyForNullDir() {
        let projects = ProjectDiscovery.DiscoverProjects(nil)
        Assert.Empty(projects)
    }

    @Fact
    func DiscoverProject_FindsSourceFiles() {
        let samplesDir string? = FindSamplesDir()
        if samplesDir == nil {
            return
        }
        let multiFilePath = Path.Combine(samplesDir, "MultiFile", "MultiFile.gsproj")
        if !File.Exists(multiFilePath) {
            return
        }
        let project DiscoveredProject? = ProjectDiscovery.DiscoverProject(multiFilePath)
        Assert.NotNull(project)
        Assert.True(
            project!!.SourceFiles.Count >= 3,
            "Expected at least 3 .gs files, found ${project!!.SourceFiles.Count}"
        )
        Assert.All(project!!.SourceFiles, (f string) -> Assert.EndsWith(".gs", f))
    }

    @Fact
    func DiscoverProject_ExcludesBinObj() {
        let samplesDir string? = FindSamplesDir()
        if samplesDir == nil {
            return
        }
        let multiFilePath = Path.Combine(samplesDir, "MultiFile", "MultiFile.gsproj")
        if !File.Exists(multiFilePath) {
            return
        }
        let project DiscoveredProject? = ProjectDiscovery.DiscoverProject(multiFilePath)
        Assert.NotNull(project)
        Assert.DoesNotContain(project!!.SourceFiles, (f string) -> f.Contains("/bin/") || f.Contains("/obj/"))
    }

    @Fact
    func DiscoverProject_FindsProjectReferences() {
        let samplesDir string? = FindSamplesDir()
        if samplesDir == nil {
            return
        }
        let appPath = Path.Combine(samplesDir, "ProjectRef", "App", "App.gsproj")
        if !File.Exists(appPath) {
            return
        }
        let project DiscoveredProject? = ProjectDiscovery.DiscoverProject(appPath)
        Assert.NotNull(project)
        Assert.Single(project!!.ProjectReferences)
        Assert.Contains("Lib.gsproj", project!!.ProjectReferences[0])
    }

    @Fact
    func DiscoverProject_ReturnsNullForMissingFile() {
        let project DiscoveredProject? = ProjectDiscovery.DiscoverProject("/nonexistent/project.gsproj")
        Assert.Null(project)
    }

    @Fact
    func DiscoverProject_ReturnsEmptyReferencesWhenNoRspExists() {
        let tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName())
        try {
            Directory.CreateDirectory(tempDir)
            let projPath = Path.Combine(tempDir, "Sample.gsproj")
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>")
            let project DiscoveredProject? = ProjectDiscovery.DiscoverProject(projPath)
            Assert.NotNull(project)
            Assert.Empty(project!!.References)
            Assert.Null(project!!.ReferenceSourcePath)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }

    @Fact
    func DiscoverProject_ReadsReferencesFromResponseFile() {
        let tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName())
        try {
            let rspDir = Path.Combine(tempDir, "obj", "Debug", "net10.0")
            Directory.CreateDirectory(rspDir)
            let projPath = Path.Combine(tempDir, "Sample.gsproj")
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>")
            let rspPath = Path.Combine(rspDir, "Sample.rsp")
            let fakeRefA = Path.Combine(tempDir, "PackageA.dll")
            let fakeRefB = Path.Combine(tempDir, "PackageB.dll")
            File.WriteAllLines(
                rspPath,
                []string{
                    "/out:obj/Debug/net10.0/Sample.dll",
                    "/target:exe",
                    "/r:" + fakeRefA,
                    "/reference:" + fakeRefB,
                    "/nowarn:NU5131"
                }
            )
            let project DiscoveredProject? = ProjectDiscovery.DiscoverProject(projPath)
            Assert.NotNull(project)
            Assert.Equal(Path.GetFullPath(rspPath), project!!.ReferenceSourcePath)
            Assert.Equal(2, project!!.References.Count)
            Assert.Contains(fakeRefA, project!!.References)
            Assert.Contains(fakeRefB, project!!.References)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }

    @Fact
    func DiscoverProject_UsesAssemblyNameWhenSet() {
        let tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName())
        try {
            let rspDir = Path.Combine(tempDir, "obj", "Debug", "net10.0")
            Directory.CreateDirectory(rspDir)
            let projPath = Path.Combine(tempDir, "Sample.gsproj")
            File.WriteAllText(
                projPath,
                "<Project Sdk=\"Gsharp.NET.Sdk\"><PropertyGroup><AssemblyName>Custom.Asm</AssemblyName></PropertyGroup></Project>"
            )
            // .rsp is named after AssemblyName, not the project file
            let rspPath = Path.Combine(rspDir, "Custom.Asm.rsp")
            let fakeRef = Path.Combine(tempDir, "PackageA.dll")
            File.WriteAllLines(rspPath, []string{"/r:" + fakeRef})
            // A second rsp matching the project name should NOT be picked
            File.WriteAllLines(Path.Combine(rspDir, "Sample.rsp"), []string{"/r:should-not-be-picked.dll"})
            let project DiscoveredProject? = ProjectDiscovery.DiscoverProject(projPath)
            Assert.NotNull(project)
            Assert.Equal(Path.GetFullPath(rspPath), project!!.ReferenceSourcePath)
            Assert.Single(project!!.References)
            Assert.Equal(fakeRef, project!!.References[0])
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }

    @Fact
    func DiscoverProject_PrefersMostRecentResponseFile() {
        let tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName())
        try {
            Directory.CreateDirectory(tempDir)
            let projPath = Path.Combine(tempDir, "Sample.gsproj")
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>")
            let debugDir = Path.Combine(tempDir, "obj", "Debug", "net10.0")
            let releaseDir = Path.Combine(tempDir, "obj", "Release", "net10.0")
            Directory.CreateDirectory(debugDir)
            Directory.CreateDirectory(releaseDir)
            let debugRsp = Path.Combine(debugDir, "Sample.rsp")
            let releaseRsp = Path.Combine(releaseDir, "Sample.rsp")
            File.WriteAllLines(debugRsp, []string{"/r:debug.dll"})
            File.WriteAllLines(releaseRsp, []string{"/r:release.dll"})
            // Release was written later
            File.SetLastWriteTimeUtc(debugRsp, DateTime.UtcNow.AddMinutes(-5))
            File.SetLastWriteTimeUtc(releaseRsp, DateTime.UtcNow)
            let project DiscoveredProject? = ProjectDiscovery.DiscoverProject(projPath)
            Assert.NotNull(project)
            Assert.Equal(Path.GetFullPath(releaseRsp), project!!.ReferenceSourcePath)
            Assert.Single(project!!.References)
            Assert.Equal("release.dll", project!!.References[0])
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }

    @Fact
    func ParseReferencesFromResponseFile_HandlesQuotedAndDashStyleSwitches() {
        let tempPath = Path.GetTempFileName()
        try {
            File.WriteAllLines(
                tempPath,
                []string{
                    "/out:foo.dll",
                    "/r:\"/path with spaces/A.dll\"",
                    "-reference:/path/B.dll",
                    "/nowarn:NU5131",
                    string.Empty,
                    "not-a-switch"
                }
            )
            let refs = ProjectDiscovery.ParseReferencesFromResponseFile(tempPath)
            Assert.Equal(2, refs.Count)
            Assert.Equal("/path with spaces/A.dll", refs[0])
            Assert.Equal("/path/B.dll", refs[1])
        } finally {
            File.Delete(tempPath)
        }
    }

    @Fact
    func ParseReferencesFromResponseFile_HandlesOuterQuotedLines() {
        // On Windows, MSBuild wraps the entire switch in quotes when the path
        // contains spaces (e.g. "C:\Program Files\...").
        let tempPath = Path.GetTempFileName()
        try {
            File.WriteAllLines(
                tempPath,
                []string{
                    "/out:foo.dll",
                    "\"/r:/path with spaces/A.dll\"",
                    "\"-reference:/path with spaces/B.dll\"",
                    "/r:C/plain/path/C.dll"
                }
            )
            let refs = ProjectDiscovery.ParseReferencesFromResponseFile(tempPath)
            Assert.Equal(3, refs.Count)
            Assert.Equal("/path with spaces/A.dll", refs[0])
            Assert.Equal("/path with spaces/B.dll", refs[1])
            Assert.Equal("C/plain/path/C.dll", refs[2])
        } finally {
            File.Delete(tempPath)
        }
    }

    @Fact
    func DiscoverProject_IncludesGeneratedGsgenParts_ExcludesOtherObjFiles() {
        // ADR-0145 §G: generator output lands under obj/.../gsgen/*.g.gs and is injected
        // into @(Compile). The LS must surface those parts (so generated members resolve)
        // while still excluding every other obj/ artifact.
        let tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName())
        try {
            Directory.CreateDirectory(tempDir)
            let projPath = Path.Combine(tempDir, "Sample.gsproj")
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>")
            // A normal user source file at the project root.
            let userSource = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(userSource, "let x = 1\n")
            let gsgenDir = Path.Combine(tempDir, "obj", "Debug", "net10.0", "gsgen")
            Directory.CreateDirectory(gsgenDir)
            let generated = Path.Combine(gsgenDir, "Foo.g.gs")
            File.WriteAllText(generated, "partial class Foo {}\n")
            // Non-gsgen obj artifacts that must stay excluded: a C# file, a generated C#
            // file, and a plain .gs file that is NOT under a gsgen segment.
            let objDir = Path.Combine(tempDir, "obj", "Debug", "net10.0")
            File.WriteAllText(Path.Combine(objDir, "Foo.cs"), "class Foo {}\n")
            File.WriteAllText(Path.Combine(objDir, "other.g.cs"), "class Other {}\n")
            File.WriteAllText(Path.Combine(objDir, "Stray.gs"), "let y = 2\n")
            let project DiscoveredProject? = ProjectDiscovery.DiscoverProject(projPath)
            Assert.NotNull(project)
            Assert.Contains(
                project!!.SourceFiles,
                (f string) -> string.Equals(f, Path.GetFullPath(userSource), StringComparison.OrdinalIgnoreCase)
            )
            Assert.Contains(
                project!!.SourceFiles,
                (f string) -> string.Equals(f, Path.GetFullPath(generated), StringComparison.OrdinalIgnoreCase)
            )
            // Nothing else from obj/ is included.
            Assert.DoesNotContain(
                project!!.SourceFiles,
                (f string) -> f.EndsWith("Foo.cs", StringComparison.OrdinalIgnoreCase)
            )
            Assert.DoesNotContain(
                project!!.SourceFiles,
                (f string) -> f.EndsWith("other.g.cs", StringComparison.OrdinalIgnoreCase)
            )
            Assert.DoesNotContain(
                project!!.SourceFiles,
                (f string) -> f.EndsWith("Stray.gs", StringComparison.OrdinalIgnoreCase)
            )
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }

    @Fact
    func IsGeneratedSourcePath_MatchesOnlyGsgenGsParts() {
        Assert.True(
            ProjectDiscovery.IsGeneratedSourcePath(Path.Combine("obj", "Debug", "net10.0", "gsgen", "Foo.g.gs"))
        )
        Assert.False(ProjectDiscovery.IsGeneratedSourcePath(Path.Combine("obj", "Debug", "net10.0", "Foo.g.gs")))
        Assert.False(
            ProjectDiscovery.IsGeneratedSourcePath(Path.Combine("obj", "Debug", "net10.0", "gsgen", "Foo.g.cs"))
        )
        Assert.False(ProjectDiscovery.IsGeneratedSourcePath(Path.Combine("src", "gsgen", "Program.gs")))
        Assert.False(ProjectDiscovery.IsGeneratedSourcePath(nil))
    }

    shared {
        private func FindSamplesDir() string? {
            var dir string? = Directory.GetCurrentDirectory()
            while dir != nil {
                let samples = Path.Combine(dir, "samples")
                if Directory.Exists(samples) && Directory.GetFiles(samples, "*.gsproj", SearchOption.AllDirectories)
                    .Any() {
                    return samples
                }
                dir = Path.GetDirectoryName(dir)
            }
            return nil
        }
    }
}
