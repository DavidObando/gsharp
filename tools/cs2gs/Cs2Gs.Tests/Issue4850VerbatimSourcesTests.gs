// <copyright file="Issue4850VerbatimSourcesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issues #4850 and #4852: every `.cs` file a project references is
/// translated, copied verbatim, or reported (never silently rewritten or
/// dropped), and the build-output root `out/` is never source or an app.
class Issue4850VerbatimSourcesTests : IDisposable {
    private let root string

    init() {
        this.root = Path.Combine(Path.GetTempPath(), "cs2gs-4850-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(this.root)
    }

    func Dispose() {
        try {
            Directory.Delete(this.root, recursive: true)
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    @Fact
    func DataAndForeignCompileSources_AreVerbatim_AndCompiledSourcesAreNot() {
        this.WriteRepository()
        let verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory())
        Assert.Equal(
            []string{"Tests/Fixtures/Data.cs", "Tests/Fixtures/Nested/Deep.cs", "foreign/ThisAssembly.cs"},
            verbatim.OrderBy((path string) -> path, StringComparer.Ordinal).ToArray()
        )
    }

    @Fact
    func Prepare_CopiesVerbatimSources_AndOrphanStepDoesNotTranslateThem() {
        this.WriteRepository()
        let destination = Path.Combine(Path.GetTempPath(), "cs2gs-4850-out-" + Guid.NewGuid().ToString("N"))
        try {
            let files = RepositoryMirror.Prepare(this.root, destination)
            let failures = RepositoryOrphanSourceTranslator.TranslateMissing(this.root, destination, files)
            Assert.Empty(failures)
            Assert.Equal(
                File.ReadAllText(Path.Combine(this.root, "foreign", "ThisAssembly.cs")),
                File.ReadAllText(Path.Combine(destination, "foreign", "ThisAssembly.cs"))
            )
            Assert.True(File.Exists(Path.Combine(destination, "Tests", "Fixtures", "Nested", "Deep.cs")))
            Assert.False(File.Exists(Path.Combine(destination, "foreign", "ThisAssembly.gs")))
            Assert.False(File.Exists(Path.Combine(destination, "Tests", "Fixtures", "Data.gs")))
            // Compiled sources are still translated, never copied.
            Assert.False(File.Exists(Path.Combine(destination, "Tests", "Program.cs")))
            Assert.True(File.Exists(Path.Combine(destination, "Tests", "Program.gs")))
        } finally {
            if Directory.Exists(destination) {
                Directory.Delete(destination, recursive: true)
            }
        }
    }

    @Fact
    func ValidateCompleted_ExpectsVerbatimCopy_AndRejectsItsMissingTwin() {
        this.WriteRepository()
        let destination = Path.Combine(Path.GetTempPath(), "cs2gs-4850-out-" + Guid.NewGuid().ToString("N"))
        try {
            let files = RepositoryMirror.Prepare(this.root, destination)
            RepositoryOrphanSourceTranslator.TranslateMissing(this.root, destination, files)
            let additional = []string{
                "Tests/Tests.gsproj",
                "foreign/foreign.gsproj",
                DirectoryInfo(this.root).Name + ".slnx"
            }
                .Select((path string) -> path.Replace('/', Path.DirectorySeparatorChar)).ToArray()
            for path in additional {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(destination, path))!!)
                File.WriteAllText(Path.Combine(destination, path), "<Project />")
            }
            RepositoryMirror.ValidateCompleted(this.root, destination, files, additional)
            File.Delete(Path.Combine(destination, "foreign", "ThisAssembly.cs"))
            let ex = Assert.Throws[InvalidOperationException](
                () -> RepositoryMirror.ValidateCompleted(this.root, destination, files, additional)
            )
            Assert.Contains("ThisAssembly.cs", ex.Message)
        } finally {
            if Directory.Exists(destination) {
                Directory.Delete(destination, recursive: true)
            }
        }
    }

    @Fact
    func SourceCompiledByTranslatedProjectAndReferencedAsData_IsBothTranslatedAndCopied() {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><Content Include=\"Shared.cs\" /></ItemGroup></Project>"
        )
        this.Write("a/Shared.cs", "namespace N { public static class S { public static int V = 1; } }")
        let verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory())
        Assert.Equal([]string{"a/Shared.cs"}, verbatim.ToArray())
    }

    @Fact
    func UnresolvableIncludeThatCouldNameCSharp_IsReported() {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><None Include=\"$$(SomeDir)/**/*.cs\" /></ItemGroup></Project>"
        )
        this.Write("a/X.cs", "class X {}")
        let warnings = List[string]()
        let verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory(), warnings)
        Assert.Empty(verbatim)
        Assert.Contains("a/a.csproj", Assert.Single(warnings))
        Assert.Contains("$$(SomeDir)/**/*.cs", warnings[0])
    }

    @Fact
    func OutDirectory_IsNeverInventoriedDiscoveredOrMirrored() {
        this.Write("src/App/App.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />")
        this.Write("src/App/Program.cs", "class P {}")
        this.Write("out/scratch/ildump/ildump.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />")
        this.Write("out/scratch/ildump/Program.cs", "class Q {}")
        this.Write("out/obj/App/Debug/AssemblyAttributes.cs", "class R {}")
        let inventory = RepositoryFileInventory.Enumerate(this.root)
        let apps = RepositoryDiscovery.Discover(this.root)
        Assert.DoesNotContain(inventory, (path string) -> path.StartsWith("out/", StringComparison.Ordinal))
        Assert.Equal(
            []string{"src/App/App.csproj"},
            apps.Select((app CorpusApp) -> app.RelativeProjectPath!!.Replace('\\', '/')).ToArray()
        )
    }

    @Fact
    func NestedDirectoryNamedOut_IsStillSource() {
        this.Write("src/out/Keep.cs", "class K {}")
        this.Write("src/App/App.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />")
        Assert.Contains("src/out/Keep.cs", RepositoryFileInventory.Enumerate(this.root))
    }

    @Fact
    func LaterIncludeReAddsWhatAnEarlierRemoveTook_AndLaterRemoveWins() {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>" +
                "<None Remove=\"Readded.cs\" /><None Include=\"Readded.cs\" />" +
                "<None Include=\"Removed.cs\" /><None Remove=\"Removed.cs\" />" +
                "</ItemGroup></Project>"
        )
        this.Write("a/Readded.cs", "class A {}")
        this.Write("a/Removed.cs", "class B {}")
        let verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory())
        Assert.Equal([]string{"a/Readded.cs"}, verbatim.ToArray())
    }

    @Fact
    func DirectoryAnchors_ResolveRelativeToTheProjectOnce() {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>" +
                "<None Include=\"$$(MSBuildThisFileDirectory)Data.cs\" />" +
                "<None Include=\"$$(MSBuildProjectDirectory)\\Other.cs\" />" +
                "</ItemGroup></Project>"
        )
        this.Write("a/Data.cs", "class A {}")
        this.Write("a/Other.cs", "class B {}")
        let warnings = List[string]()
        let verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory(), warnings)
        Assert.Equal(
            []string{"a/Data.cs", "a/Other.cs"},
            verbatim.OrderBy((p string) -> p, StringComparer.Ordinal).ToArray()
        )
        Assert.Empty(warnings)
    }

    @Fact
    func BackslashSpelledInventory_StillMatches() {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><None Include=\"Fixtures\\**\\*\" /></ItemGroup></Project>"
        )
        this.Write("a/Fixtures/Data.cs", "class A {}")
        let verbatim = RepositoryVerbatimSources.Compute(this.root, []string{"a\\a.csproj", "a\\Fixtures\\Data.cs"})
        Assert.Equal([]string{"a\\Fixtures\\Data.cs"}, verbatim.ToArray())
    }

    @Fact
    func ExcludeOnALaterInclude_DoesNotUnreferenceAnEarlierOne() {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>" +
                "<None Include=\"Data.cs\" /><None Include=\"*.cs\" Exclude=\"Data.cs\" />" +
                "</ItemGroup></Project>"
        )
        this.Write("a/Data.cs", "class A {}")
        this.Write("a/Other.cs", "class B {}")
        let verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory())
        Assert.Equal(
            []string{"a/Data.cs", "a/Other.cs"},
            verbatim.OrderBy((p string) -> p, StringComparer.Ordinal).ToArray()
        )
    }

    @Fact
    func ConditionalOrTargetRemove_DoesNotClearAReference() {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>" +
                "<None Include=\"A.cs\" /><None Remove=\"A.cs\" Condition=\"'false' == 'true'\" />" +
                "<None Include=\"B.cs\" /></ItemGroup>" +
                "<ItemGroup Condition=\"'false' == 'true'\"><None Remove=\"B.cs\" /></ItemGroup>" +
                "<ItemGroup><None Include=\"C.cs\" /></ItemGroup>" +
                "<Target Name=\"T\"><ItemGroup><None Remove=\"C.cs\" /></ItemGroup></Target></Project>"
        )
        this.Write("a/A.cs", "class A {}")
        this.Write("a/B.cs", "class B {}")
        this.Write("a/C.cs", "class C {}")
        let verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory())
        Assert.Equal(
            []string{"a/A.cs", "a/B.cs", "a/C.cs"},
            verbatim.OrderBy((p string) -> p, StringComparer.Ordinal).ToArray()
        )
    }

    @Fact
    func CompileItemsOfASharedFileImportedByAGsproj_ResolveAgainstTheImporterOrTheFile() {
        this.Write(
            "g/g.gsproj",
            "<Project Sdk=\"Gsharp.NET.Sdk\"><Import Project=\"..\\shared\\shared.props\" /></Project>"
        )
        this.Write(
            "shared/shared.props",
            "<Project><ItemGroup><Compile Include=\"Foreign.cs\" />" +
                "<Compile Include=\"$$(MSBuildThisFileDirectory)Anchored.cs\" /></ItemGroup></Project>"
        )
        this.Write("g/Foreign.cs", "class F {}")
        this.Write("shared/Anchored.cs", "class A {}")
        this.Write("shared/unrelated.props", "<Project><ItemGroup><Compile Include=\"Own.cs\" /></ItemGroup></Project>")
        this.Write("shared/Own.cs", "class O {}")
        let verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory())
        Assert.Equal(
            []string{"g/Foreign.cs", "shared/Anchored.cs"},
            verbatim.OrderBy((p string) -> p, StringComparer.Ordinal).ToArray()
        )
    }

    @Fact
    func CompileItemsOfATransitivelyImportedSharedFile_AreVerbatim() {
        this.Write("g/g.gsproj", "<Project Sdk=\"Gsharp.NET.Sdk\"><Import Project=\"..\\shared\\a.props\" /></Project>")
        this.Write("shared/a.props", "<Project><Import Project=\"b.props\" /></Project>")
        this.Write("shared/b.props", "<Project><ItemGroup><Compile Include=\"Foreign.cs\" /></ItemGroup></Project>")
        this.Write("g/Foreign.cs", "class F {}")
        let verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory())
        Assert.Equal([]string{"g/Foreign.cs"}, verbatim.ToArray())
    }

    @Fact
    func Update_NeverMakesAFileReferenced() {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>" +
                "<Compile Remove=\"Data.cs\" /><None Update=\"Data.cs\" CopyToOutputDirectory=\"Always\" />" +
                "</ItemGroup></Project>"
        )
        this.Write("a/Data.cs", "class A {}")
        Assert.Empty(RepositoryVerbatimSources.Compute(this.root, this.Inventory()))
    }

    @Fact
    func CompileItemsOfADirectoryBuildFileOverAGsproj_AreVerbatim() {
        this.Write(
            "Directory.Build.targets",
            "<Project><ItemGroup><Compile Include=\"Foreign.cs\" /></ItemGroup></Project>"
        )
        this.Write("g/Foreign.cs", "class F {}")
        this.Write("g/g.gsproj", "<Project Sdk=\"Gsharp.NET.Sdk\" />")
        let verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory())
        Assert.Equal([]string{"g/Foreign.cs"}, verbatim.ToArray())
    }

    @Fact
    func NonCompileItemsOfASharedFileImportedByACsproj_AreVerbatim_AndUnimportedFilesAreIgnored() {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><Import Project=\"..\\shared\\shared.props\" /></Project>"
        )
        this.Write(
            "shared/shared.props",
            "<Project><ItemGroup><None Include=\"Fixture.cs\" /><Compile Include=\"Own.cs\" /></ItemGroup></Project>"
        )
        this.Write("a/Fixture.cs", "class F {}")
        this.Write("a/Own.cs", "class O {}")
        this.Write("shared/unused.props", "<Project><ItemGroup><None Include=\"Unused.cs\" /></ItemGroup></Project>")
        this.Write("shared/Unused.cs", "class U {}")
        let verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory())
        Assert.Equal([]string{"a/Fixture.cs"}, verbatim.ToArray())
    }

    @Fact
    func FilesImportedByADirectoryBuildFile_AreReachableFromProjectsBelow() {
        this.Write("Directory.Build.props", "<Project><Import Project=\"build/common.props\" /></Project>")
        this.Write("build/common.props", "<Project><ItemGroup><Compile Include=\"Foreign.cs\" /></ItemGroup></Project>")
        this.Write("g/Foreign.cs", "class F {}")
        this.Write("g/g.gsproj", "<Project Sdk=\"Gsharp.NET.Sdk\" />")
        let verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory())
        Assert.Equal([]string{"g/Foreign.cs"}, verbatim.ToArray())
    }

    @Fact
    func SharedCompileItems_OnlyApplyToGsharpImporters_AndAnchoredIncludesToTheFile() {
        this.Write(
            "g/g.gsproj",
            "<Project Sdk=\"Gsharp.NET.Sdk\"><Import Project=\"..\\shared\\shared.props\" /></Project>"
        )
        this.Write(
            "c/c.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><Import Project=\"..\\shared\\shared.props\" /></Project>"
        )
        this.Write(
            "shared/shared.props",
            "<Project><ItemGroup><Compile Include=\"Foreign.cs\" />" +
                "<Compile Include=\"$$(MSBuildThisFileDirectory)Anchored.cs\" />" +
                "<None Include=\"Data.cs\" /></ItemGroup></Project>"
        )
        this.Write("g/Foreign.cs", "class A {}")
        this.Write("c/Foreign.cs", "class B {}")
        this.Write("shared/Anchored.cs", "class C {}")
        this.Write("g/Anchored.cs", "class D {}")
        this.Write("g/Data.cs", "class E {}")
        this.Write("c/Data.cs", "class F {}")
        let verbatim = RepositoryVerbatimSources.Compute(this.root, this.Inventory())
        Assert.Equal(
            []string{"c/Data.cs", "g/Data.cs", "g/Foreign.cs", "shared/Anchored.cs"},
            verbatim.OrderBy((p string) -> p, StringComparer.Ordinal).ToArray()
        )
    }

    @Fact
    func SharedFileWithNoGsprojImporter_KeepsItsCompileItemsTranslated() {
        this.Write(
            "Directory.Build.targets",
            "<Project><ItemGroup><Compile Include=\"Own.cs\" /></ItemGroup></Project>"
        )
        this.Write("Own.cs", "class O {}")
        this.Write("a/a.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />")
        Assert.Empty(RepositoryVerbatimSources.Compute(this.root, this.Inventory()))
    }

    @Fact
    func DataOnlySourceWithAGsTwin_IsNotACollision() {
        this.Write(
            "a/a.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup><Compile Remove=\"Data.cs\" /><None Include=\"Data.cs\" /></ItemGroup></Project>"
        )
        this.Write("a/Data.cs", "class A {}")
        this.Write("a/Data.gs", "package a")
        let destination = Path.Combine(Path.GetTempPath(), "cs2gs-4850-out-" + Guid.NewGuid().ToString("N"))
        try {
            RepositoryMirror.Prepare(this.root, destination)
            Assert.Equal("class A {}", File.ReadAllText(Path.Combine(destination, "a", "Data.cs")))
            Assert.Equal("package a", File.ReadAllText(Path.Combine(destination, "a", "Data.gs")))
        } finally {
            if Directory.Exists(destination) {
                Directory.Delete(destination, recursive: true)
            }
        }
    }

    /// A source that is both compiled and referenced as data must not have its
    /// translation silently overwrite a checked-in same-name `.gs`.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Pipeline_DualOwnedSourceWithCheckedInGsTwin_FailsInsteadOfOverwriting() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        this.Write(
            "source/src/Widget/Widget.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>" +
                "<ItemGroup><None Include=\"Shared.cs\" /></ItemGroup></Project>"
        )
        this.Write(
            "source/src/Widget/Shared.cs",
            "namespace Widget { public static class Shared { public static int One() => 1; } }"
        )
        this.Write("source/src/Widget/Shared.gs", `package Widget

func checkedIn() {}
`)
        let destination = Path.Combine(this.root, "destination")
        let options = PipelineOptions{
            GscPath: compiler,
            SourceRoot: Path.Combine(this.root, "source"),
            OutputRoot: destination,
            ArtifactRoot: Path.Combine(this.root, "runs"),
            OutputLayout: MigrationOutputLayout.Repository,
            Config: "Release"
        }
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage()})
        let result = await pipeline.RunAsync(RepositoryDiscovery.Discover(Path.Combine(this.root, "source")))
        Assert.False(result.Succeeded)
        Assert.Contains("checkedIn", File.ReadAllText(Path.Combine(destination, "src", "Widget", "Shared.gs")))
    }

    /// The real repository driver: a source compiled by a translated project AND
    /// referenced as data is translated and copied, and data/foreign inputs are
    /// copied without a translated twin.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Pipeline_TranslatesCompiledSources_AndCopiesReferencedOnes() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        this.Write(
            "source/src/Widget/Widget.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>" +
                "<ItemGroup><Compile Remove=\"Fixtures\\**\\*.cs\" />" +
                "<None Include=\"Fixtures\\**\\*\" /><None Include=\"Shared.cs\" /></ItemGroup></Project>"
        )
        this.Write(
            "source/src/Widget/Widget.cs",
            "namespace Widget { public static class Answer { public static int Value() => 42; } }"
        )
        this.Write(
            "source/src/Widget/Shared.cs",
            "namespace Widget { public static class Shared { public static int One() => 1; } }"
        )
        this.Write("source/src/Widget/Fixtures/Data.cs", "namespace Fixture { public class Data { } }")
        this.Write(
            "source/samples/Foreign/Foreign.gsproj",
            "<Project Sdk=\"Gsharp.NET.Sdk\"><ItemGroup><Compile Include=\"ThisAssembly.cs\" /></ItemGroup></Project>"
        )
        this.Write("source/samples/Foreign/ThisAssembly.cs", "namespace G { internal static class ThisAssembly { } }")
        let source = Path.Combine(this.root, "source")
        let destination = Path.Combine(this.root, "destination")
        let options = PipelineOptions{
            GscPath: compiler,
            SourceRoot: source,
            OutputRoot: destination,
            ArtifactRoot: Path.Combine(this.root, "runs"),
            OutputLayout: MigrationOutputLayout.Repository,
            Config: "Release"
        }
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage()})
        let result = await pipeline.RunAsync(RepositoryDiscovery.Discover(source))
        Assert.True(result.Succeeded)
        let widget = Path.Combine(destination, "src", "Widget")
        Assert.True(File.Exists(Path.Combine(widget, "Shared.gs")))
        Assert.Equal(
            File.ReadAllText(Path.Combine(source, "src", "Widget", "Shared.cs")),
            File.ReadAllText(Path.Combine(widget, "Shared.cs"))
        )
        Assert.True(File.Exists(Path.Combine(widget, "Widget.gs")))
        Assert.True(File.Exists(Path.Combine(widget, "Fixtures", "Data.cs")))
        Assert.False(File.Exists(Path.Combine(widget, "Fixtures", "Data.gs")))
        Assert.True(File.Exists(Path.Combine(destination, "samples", "Foreign", "ThisAssembly.cs")))
        Assert.False(File.Exists(Path.Combine(destination, "samples", "Foreign", "ThisAssembly.gs")))
    }

    /// A namespace-split sibling of a translated source must not overwrite a
    /// checked-in file either.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Pipeline_NamespaceSplitSiblingWithCheckedInGsTwin_FailsInsteadOfOverwriting() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        this.Write(
            "source/src/Widget/Widget.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"
        )
        this.Write("source/src/Widget/Mixed.cs", `namespace Split { public sealed class Shallow { } }
namespace Split.Deep { public sealed class Deeper { } }
`)
        this.Write("source/src/Widget/Mixed.Deep.gs", `package Split.Deep

func checkedIn() {}
`)
        let destination = Path.Combine(this.root, "destination")
        let options = PipelineOptions{
            GscPath: compiler,
            SourceRoot: Path.Combine(this.root, "source"),
            OutputRoot: destination,
            ArtifactRoot: Path.Combine(this.root, "runs"),
            OutputLayout: MigrationOutputLayout.Repository,
            Config: "Release"
        }
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage()})
        let result = await pipeline.RunAsync(RepositoryDiscovery.Discover(Path.Combine(this.root, "source")))
        Assert.False(result.Succeeded)
        Assert.Contains("checkedIn", File.ReadAllText(Path.Combine(destination, "src", "Widget", "Mixed.Deep.gs")))
    }

    /// The unresolved-include warning reaches stderr through the real driver.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Pipeline_ReportsAnUnresolvableCSharpIncludeOnStandardError() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        this.Write(
            "source/src/Widget/Widget.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>" +
                "<ItemGroup><None Include=\"$$(SomeDir)/Data.cs\" /></ItemGroup></Project>"
        )
        this.Write(
            "source/src/Widget/Widget.cs",
            "namespace Widget { public static class Answer { public static int Value() => 42; } }"
        )
        let options = PipelineOptions{
            GscPath: compiler,
            SourceRoot: Path.Combine(this.root, "source"),
            OutputRoot: Path.Combine(this.root, "destination"),
            ArtifactRoot: Path.Combine(this.root, "runs"),
            OutputLayout: MigrationOutputLayout.Repository,
            Config: "Release"
        }
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage()})
        let originalError = Console.Error
        let captured = StringWriter()
        Console.SetError(captured)
        try {
            await pipeline.RunAsync(RepositoryDiscovery.Discover(Path.Combine(this.root, "source")))
        } finally {
            Console.SetError(originalError)
        }
        let warning = Assert.Single(
            captured.ToString().Split('\n'),
            (line string) -> line.Contains("cannot resolve", StringComparison.Ordinal)
        )
        Assert.Contains("src/Widget/Widget.csproj", warning, StringComparison.Ordinal)
        Assert.Contains("$$(SomeDir)/Data.cs", warning, StringComparison.Ordinal)
    }

    private func Inventory() IReadOnlyList[string] -> RepositoryFileInventory.Enumerate(this.root)

    private func WriteRepository() {
        this.Write(
            "Tests/Tests.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>" +
                "<Compile Remove=\"Fixtures\\**\\*.cs\" />" +
                "<None Include=\"Fixtures\\**\\*\" CopyToOutputDirectory=\"PreserveNewest\" />" +
                "</ItemGroup></Project>"
        )
        this.Write("Tests/Program.cs", "namespace T { public static class Program { public static int Main() => 0; } }")
        this.Write("Tests/Fixtures/Data.cs", "namespace F { public class Data { } }")
        this.Write("Tests/Fixtures/Nested/Deep.cs", "namespace F { public class Deep { } }")
        this.Write(
            "foreign/foreign.gsproj",
            "<Project Sdk=\"Gsharp.NET.Sdk\"><ItemGroup><Compile Include=\"ThisAssembly.cs\" /></ItemGroup></Project>"
        )
        this.Write("foreign/ThisAssembly.cs", "namespace G { internal static class ThisAssembly { } }")
    }

    private func Write(relativePath string, content string) {
        let path = Path.Combine(this.root, relativePath.Replace('/', Path.DirectorySeparatorChar))
        Directory.CreateDirectory(Path.GetDirectoryName(path)!!)
        File.WriteAllText(path, content)
    }

    shared {
        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
