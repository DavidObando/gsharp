// <copyright file="Issue4850VerbatimSourcesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issues #4850 and #4852: every <c>.cs</c> file a project references is
/// translated, copied verbatim, or reported (never silently rewritten or
/// dropped), and the build-output root <c>out/</c> is never source or an app.
/// </summary>
public sealed class Issue4850VerbatimSourcesTests : IDisposable
{
    private readonly string root;

    public Issue4850VerbatimSourcesTests()
    {
        this.root = Path.Combine(Path.GetTempPath(), "cs2gs-4850-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(this.root, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    [Fact]
    public void DataAndForeignCompileSources_AreVerbatim_AndCompiledSourcesAreNot()
    {
        this.WriteRepository();

        ISet<string> verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory());

        Assert.Equal(
            new[]
            {
                "Tests/Fixtures/Data.cs",
                "Tests/Fixtures/Nested/Deep.cs",
                "foreign/ThisAssembly.cs",
            },
            verbatim.OrderBy(path => path, StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public void Prepare_CopiesVerbatimSources_AndOrphanStepDoesNotTranslateThem()
    {
        this.WriteRepository();
        string destination = Path.Combine(Path.GetTempPath(), "cs2gs-4850-out-" + Guid.NewGuid().ToString("N"));
        try
        {
            IReadOnlyList<string> files = RepositoryMirror.Prepare(this.root, destination);
            IReadOnlyList<string> failures = RepositoryOrphanSourceTranslator.TranslateMissing(
                this.root, destination, files);

            Assert.Empty(failures);
            Assert.Equal(
                File.ReadAllText(Path.Combine(this.root, "foreign", "ThisAssembly.cs")),
                File.ReadAllText(Path.Combine(destination, "foreign", "ThisAssembly.cs")));
            Assert.True(File.Exists(Path.Combine(destination, "Tests", "Fixtures", "Nested", "Deep.cs")));
            Assert.False(File.Exists(Path.Combine(destination, "foreign", "ThisAssembly.gs")));
            Assert.False(File.Exists(Path.Combine(destination, "Tests", "Fixtures", "Data.gs")));

            // Compiled sources are still translated, never copied.
            Assert.False(File.Exists(Path.Combine(destination, "Tests", "Program.cs")));
            Assert.True(File.Exists(Path.Combine(destination, "Tests", "Program.gs")));
        }
        finally
        {
            if (Directory.Exists(destination))
            {
                Directory.Delete(destination, recursive: true);
            }
        }
    }

    [Fact]
    public void ValidateCompleted_ExpectsVerbatimCopy_AndRejectsItsMissingTwin()
    {
        this.WriteRepository();
        string destination = Path.Combine(Path.GetTempPath(), "cs2gs-4850-out-" + Guid.NewGuid().ToString("N"));
        try
        {
            IReadOnlyList<string> files = RepositoryMirror.Prepare(this.root, destination);
            RepositoryOrphanSourceTranslator.TranslateMissing(this.root, destination, files);
            var additional = new[]
                {
                    "Tests/Tests.gsproj",
                    "foreign/foreign.gsproj",
                    new DirectoryInfo(this.root).Name + ".slnx",
                }
                .Select(path => path.Replace('/', Path.DirectorySeparatorChar))
                .ToArray();
            foreach (string path in additional)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(destination, path)));
                File.WriteAllText(Path.Combine(destination, path), "<Project />");
            }

            RepositoryMirror.ValidateCompleted(this.root, destination, files, additional);

            File.Delete(Path.Combine(destination, "foreign", "ThisAssembly.cs"));
            InvalidOperationException ex = Assert.Throws<InvalidOperationException>(
                () => RepositoryMirror.ValidateCompleted(this.root, destination, files, additional));
            Assert.Contains("ThisAssembly.cs", ex.Message);
        }
        finally
        {
            if (Directory.Exists(destination))
            {
                Directory.Delete(destination, recursive: true);
            }
        }
    }

    [Fact]
    public void SourceCompiledByTranslatedProjectAndReferencedAsData_IsBothTranslatedAndCopied()
    {
        this.Write("a/a.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><Content Include=\"Shared.cs\" /></ItemGroup></Project>");
        this.Write("a/Shared.cs", "namespace N { public static class S { public static int V = 1; } }");

        ISet<string> verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory());

        Assert.Equal(new[] { "a/Shared.cs" }, verbatim.ToArray());
    }

    [Fact]
    public void UnresolvableIncludeThatCouldNameCSharp_IsReported()
    {
        this.Write("a/a.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><None Include=\"$(SomeDir)/**/*.cs\" /></ItemGroup></Project>");
        this.Write("a/X.cs", "class X {}");
        var warnings = new List<string>();

        ISet<string> verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory(), warnings);

        Assert.Empty(verbatim);
        Assert.Contains("a/a.csproj", Assert.Single(warnings));
        Assert.Contains("$(SomeDir)/**/*.cs", warnings[0]);
    }

    [Fact]
    public void OutDirectory_IsNeverInventoriedDiscoveredOrMirrored()
    {
        this.Write("src/App/App.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />");
        this.Write("src/App/Program.cs", "class P {}");
        this.Write("out/scratch/ildump/ildump.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />");
        this.Write("out/scratch/ildump/Program.cs", "class Q {}");
        this.Write("out/obj/App/Debug/AssemblyAttributes.cs", "class R {}");

        IReadOnlyList<string> inventory = RepositoryFileInventory.Enumerate(this.root);
        IReadOnlyList<CorpusApp> apps = RepositoryDiscovery.Discover(this.root);

        Assert.DoesNotContain(inventory, path => path.StartsWith("out/", StringComparison.Ordinal));
        Assert.Equal(new[] { "src/App/App.csproj" }, apps.Select(app => app.RelativeProjectPath.Replace('\\', '/')).ToArray());
    }

    [Fact]
    public void NestedDirectoryNamedOut_IsStillSource()
    {
        this.Write("src/out/Keep.cs", "class K {}");
        this.Write("src/App/App.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />");

        Assert.Contains("src/out/Keep.cs", RepositoryFileInventory.Enumerate(this.root));
    }

    private IReadOnlyList<string> Inventory() => RepositoryFileInventory.Enumerate(this.root);

    private void WriteRepository()
    {
        this.Write(
            "Tests/Tests.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>" +
            "<Compile Remove=\"Fixtures\\**\\*.cs\" />" +
            "<None Include=\"Fixtures\\**\\*\" CopyToOutputDirectory=\"PreserveNewest\" />" +
            "</ItemGroup></Project>");
        this.Write("Tests/Program.cs", "namespace T { public static class Program { public static int Main() => 0; } }");
        this.Write("Tests/Fixtures/Data.cs", "namespace F { public class Data { } }");
        this.Write("Tests/Fixtures/Nested/Deep.cs", "namespace F { public class Deep { } }");
        this.Write(
            "foreign/foreign.gsproj",
            "<Project Sdk=\"Gsharp.NET.Sdk\"><ItemGroup><Compile Include=\"ThisAssembly.cs\" /></ItemGroup></Project>");
        this.Write("foreign/ThisAssembly.cs", "namespace G { internal static class ThisAssembly { } }");
    }

    private void Write(string relativePath, string content)
    {
        string path = Path.Combine(this.root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllText(path, content);
    }
}
