// <copyright file="ProjectDiscoveryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class ProjectDiscoveryTests
{
    [Fact]
    public void DiscoverProjects_FindsGsprojFiles()
    {
        // Use the real samples directory
        var samplesDir = FindSamplesDir();
        if (samplesDir == null)
        {
            return; // Skip if not running from expected location
        }

        var projects = ProjectDiscovery.DiscoverProjects(samplesDir);

        Assert.NotEmpty(projects);
        Assert.All(projects, p => Assert.EndsWith(".gsproj", p.ProjectFilePath));
    }

    [Fact]
    public void DiscoverProjects_ReturnsEmptyForNonexistentDir()
    {
        var projects = ProjectDiscovery.DiscoverProjects("/nonexistent/path");

        Assert.Empty(projects);
    }

    [Fact]
    public void DiscoverProjects_ReturnsEmptyForNullDir()
    {
        var projects = ProjectDiscovery.DiscoverProjects(null);

        Assert.Empty(projects);
    }

    [Fact]
    public void DiscoverProject_FindsSourceFiles()
    {
        var samplesDir = FindSamplesDir();
        if (samplesDir == null)
        {
            return;
        }

        var multiFilePath = Path.Combine(samplesDir, "MultiFile", "MultiFile.gsproj");
        if (!File.Exists(multiFilePath))
        {
            return;
        }

        var project = ProjectDiscovery.DiscoverProject(multiFilePath);

        Assert.NotNull(project);
        Assert.True(project.SourceFiles.Count >= 3, $"Expected at least 3 .gs files, found {project.SourceFiles.Count}");
        Assert.All(project.SourceFiles, f => Assert.EndsWith(".gs", f));
    }

    [Fact]
    public void DiscoverProject_ExcludesBinObj()
    {
        var samplesDir = FindSamplesDir();
        if (samplesDir == null)
        {
            return;
        }

        var multiFilePath = Path.Combine(samplesDir, "MultiFile", "MultiFile.gsproj");
        if (!File.Exists(multiFilePath))
        {
            return;
        }

        var project = ProjectDiscovery.DiscoverProject(multiFilePath);

        Assert.NotNull(project);
        Assert.DoesNotContain(project.SourceFiles, f => f.Contains("/bin/") || f.Contains("/obj/"));
    }

    [Fact]
    public void DiscoverProject_FindsProjectReferences()
    {
        var samplesDir = FindSamplesDir();
        if (samplesDir == null)
        {
            return;
        }

        var appPath = Path.Combine(samplesDir, "ProjectRef", "App", "App.gsproj");
        if (!File.Exists(appPath))
        {
            return;
        }

        var project = ProjectDiscovery.DiscoverProject(appPath);

        Assert.NotNull(project);
        Assert.Single(project.ProjectReferences);
        Assert.Contains("Lib.gsproj", project.ProjectReferences[0]);
    }

    [Fact]
    public void DiscoverProject_ReturnsNullForMissingFile()
    {
        var project = ProjectDiscovery.DiscoverProject("/nonexistent/project.gsproj");

        Assert.Null(project);
    }

    [Fact]
    public void DiscoverProject_ReturnsEmptyReferencesWhenNoRspExists()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        try
        {
            Directory.CreateDirectory(tempDir);
            var projPath = Path.Combine(tempDir, "Sample.gsproj");
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>");

            var project = ProjectDiscovery.DiscoverProject(projPath);

            Assert.NotNull(project);
            Assert.Empty(project.References);
            Assert.Null(project.ReferenceSourcePath);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); }
            catch (IOException) { }
        }
    }

    [Fact]
    public void DiscoverProject_ReadsReferencesFromResponseFile()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        try
        {
            var rspDir = Path.Combine(tempDir, "obj", "Debug", "net10.0");
            Directory.CreateDirectory(rspDir);
            var projPath = Path.Combine(tempDir, "Sample.gsproj");
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>");

            var rspPath = Path.Combine(rspDir, "Sample.rsp");
            var fakeRefA = Path.Combine(tempDir, "PackageA.dll");
            var fakeRefB = Path.Combine(tempDir, "PackageB.dll");
            File.WriteAllLines(rspPath, new[]
            {
                "/out:obj/Debug/net10.0/Sample.dll",
                "/target:exe",
                "/r:" + fakeRefA,
                "/reference:" + fakeRefB,
                "/nowarn:NU5131",
            });

            var project = ProjectDiscovery.DiscoverProject(projPath);

            Assert.NotNull(project);
            Assert.Equal(Path.GetFullPath(rspPath), project.ReferenceSourcePath);
            Assert.Equal(2, project.References.Count);
            Assert.Contains(fakeRefA, project.References);
            Assert.Contains(fakeRefB, project.References);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); }
            catch (IOException) { }
        }
    }

    [Fact]
    public void DiscoverProject_UsesAssemblyNameWhenSet()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        try
        {
            var rspDir = Path.Combine(tempDir, "obj", "Debug", "net10.0");
            Directory.CreateDirectory(rspDir);
            var projPath = Path.Combine(tempDir, "Sample.gsproj");
            File.WriteAllText(projPath,
                "<Project Sdk=\"Gsharp.NET.Sdk\"><PropertyGroup><AssemblyName>Custom.Asm</AssemblyName></PropertyGroup></Project>");

            // .rsp is named after AssemblyName, not the project file
            var rspPath = Path.Combine(rspDir, "Custom.Asm.rsp");
            var fakeRef = Path.Combine(tempDir, "PackageA.dll");
            File.WriteAllLines(rspPath, new[] { "/r:" + fakeRef });

            // A second rsp matching the project name should NOT be picked
            File.WriteAllLines(Path.Combine(rspDir, "Sample.rsp"), new[] { "/r:should-not-be-picked.dll" });

            var project = ProjectDiscovery.DiscoverProject(projPath);

            Assert.NotNull(project);
            Assert.Equal(Path.GetFullPath(rspPath), project.ReferenceSourcePath);
            Assert.Single(project.References);
            Assert.Equal(fakeRef, project.References[0]);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); }
            catch (IOException) { }
        }
    }

    [Fact]
    public void DiscoverProject_PrefersMostRecentResponseFile()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        try
        {
            Directory.CreateDirectory(tempDir);
            var projPath = Path.Combine(tempDir, "Sample.gsproj");
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>");

            var debugDir = Path.Combine(tempDir, "obj", "Debug", "net10.0");
            var releaseDir = Path.Combine(tempDir, "obj", "Release", "net10.0");
            Directory.CreateDirectory(debugDir);
            Directory.CreateDirectory(releaseDir);

            var debugRsp = Path.Combine(debugDir, "Sample.rsp");
            var releaseRsp = Path.Combine(releaseDir, "Sample.rsp");
            File.WriteAllLines(debugRsp, new[] { "/r:debug.dll" });
            File.WriteAllLines(releaseRsp, new[] { "/r:release.dll" });

            // Release was written later
            File.SetLastWriteTimeUtc(debugRsp, DateTime.UtcNow.AddMinutes(-5));
            File.SetLastWriteTimeUtc(releaseRsp, DateTime.UtcNow);

            var project = ProjectDiscovery.DiscoverProject(projPath);

            Assert.NotNull(project);
            Assert.Equal(Path.GetFullPath(releaseRsp), project.ReferenceSourcePath);
            Assert.Single(project.References);
            Assert.Equal("release.dll", project.References[0]);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); }
            catch (IOException) { }
        }
    }

    [Fact]
    public void ParseReferencesFromResponseFile_HandlesQuotedAndDashStyleSwitches()
    {
        var tempPath = Path.GetTempFileName();
        try
        {
            File.WriteAllLines(tempPath, new[]
            {
                "/out:foo.dll",
                "/r:\"/path with spaces/A.dll\"",
                "-reference:/path/B.dll",
                "/nowarn:NU5131",
                string.Empty,
                "not-a-switch",
            });

            var refs = ProjectDiscovery.ParseReferencesFromResponseFile(tempPath);

            Assert.Equal(2, refs.Count);
            Assert.Equal("/path with spaces/A.dll", refs[0]);
            Assert.Equal("/path/B.dll", refs[1]);
        }
        finally
        {
            File.Delete(tempPath);
        }
    }

    [Fact]
    public void ParseReferencesFromResponseFile_HandlesOuterQuotedLines()
    {
        // On Windows, MSBuild wraps the entire switch in quotes when the path
        // contains spaces (e.g. "C:\Program Files\...").
        var tempPath = Path.GetTempFileName();
        try
        {
            File.WriteAllLines(tempPath, new[]
            {
                "/out:foo.dll",
                "\"/r:/path with spaces/A.dll\"",
                "\"-reference:/path with spaces/B.dll\"",
                "/r:C/plain/path/C.dll",
            });

            var refs = ProjectDiscovery.ParseReferencesFromResponseFile(tempPath);

            Assert.Equal(3, refs.Count);
            Assert.Equal("/path with spaces/A.dll", refs[0]);
            Assert.Equal("/path with spaces/B.dll", refs[1]);
            Assert.Equal("C/plain/path/C.dll", refs[2]);
        }
        finally
        {
            File.Delete(tempPath);
        }
    }

    [Fact]
    public void DiscoverProject_IncludesGeneratedGsgenParts_ExcludesOtherObjFiles()
    {
        // ADR-0145 §G: generator output lands under obj/.../gsgen/*.g.gs and is injected
        // into @(Compile). The LS must surface those parts (so generated members resolve)
        // while still excluding every other obj/ artifact.
        var tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        try
        {
            Directory.CreateDirectory(tempDir);
            var projPath = Path.Combine(tempDir, "Sample.gsproj");
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>");

            // A normal user source file at the project root.
            var userSource = Path.Combine(tempDir, "Program.gs");
            File.WriteAllText(userSource, "let x = 1\n");

            var gsgenDir = Path.Combine(tempDir, "obj", "Debug", "net10.0", "gsgen");
            Directory.CreateDirectory(gsgenDir);
            var generated = Path.Combine(gsgenDir, "Foo.g.gs");
            File.WriteAllText(generated, "partial class Foo {}\n");

            // Non-gsgen obj artifacts that must stay excluded: a C# file, a generated C#
            // file, and a plain .gs file that is NOT under a gsgen segment.
            var objDir = Path.Combine(tempDir, "obj", "Debug", "net10.0");
            File.WriteAllText(Path.Combine(objDir, "Foo.cs"), "class Foo {}\n");
            File.WriteAllText(Path.Combine(objDir, "other.g.cs"), "class Other {}\n");
            File.WriteAllText(Path.Combine(objDir, "Stray.gs"), "let y = 2\n");

            var project = ProjectDiscovery.DiscoverProject(projPath);

            Assert.NotNull(project);
            Assert.Contains(project.SourceFiles, f => string.Equals(f, Path.GetFullPath(userSource), StringComparison.OrdinalIgnoreCase));
            Assert.Contains(project.SourceFiles, f => string.Equals(f, Path.GetFullPath(generated), StringComparison.OrdinalIgnoreCase));

            // Nothing else from obj/ is included.
            Assert.DoesNotContain(project.SourceFiles, f => f.EndsWith("Foo.cs", StringComparison.OrdinalIgnoreCase));
            Assert.DoesNotContain(project.SourceFiles, f => f.EndsWith("other.g.cs", StringComparison.OrdinalIgnoreCase));
            Assert.DoesNotContain(project.SourceFiles, f => f.EndsWith("Stray.gs", StringComparison.OrdinalIgnoreCase));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); }
            catch (IOException) { }
        }
    }

    [Fact]
    public void IsGeneratedSourcePath_MatchesOnlyGsgenGsParts()
    {
        Assert.True(ProjectDiscovery.IsGeneratedSourcePath(Path.Combine("obj", "Debug", "net10.0", "gsgen", "Foo.g.gs")));
        Assert.False(ProjectDiscovery.IsGeneratedSourcePath(Path.Combine("obj", "Debug", "net10.0", "Foo.g.gs")));
        Assert.False(ProjectDiscovery.IsGeneratedSourcePath(Path.Combine("obj", "Debug", "net10.0", "gsgen", "Foo.g.cs")));
        Assert.False(ProjectDiscovery.IsGeneratedSourcePath(Path.Combine("src", "gsgen", "Program.gs")));
        Assert.False(ProjectDiscovery.IsGeneratedSourcePath(null));
    }

    private static string FindSamplesDir()
    {
        var dir = Directory.GetCurrentDirectory();
        while (dir != null)
        {
            var samples = Path.Combine(dir, "samples");
            if (Directory.Exists(samples) && Directory.GetFiles(samples, "*.gsproj", SearchOption.AllDirectories).Any())
            {
                return samples;
            }

            dir = Path.GetDirectoryName(dir);
        }

        return null;
    }
}
