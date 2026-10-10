// <copyright file="Issue4850VerbatimSourcesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
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

    [Fact]
    public void LaterIncludeReAddsWhatAnEarlierRemoveTook_AndLaterRemoveWins()
    {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>" +
            "<None Remove=\"Readded.cs\" /><None Include=\"Readded.cs\" />" +
            "<None Include=\"Removed.cs\" /><None Remove=\"Removed.cs\" />" +
            "</ItemGroup></Project>");
        this.Write("a/Readded.cs", "class A {}");
        this.Write("a/Removed.cs", "class B {}");

        ISet<string> verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory());

        Assert.Equal(new[] { "a/Readded.cs" }, verbatim.ToArray());
    }

    [Fact]
    public void DirectoryAnchors_ResolveRelativeToTheProjectOnce()
    {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>" +
            "<None Include=\"$(MSBuildThisFileDirectory)Data.cs\" />" +
            "<None Include=\"$(MSBuildProjectDirectory)\\Other.cs\" />" +
            "</ItemGroup></Project>");
        this.Write("a/Data.cs", "class A {}");
        this.Write("a/Other.cs", "class B {}");
        var warnings = new List<string>();

        ISet<string> verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory(), warnings);

        Assert.Equal(new[] { "a/Data.cs", "a/Other.cs" }, verbatim.OrderBy(p => p, StringComparer.Ordinal).ToArray());
        Assert.Empty(warnings);
    }

    [Fact]
    public void BackslashSpelledInventory_StillMatches()
    {
        this.Write("a/a.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><None Include=\"Fixtures\\**\\*\" /></ItemGroup></Project>");
        this.Write("a/Fixtures/Data.cs", "class A {}");

        ISet<string> verbatim = RepositoryVerbatimSources.Compute(
            this.root, new[] { "a\\a.csproj", "a\\Fixtures\\Data.cs" });

        Assert.Equal(new[] { "a\\Fixtures\\Data.cs" }, verbatim.ToArray());
    }

    [Fact]
    public void ExcludeOnALaterInclude_DoesNotUnreferenceAnEarlierOne()
    {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>" +
            "<None Include=\"Data.cs\" /><None Include=\"*.cs\" Exclude=\"Data.cs\" />" +
            "</ItemGroup></Project>");
        this.Write("a/Data.cs", "class A {}");
        this.Write("a/Other.cs", "class B {}");

        ISet<string> verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory());

        Assert.Equal(new[] { "a/Data.cs", "a/Other.cs" }, verbatim.OrderBy(p => p, StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public void ConditionalOrTargetRemove_DoesNotClearAReference()
    {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>" +
            "<None Include=\"A.cs\" /><None Remove=\"A.cs\" Condition=\"'false' == 'true'\" />" +
            "<None Include=\"B.cs\" /></ItemGroup>" +
            "<ItemGroup Condition=\"'false' == 'true'\"><None Remove=\"B.cs\" /></ItemGroup>" +
            "<ItemGroup><None Include=\"C.cs\" /></ItemGroup>" +
            "<Target Name=\"T\"><ItemGroup><None Remove=\"C.cs\" /></ItemGroup></Target></Project>");
        this.Write("a/A.cs", "class A {}");
        this.Write("a/B.cs", "class B {}");
        this.Write("a/C.cs", "class C {}");

        ISet<string> verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory());

        Assert.Equal(new[] { "a/A.cs", "a/B.cs", "a/C.cs" }, verbatim.OrderBy(p => p, StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public void CompileItemsOfASharedFileImportedByAGsproj_AreVerbatim()
    {
        this.Write("g/g.gsproj", "<Project Sdk=\"Gsharp.NET.Sdk\"><Import Project=\"..\\shared\\shared.props\" /></Project>");
        this.Write("shared/shared.props", "<Project><ItemGroup><Compile Include=\"Foreign.cs\" /></ItemGroup></Project>");
        this.Write("shared/Foreign.cs", "class F {}");
        this.Write("shared/unrelated.props", "<Project><ItemGroup><Compile Include=\"Own.cs\" /></ItemGroup></Project>");
        this.Write("shared/Own.cs", "class O {}");

        ISet<string> verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory());

        Assert.Equal(new[] { "shared/Foreign.cs" }, verbatim.ToArray());
    }

    [Fact]
    public void CompileItemsOfADirectoryBuildFileOverAGsproj_AreVerbatim()
    {
        this.Write("Directory.Build.targets", "<Project><ItemGroup><Compile Include=\"Foreign.cs\" /></ItemGroup></Project>");
        this.Write("Foreign.cs", "class F {}");
        this.Write("g/g.gsproj", "<Project Sdk=\"Gsharp.NET.Sdk\" />");

        ISet<string> verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory());

        Assert.Equal(new[] { "Foreign.cs" }, verbatim.ToArray());
    }

    [Fact]
    public void SharedFileWithNoGsprojImporter_KeepsItsCompileItemsTranslated()
    {
        this.Write("Directory.Build.targets", "<Project><ItemGroup><Compile Include=\"Own.cs\" /></ItemGroup></Project>");
        this.Write("Own.cs", "class O {}");
        this.Write("a/a.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />");

        Assert.Empty(RepositoryVerbatimSources.Compute(this.root, this.Inventory()));
    }

    [Fact]
    public void DataOnlySourceWithAGsTwin_IsNotACollision()
    {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><Compile Remove=\"Data.cs\" /><None Include=\"Data.cs\" /></ItemGroup></Project>");
        this.Write("a/Data.cs", "class A {}");
        this.Write("a/Data.gs", "package a");
        string destination = Path.Combine(Path.GetTempPath(), "cs2gs-4850-out-" + Guid.NewGuid().ToString("N"));
        try
        {
            RepositoryMirror.Prepare(this.root, destination);

            Assert.Equal("class A {}", File.ReadAllText(Path.Combine(destination, "a", "Data.cs")));
            Assert.Equal("package a", File.ReadAllText(Path.Combine(destination, "a", "Data.gs")));
        }
        finally
        {
            if (Directory.Exists(destination))
            {
                Directory.Delete(destination, recursive: true);
            }
        }
    }

    /// <summary>
    /// A source that is both compiled and referenced as data must not have its
    /// translation silently overwrite a checked-in same-name <c>.gs</c>.
    /// </summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Pipeline_DualOwnedSourceWithCheckedInGsTwin_FailsInsteadOfOverwriting()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        this.Write(
            "source/src/Widget/Widget.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>" +
            "<ItemGroup><None Include=\"Shared.cs\" /></ItemGroup></Project>");
        this.Write("source/src/Widget/Shared.cs", "namespace Widget { public static class Shared { public static int One() => 1; } }");
        this.Write("source/src/Widget/Shared.gs", "package Widget\n\nfunc checkedIn() {}\n");
        string destination = Path.Combine(this.root, "destination");
        var options = new PipelineOptions
        {
            GscPath = compiler,
            SourceRoot = Path.Combine(this.root, "source"),
            OutputRoot = destination,
            ArtifactRoot = Path.Combine(this.root, "runs"),
            OutputLayout = MigrationOutputLayout.Repository,
            Config = "Release",
        };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() });

        RunResult result = await pipeline.RunAsync(RepositoryDiscovery.Discover(Path.Combine(this.root, "source")));

        Assert.False(result.Succeeded);
        Assert.Contains("checkedIn", File.ReadAllText(Path.Combine(destination, "src", "Widget", "Shared.gs")));
    }

    /// <summary>
    /// The real repository driver: a source compiled by a translated project AND
    /// referenced as data is translated and copied, and data/foreign inputs are
    /// copied without a translated twin.
    /// </summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Pipeline_TranslatesCompiledSources_AndCopiesReferencedOnes()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        this.Write(
            "source/src/Widget/Widget.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>" +
            "<ItemGroup><Compile Remove=\"Fixtures\\**\\*.cs\" />" +
            "<None Include=\"Fixtures\\**\\*\" /><None Include=\"Shared.cs\" /></ItemGroup></Project>");
        this.Write("source/src/Widget/Widget.cs", "namespace Widget { public static class Answer { public static int Value() => 42; } }");
        this.Write("source/src/Widget/Shared.cs", "namespace Widget { public static class Shared { public static int One() => 1; } }");
        this.Write("source/src/Widget/Fixtures/Data.cs", "namespace Fixture { public class Data { } }");
        this.Write(
            "source/samples/Foreign/Foreign.gsproj",
            "<Project Sdk=\"Gsharp.NET.Sdk\"><ItemGroup><Compile Include=\"ThisAssembly.cs\" /></ItemGroup></Project>");
        this.Write("source/samples/Foreign/ThisAssembly.cs", "namespace G { internal static class ThisAssembly { } }");
        string source = Path.Combine(this.root, "source");
        string destination = Path.Combine(this.root, "destination");
        var options = new PipelineOptions
        {
            GscPath = compiler,
            SourceRoot = source,
            OutputRoot = destination,
            ArtifactRoot = Path.Combine(this.root, "runs"),
            OutputLayout = MigrationOutputLayout.Repository,
            Config = "Release",
        };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() });

        RunResult result = await pipeline.RunAsync(RepositoryDiscovery.Discover(source));

        Assert.True(result.Succeeded);
        string widget = Path.Combine(destination, "src", "Widget");
        Assert.True(File.Exists(Path.Combine(widget, "Shared.gs")));
        Assert.Equal(
            File.ReadAllText(Path.Combine(source, "src", "Widget", "Shared.cs")),
            File.ReadAllText(Path.Combine(widget, "Shared.cs")));
        Assert.True(File.Exists(Path.Combine(widget, "Widget.gs")));
        Assert.True(File.Exists(Path.Combine(widget, "Fixtures", "Data.cs")));
        Assert.False(File.Exists(Path.Combine(widget, "Fixtures", "Data.gs")));
        Assert.True(File.Exists(Path.Combine(destination, "samples", "Foreign", "ThisAssembly.cs")));
        Assert.False(File.Exists(Path.Combine(destination, "samples", "Foreign", "ThisAssembly.gs")));
    }

    /// <summary>
    /// A namespace-split sibling of a translated source must not overwrite a
    /// checked-in file either.
    /// </summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Pipeline_NamespaceSplitSiblingWithCheckedInGsTwin_FailsInsteadOfOverwriting()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        this.Write(
            "source/src/Widget/Widget.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>");
        this.Write(
            "source/src/Widget/Mixed.cs",
            "namespace Split { public sealed class Shallow { } }\nnamespace Split.Deep { public sealed class Deeper { } }\n");
        this.Write("source/src/Widget/Mixed.Deep.gs", "package Split.Deep\n\nfunc checkedIn() {}\n");
        string destination = Path.Combine(this.root, "destination");
        var options = new PipelineOptions
        {
            GscPath = compiler,
            SourceRoot = Path.Combine(this.root, "source"),
            OutputRoot = destination,
            ArtifactRoot = Path.Combine(this.root, "runs"),
            OutputLayout = MigrationOutputLayout.Repository,
            Config = "Release",
        };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() });

        RunResult result = await pipeline.RunAsync(RepositoryDiscovery.Discover(Path.Combine(this.root, "source")));

        Assert.False(result.Succeeded);
        Assert.Contains("checkedIn", File.ReadAllText(Path.Combine(destination, "src", "Widget", "Mixed.Deep.gs")));
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
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
