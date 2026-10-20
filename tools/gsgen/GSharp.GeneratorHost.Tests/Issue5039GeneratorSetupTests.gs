// <copyright file="Issue5039GeneratorSetupTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.GeneratorHost
import GSharp.Gsgen.Cli
import GSharp.Workers
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Gsharp.NET.Sdk.Tools
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.IO.Pipes
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import System.Runtime.Loader
import System.Text
import System.Threading
import Xunit

/// Real analyzer loading and repeated host requests for issue #5039.
open class Issue5039GeneratorSetupTests : IDisposable {
    private let directory string = Path.Combine(Path.GetTempPath(), "gsgen-5039", Guid.NewGuid().ToString("N"))

    init() {
        Directory.CreateDirectory(directory)
    }

    func Dispose() {
        Collect()
        Directory.Delete(directory, recursive: true)
    }

    @Fact
    func AnalyzerWithoutGenerators_SkipsProjectionAndReferences_AndDeletesOrphans() {
        let gs = Write("Input.gs", "package App\nclass Foo {}")
        let badReference = Write("NotAnAssembly.dll", "not a PE image")
        let output = Path.Combine(directory, "output")
        Directory.CreateDirectory(output)
        let stale = Path.Combine(output, "stale.g.gs")
        File.WriteAllText(stale, "class Stale {}")
        let manifest = Path.Combine(directory, "manifest")
        let stdout = StringWriter()
        using let measurements = CompilationMeasurements.Start("gsgen-test")
        let exit = GsgenProgram.Run(
            []string{
                "/gs:$gs",
                "/analyzer:${typeof(GsgenProgram).Assembly.Location}",
                "/r:$badReference",
                "/out:$output",
                "/manifest:$manifest"
            },
            stdout
        )
        Assert.Equal(0, exit)
        Assert.Equal(string.Empty, stdout.ToString())
        Assert.Equal(string.Empty, File.ReadAllText(manifest))
        Assert.False(File.Exists(stale))
        Assert.Equal(1, measurements.GetCounter("generator.analyzer_paths"))
        Assert.Equal(0, measurements.GetCounter("generator.metadata_images_created"))
        Assert.Equal(0, measurements.GetCounter("generator.source_files"))
    }

    @Fact
    func AnalyzerWithoutGenerators_DoesNotBindTheLazyGlobalScope() {
        let compilation = GsCompilation(GsSyntaxTree.Parse(GsSourceText.From("package App\nclass Foo {}")))
        let scopeField = typeof(GsCompilation).GetField(
            "globalScope",
            BindingFlags.Instance | BindingFlags.NonPublic
        ) ??
            throw InvalidOperationException("Compilation's lazy scope field was not found.")
        Assert.Null(scopeField.GetValue(compilation))
        let result = GeneratorHostRunner.RunFromAnalyzerPaths(
            compilation,
            Array.Empty[MetadataReference](),
            []string{typeof(GsgenProgram).Assembly.Location}
        )
        Assert.Empty(result.Failures)
        Assert.Empty(result.GeneratedGsFiles)
        Assert.Null(scopeField.GetValue(compilation))
    }

    @Fact
    func AnalyzerWithoutGenerators_StillTranslatesForeignCSharp() {
        let gs = Write("Input.gs", "package App\nclass Foo {}")
        let cs = Write(
            "ThisAssembly.cs",
            "namespace App { internal static class ThisAssembly { public const string Version = \"v1\"; } }"
        )
        let args = Arguments(gs, typeof(GsgenProgram).Assembly.Location)
        args.Add("/csfile:$cs")
        let stdout = StringWriter()
        Assert.Equal(0, GsgenProgram.Run(args.ToArray(), stdout))
        let generated = File.ReadAllText(Assert.Single(GeneratedFiles()))
        Assert.Contains("ThisAssembly", generated)
        Assert.Contains("\"v1\"", generated)
    }

    @Fact
    func GeneratedTranslation_SourceCensusSkipsMetadataTypes_AndPreservesHomonymsAndNullableAliases() {
        let generator = Path.Combine(directory, "Generator.dll")
        CompileDll(
            GeneratorSource.Replace(
                "public string Greeting =>",
                "public global::System.Uri? Address => null; public string Greeting =>"
            )
                .Replace("__VERSION__", "census"),
            generator,
            "Generator"
        )
        let gs = Write("Input.gs", "package App\nclass Uri {}\n@Obsolete\npartial class Foo {}")
        using let measurements = CompilationMeasurements.Start("gsgen-test")
        Run(Arguments(gs, generator), MetadataReferenceCache())
        let generated = File.ReadAllText(Assert.Single(GeneratedFiles()))
        Assert.Contains("partial class Foo", generated)
        Assert.Contains("System.Uri", generated)
        Assert.DoesNotContain("prop Address Uri?", generated)
        Assert.Contains("? -> nil", generated)
        Assert.Contains("census|||on", generated)
        let visited = measurements.GetCounter("translation.source_census.types_visited")
        Assert.InRange(visited, 1, 32)
        Assert.Equal(1, measurements.GetCounter("translation.import_semantic_model_reuses"))
    }

    @Fact
    func EmptyManifest_DoesNotSuppressDiagnostics_OrLaterGeneratedPart() {
        using let measurements = CompilationMeasurements.Start("gsgen-test")
        let generator = CompileGenerator("v1")
        let gs = Write("Input.gs", "package App\npartial class Foo {}")
        let args = Arguments(gs, generator)
        let cache = MetadataReferenceCache()
        let first = Run(args, cache)
        Assert.Contains("warning PROBE5039", first)
        Assert.Empty(GeneratedFiles())
        Assert.Equal(string.Empty, File.ReadAllText(Path.Combine(directory, "manifest")))

        File.WriteAllText(gs, "package App\n@Obsolete\npartial class Foo {}")
        let second = Run(args, cache)
        Assert.Contains("warning PROBE5039", second)
        let generated = Assert.Single(GeneratedFiles())
        Assert.Contains("prop Greeting string", File.ReadAllText(generated))
        let contents = File.ReadAllBytes(generated)
        let timestamp = File.GetLastWriteTimeUtc(generated)
        Assert.Contains("warning PROBE5039", Run(args, cache))
        Assert.Equal(contents, File.ReadAllBytes(generated))
        Assert.Equal(timestamp, File.GetLastWriteTimeUtc(generated))

        File.WriteAllText(gs, "package App\npartial class Foo {}")
        Assert.Contains("warning PROBE5039", Run(args, cache))
        Assert.Empty(GeneratedFiles())
        Assert.False(File.Exists(generated))
        Assert.True(measurements.GetCounter("generator.generated_tree_reuses") > 0)
        Assert.True(measurements.GetCounter("generator.stub_tree_reuses") > 0)
    }

    @Fact
    func Projection_SkipsImpossibleAnonymousDeclarationWalks_AndRebindsGeneratedPartAfterEdits() {
        let generator = CompileGenerator("projection")
        let source = `package App
@Obsolete
partial class Foo {
    func Read() string -> Greeting
    func Number() int32 -> __BODY__
}
`
        let gs = Write("Input.gs", source.Replace("__BODY__", "17"))
        let other = Write("Other.gs", "package App\nclass Other {}")
        let args = Arguments(gs, generator)
        args.Add("/gs:$other")
        let cache = MetadataReferenceCache()
        for body in[]string{"17", "(object { func Value() int32 -> 17 }).Value()", "18"} {
            File.WriteAllText(gs, source.Replace("__BODY__", body))
            using let measurements = CompilationMeasurements.Start("gsgen-test")
            Assert.Contains("warning PROBE5039: projection", Run(args, cache))
            let generated = Assert.Single(GeneratedFiles())
            Assert.Contains("prop Greeting string", File.ReadAllText(generated))
            let scanned = measurements.GetCounter("declarations.rich-anonymous.scanned-trees")
            let skipped = measurements.GetCounter("declarations.rich-anonymous.skipped-trees")
            // A projection's incomplete partial scope must not become the final scope.
            let combined = GsCompilation(GsSyntaxTree.Load(gs), GsSyntaxTree.Load(other), GsSyntaxTree.Load(generated)){
                IsLibrary = true
            }
            using let image = MemoryStream()
            let emitted = combined.Emit(image)
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics))
            Assert.True(image.Length > 0)
            let runtime = AssemblyLoadContext("projection-" + Guid.NewGuid().ToString("N"), isCollectible: true)
            try {
                image.Position = 0
                let assembly = runtime.LoadFromStream(image)
                let type = assembly.GetType("App.Foo") ?? throw InvalidOperationException("Generated Foo is missing.")
                let instance = Activator.CreateInstance(type)
                Assert.Equal(
                    if body == "18" {
                        18
                    } else {
                        17
                    },
                    type.GetMethod("Number")?.Invoke(instance, nil)
                )
                Assert.Equal("projection|||on", type.GetMethod("Read")?.Invoke(instance, nil))
            } finally {
                runtime.Unload()
            }
            Assert.Equal(
                if body == "17" || body == "18" {
                    0L
                } else {
                    1L
                },
                scanned
            )
            Assert.True(skipped > 0)
        }
    }

    @Theory
    @InlineData(`(object { func Value() int32 -> 23 }).Value()`)
    @InlineData(`"${(object { func Value() int32 -> 23 }).Value()}"`)
    func Projection_KeepsAnonymousDeclarations_InOrdinaryAndInterpolationParsers(body string) {
        let compilation = GsCompilation(GsSyntaxTree.Parse(`package App
class Container {
    func Read() -> __BODY__
}
`.Replace("__BODY__", body))){IsLibrary = true}
        using let measurements = CompilationMeasurements.Start("gsgen-test")
        let stub = GsToCSharpProjection.ProjectToCSharp(compilation)
        Assert.Contains("class Container", stub)
        Assert.Equal(2, compilation.GlobalScope.Structs.Length)
        using let image = MemoryStream()
        let emitted = compilation.Emit(image)
        Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics))
        Assert.True(image.Length > 0)
        Assert.Equal(1, measurements.GetCounter("declarations.rich-anonymous.scanned-trees"))
    }

    @Fact
    func ErrorDiagnostics_PreserveLastGoodFilesAndManifest_AndRepeatOnTheNextRequest() {
        let generator = CompileGenerator("good")
        let gs = Write("Input.gs", "package App\n@Obsolete\npartial class Foo {}")
        let args = Arguments(gs, generator)
        let cache = MetadataReferenceCache()
        Run(args, cache)
        let generated = Assert.Single(GeneratedFiles())
        let contents = File.ReadAllBytes(generated)
        let manifest = Path.Combine(directory, "manifest")
        let manifestContents = File.ReadAllBytes(manifest)
        let stamp = File.GetLastWriteTimeUtc(manifest)
        Collect()
        CompileDll(
            GeneratorSource.Replace("__VERSION__", "bad").Replace(
                "DiagnosticSeverity.Warning",
                "DiagnosticSeverity.Error"
            ),
            generator,
            "Generator"
        )
        for var request = 0; request < 2; request++ {
            let stdout = StringWriter()
            Assert.Equal(1, GsgenProgram.Run(args.ToArray(), stdout, cache))
            Assert.Contains("error PROBE5039: bad", stdout.ToString())
            Assert.Equal(contents, File.ReadAllBytes(generated))
            Assert.Equal(manifestContents, File.ReadAllBytes(manifest))
            Assert.Equal(stamp, File.GetLastWriteTimeUtc(manifest))
        }
    }

    @Fact
    func RepeatedRequests_InvalidateAdditionalFilesOptionsReferencesAndGeneratorContents() {
        using let measurements = CompilationMeasurements.Start("gsgen-test")
        let generator = CompileGenerator("v1")
        let gs = Write("Input.gs", "package App\n@Obsolete\npartial class Foo {}")
        let additional = Write("Input.txt", "first")
        let reference = Path.Combine(directory, "Contract.dll")
        CompileDll(
            "namespace Contract { public static class Marker { public const string Value = \"one\"; } }",
            reference,
            "Contract"
        )
        let args = Arguments(gs, generator)
        args.Add("/r:$reference")
        args.Add("/additionalfile:$additional")
        let cache = MetadataReferenceCache()
        Assert.Contains("v1|first|one|on", Run(args, cache))
        Assert.Contains("v1|first|one|on", File.ReadAllText(Assert.Single(GeneratedFiles())))

        File.WriteAllText(additional, "next")
        Assert.Contains("v1|next|one|on", Run(args, cache))
        Assert.Contains("v1|next|one|on", File.ReadAllText(Assert.Single(GeneratedFiles())))

        args.Add("/globaloption:Emit=off")
        Assert.Contains("v1|next|one|off", Run(args, cache))
        Assert.Empty(GeneratedFiles())
        args.RemoveAt(args.Count - 1)

        Collect()
        var timestamp = File.GetLastWriteTimeUtc(reference)
        CompileDll(
            "namespace Contract { public static class Marker { public const string Value = \"two\"; } }",
            reference,
            "Contract"
        )
        File.SetLastWriteTimeUtc(reference, timestamp)
        Assert.Contains("v1|next|two|on", Run(args, cache))
        Assert.Contains("v1|next|two|on", File.ReadAllText(Assert.Single(GeneratedFiles())))

        Collect()
        timestamp = File.GetLastWriteTimeUtc(generator)
        CompileGenerator("v2")
        File.SetLastWriteTimeUtc(generator, timestamp)
        Assert.Contains("v2|next|two|on", Run(args, cache))
        Assert.Contains("v2|next|two|on", File.ReadAllText(Assert.Single(GeneratedFiles())))
        Assert.True(measurements.GetCounter("generator.metadata_cache_hits") > 0)
    }

    @Fact
    func Discovery_LoadContextsAreCollectible() {
        let generator = CompileGenerator("v1")
        let context = DiscoverContext(generator)
        Collect()
        Assert.False(context.IsAlive, "Discovery retained the analyzer's collectible load context.")
    }

    @Fact
    func RepeatedRequests_ReloadChangedGeneratorDependency_WithUnchangedGeneratorIdentity() {
        let dependency = Path.Combine(directory, "Dependency.dll")
        CompileDll(
            "namespace Dependency { public static class Marker { public static string Value => \"one\"; } }",
            dependency,
            "Dependency"
        )
        let generator = Path.Combine(directory, "Generator.dll")
        CompileDll(
            GeneratorSource.Replace("\"__VERSION__|\"", "Dependency.Marker.Value + \"|\""),
            generator,
            "Generator",
            dependency
        )
        let gs = Write("Input.gs", "package App\n@Obsolete\npartial class Foo {}")
        let args = Arguments(gs, generator)
        let cache = MetadataReferenceCache()
        Assert.Contains("one|||on", Run(args, cache))
        Collect()
        CompileDll(
            "namespace Dependency { public static class Marker { public static string Value => \"two\"; } }",
            dependency,
            "Dependency"
        )
        Assert.Contains("two|||on", Run(args, cache))
        Assert.Contains("two|||on", File.ReadAllText(Assert.Single(GeneratedFiles())))
    }

    @Fact
    func AnalyzerLocalFrameworkCopy_UsesTheHostsRoslynContractIdentity() {
        let generator = CompileGenerator("v1")
        File.Copy(
            typeof(ImmutableArray[int32]).Assembly.Location,
            Path.Combine(directory, "System.Collections.Immutable.dll")
        )
        let gs = Write("Input.gs", "package App\n@Obsolete\npartial class Foo {}")
        let stdout = Run(Arguments(gs, generator), MetadataReferenceCache())
        Assert.Contains("warning PROBE5039", stdout)
        Assert.DoesNotContain("GS9203", stdout)
        Assert.Contains("v1|||on", File.ReadAllText(Assert.Single(GeneratedFiles())))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func AnalyzersInOneDirectory_ShareTheirDependencyClosure(varyDirectoryCasing bool) {
        let firstDirectory = if varyDirectoryCasing {
            Path.Combine(directory, "package")
        } else {
            directory
        }
        let secondDirectory = if varyDirectoryCasing {
            Path.Combine(directory, "PACKAGE")
        } else {
            directory
        }
        Directory.CreateDirectory(firstDirectory)
        Directory.CreateDirectory(secondDirectory)
        let dependency = Path.Combine(firstDirectory, "Dependency.dll")
        CompileDll(
            "namespace Dependency { public static class Marker { private static int value; public static int Next() => ++value; } }",
            dependency,
            "Dependency"
        )
        let source = GeneratorSource.Replace("\"__VERSION__|\"", "Dependency.Marker.Next().ToString() + \"|\"")
        let secondDependency = Path.Combine(secondDirectory, "Dependency.dll")
        if varyDirectoryCasing && !OperatingSystem.IsWindows() {
            File.Copy(dependency, secondDependency)
        }
        let first = Path.Combine(firstDirectory, "First.dll")
        let second = Path.Combine(secondDirectory, "Second.dll")
        CompileDll(
            source.Replace("\"Foo.g.cs\"", "\"First.g.cs\"").Replace("Greeting =>", "First =>"),
            first,
            "First",
            dependency
        )
        CompileDll(
            source.Replace("\"Foo.g.cs\"", "\"Second.g.cs\"").Replace("Greeting =>", "Second =>"),
            second,
            "Second",
            secondDependency
        )
        let gs = Write("Input.gs", "package App\n@Obsolete\npartial class Foo {}")
        let args = Arguments(gs, first)
        args.Add("/analyzer:$second")
        Run(args, MetadataReferenceCache())
        let generated = GeneratedFiles().Select(File.ReadAllText).ToArray()
        Assert.Equal(2, generated.Length)
        Assert.Contains(generated, (text string) -> text.Contains("1|||on", StringComparison.Ordinal))
        let secondValue = if varyDirectoryCasing && !OperatingSystem.IsWindows() {
            "1|||on"
        } else {
            "2|||on"
        }
        Assert.Contains(
            generated,
            (text string) -> text.Contains("prop Second ", StringComparison.Ordinal) && text.Contains(
                secondValue,
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func LoadFailures_AreReported_WhenNoProjectionOrOutputExists() {
        let gs = Write("Input.gs", "package App\nclass Foo {}")
        let invalid = Write("Invalid.dll", "not an assembly")
        let missing = Path.Combine(directory, "Missing.dll")
        let args = Arguments(gs, invalid)
        args.Add("/analyzer:$missing")
        let stdout = StringWriter()
        Assert.Equal(0, GsgenProgram.Run(args.ToArray(), stdout))
        Assert.Contains("warning GS9203", stdout.ToString())
        Assert.Contains("Invalid.dll", stdout.ToString())
        Assert.Contains("Missing.dll", stdout.ToString())
        Assert.Empty(GeneratedFiles())
    }

    @Fact
    func Worker_RerunsGenerators_AndPreservesConsoleDiagnosticsFailuresAndVersionChanges() {
        let generator = CompileGenerator("v1")
        let gs = Write("Input.gs", "package App\npartial class Foo {}")
        let args = Arguments(gs, generator)
        using let worker = GeneratorWorker(directory)
        let first = worker.Run(args.ToArray())
        Assert.Equal(0, first.ExitCode)
        Assert.False(first.Retire)
        Assert.Contains("warning PROBE5039", first.Stdout)
        Assert.Empty(GeneratedFiles())

        File.WriteAllText(gs, "package App\n@Obsolete\npartial class Foo {}")
        let second = worker.Run(args.ToArray())
        Assert.Equal(0, second.ExitCode)
        Assert.False(second.Retire)
        Assert.Contains("v1|||on", File.ReadAllText(Assert.Single(GeneratedFiles())))

        let failed = worker.Run([]string{"/gs:missing.gs", "/analyzer:$generator", "/out:output"})
        Assert.Equal(1, failed.ExitCode)
        Assert.Contains("error GS9200", failed.Stdout)
        Assert.False(failed.Retire)

        CompileDll(
            GeneratorSource.Replace("__VERSION__", "v2").Replace(
                "var inputs =",
                "System.Console.OutputEncoding = System.Text.Encoding.UTF8; System.Console.WriteLine(\"generator console output\"); System.Console.WriteLine(new string('x', 16383) + \"😀\"); System.Console.Write(\"flush\"); System.Console.Out.Flush(); System.Console.WriteLine(\"-continued\"); var inputs ="
            ),
            generator,
            "Generator"
        )
        let changed = worker.Run(args.ToArray())
        Assert.Equal(0, changed.ExitCode)
        Assert.True(changed.Retire)
        Assert.Contains("generator console output", changed.Stdout)
        Assert.Contains(string.Empty.PadRight(16383, 'x') + "😀", changed.Stdout)
        Assert.Contains("flush-continued", changed.Stdout)
        Assert.Contains("v2|||on", changed.Stdout)
        Assert.Contains("v2|||on", File.ReadAllText(Assert.Single(GeneratedFiles())))
        Assert.True(worker.WaitForExit())
    }

    @Fact
    func Worker_AnalyzerRetainingItsLoadContext_RetiresAfterReturningCompleteOutput() {
        let generator = Path.Combine(directory, "Generator.dll")
        CompileDll(
            GeneratorSource.Replace("__VERSION__", "retained").Replace(
                "var inputs =",
                "System.AppDomain.CurrentDomain.ProcessExit += (s, e) => System.GC.KeepAlive(this); var inputs ="
            ),
            generator,
            "Generator"
        )
        let gs = Write("Input.gs", "package App\n@Obsolete\npartial class Foo {}")
        using let worker = GeneratorWorker(directory)
        let result = worker.Run(Arguments(gs, generator).ToArray())
        Assert.Equal(0, result.ExitCode)
        Assert.Contains("retained|||on", result.Stdout)
        Assert.Contains("retained|||on", File.ReadAllText(Assert.Single(GeneratedFiles())))
        Assert.True(result.Retire, "A retained analyzer context must not enter the next request.")
        Assert.True(worker.WaitForExit())
    }

    @Theory
    @InlineData("stdout")
    @InlineData("stderr")
    @InlineData("encoding")
    @InlineData("finalizer")
    func Worker_ConsoleMutation_DoesNotSuppressTheNextRequestsDiagnostics(mode string) {
        let mutation = if mode == "stdout" {
            "System.Console.SetOut(System.IO.TextWriter.Null); "
        } else if mode == "stderr" {
            "System.Console.SetError(System.IO.TextWriter.Null); "
        } else {
            "System.Console.OutputEncoding = System.Text.Encoding.Unicode; "
        }
        let generatorSource = GeneratorSource.Replace("__VERSION__", "mutated")
        let source = if mode == "finalizer" {
            generatorSource.Replace(
                "public void Initialize",
                "~ProbeGenerator() { System.Console.SetOut(System.IO.TextWriter.Null); } public void Initialize"
            )
        } else {
            generatorSource.Replace("var inputs =", mutation + "var inputs =")
        }
        let generator = Path.Combine(directory, "Generator.dll")
        CompileDll(source, generator, "Generator")
        let gs = Write("Input.gs", "package App\npartial class Foo {}")
        let args = Arguments(gs, generator).ToArray()
        using let worker = GeneratorWorker(directory)
        let first = worker.Run(args)
        Assert.Equal(0, first.ExitCode)
        Assert.True(first.Retire, "A generator that mutates Console state must not poison a reused process.")
        Assert.True(worker.WaitForExit())
        CompileDll(
            GeneratorSource.Replace("__VERSION__", "next").Replace(
                "var inputs =",
                "System.Console.WriteLine(\"next stdout\"); System.Console.Error.WriteLine(\"next stderr\"); var inputs ="
            ),
            generator,
            "Generator"
        )
        using let restarted = GeneratorWorker(directory)
        Assert.NotEqual(worker.ProcessId, restarted.ProcessId)
        let next = restarted.Run(args, allowStderr: true)
        Assert.Equal(0, next.ExitCode)
        Assert.Contains("warning PROBE5039: next|||on", next.Stdout)
        Assert.Contains("next stdout", next.Stdout)
        Assert.Contains("next stderr", next.Stderr)
    }

    @Fact
    func Worker_FinalizerOutput_StaysFramed_InTheRequestEnvironmentAndDirectory() {
        let generator = Path.Combine(directory, "Generator.dll")
        CompileDll(
            GeneratorSource.Replace("__VERSION__", "cleanup").Replace(
                "public void Initialize",
                "~ProbeGenerator() { System.Console.WriteLine(\"cleanup|\" + System.Environment.CurrentDirectory + \"|\" + System.Environment.GetEnvironmentVariable(\"GSHARP_TEST_SCOPE_5039\")); System.Console.Error.WriteLine(\"cleanup-error\"); } public void Initialize"
            ),
            generator,
            "Generator"
        )
        let gs = Write("Input.gs", "package App\n@Obsolete\npartial class Foo {}")
        using let worker = GeneratorWorker(directory, Environment.CurrentDirectory)
        let result = worker.Run(Arguments(gs, generator).ToArray(), allowStderr: true)
        Assert.Equal(0, result.ExitCode)
        Assert.Contains("cleanup|$directory|request-scope", result.Stdout)
        Assert.Contains("cleanup-error", result.Stderr)
    }

    @Fact
    func Worker_CancellationDuringGeneratorExecution_AllowsAFreshHostToRestart() {
        let generator = Path.Combine(directory, "Generator.dll")
        CompileDll(
            GeneratorSource.Replace("__VERSION__", "before").Replace(
                "var inputs =",
                "System.IO.File.WriteAllText(\"started\", \"yes\"); System.Threading.Thread.Sleep(60000); var inputs ="
            ),
            generator,
            "Generator"
        )
        let gs = Write("Input.gs", "package App\n@Obsolete\npartial class Foo {}")
        let args = Arguments(gs, generator)
        {
            using let worker = GeneratorWorker(directory)
            worker.Begin(args.ToArray())
            WaitForGeneratorStart()
            worker.Kill()
            Assert.True(worker.WaitForExit())
        }
        CompileGenerator("after")
        using let restarted = GeneratorWorker(directory)
        let result = restarted.Run(args.ToArray())
        Assert.Equal(0, result.ExitCode)
        Assert.Contains("after|||on", result.Stdout)
        Assert.Contains("after|||on", File.ReadAllText(Assert.Single(GeneratedFiles())))
    }

    @Fact
    func Worker_OwnerDisconnectDuringGeneratorExecution_StopsTheHost() {
        let generator = Path.Combine(directory, "Generator.dll")
        CompileDll(
            GeneratorSource.Replace("__VERSION__", "owner").Replace(
                "var inputs =",
                "System.IO.File.WriteAllText(\"started\", \"yes\"); System.Threading.Thread.Sleep(60000); var inputs ="
            ),
            generator,
            "Generator"
        )
        let gs = Write("Input.gs", "package App\n@Obsolete\npartial class Foo {}")
        using let worker = GeneratorWorker(directory)
        worker.Begin(Arguments(gs, generator).ToArray())
        WaitForGeneratorStart()
        worker.DisconnectOwner()
        Assert.True(worker.WaitForExit(), "A disconnected owner must not leave a blocked generator host alive.")
    }

    @Fact
    func Worker_InheritedHelperOutput_IsFramedAndPreservesBothStreams() {
        let helper = CompileHelper(
            "System.Console.WriteLine(\"helper-output\"); System.Console.Error.WriteLine(\"helper-error\");"
        )
        let generator = Path.Combine(directory, "Generator.dll")
        CompileDll(
            GeneratorSource.Replace("__VERSION__", "helper").Replace(
                "var inputs =",
                "using (var child = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(\"dotnet\") { UseShellExecute = false, ArgumentList = { " +
                    SymbolDisplay.FormatLiteral(helper, true) + " } })) { child.WaitForExit(); } var inputs ="
            ),
            generator,
            "Generator"
        )
        let gs = Write("Input.gs", "package App\n@Obsolete\npartial class Foo {}")
        using let worker = GeneratorWorker(directory)
        for var request = 0; request < 2; request++ {
            let result = worker.Run(Arguments(gs, generator).ToArray(), allowStderr: true)
            Assert.Equal(0, result.ExitCode)
            Assert.Contains("helper-output", result.Stdout)
            Assert.Contains("helper-error", result.Stderr)
            Assert.Contains("helper|||on", result.Stdout)
            Assert.False(result.Retire)
        }
    }

    @Fact
    func Worker_NormalRetirement_StopsGeneratorDescendants() {
        let helper = CompileHelper("System.Threading.Thread.Sleep(60000);")
        let pidFile = Path.Combine(directory, "helper.pid")
        let generator = Path.Combine(directory, "Generator.dll")
        CompileDll(
            GeneratorSource.Replace("__VERSION__", "retire").Replace(
                "var inputs =",
                "using (var child = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(\"dotnet\") { UseShellExecute = false, ArgumentList = { " +
                    SymbolDisplay.FormatLiteral(helper, true) +
                    " } })) { System.IO.File.WriteAllText(" +
                    SymbolDisplay.FormatLiteral(pidFile, true) + ", child.Id.ToString()); } var inputs ="
            ),
            generator,
            "Generator"
        )
        let gs = Write("Input.gs", "package App\n@Obsolete\npartial class Foo {}")
        using let worker = GeneratorWorker(directory)
        try {
            let result = worker.Run(Arguments(gs, generator).ToArray())
            Assert.Equal(0, result.ExitCode)
            Assert.True(File.Exists(pidFile))
            Assert.True(result.Retire)
            Assert.True(worker.WaitForExit())
            if FindHelper(pidFile) is {} child {
                using let owned = child
                Assert.True(owned.WaitForExit(10000), "Normal worker retirement left its helper alive.")
            }
        } finally {
            StopHelper(pidFile)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Worker_InterruptedRequest_StopsGeneratorDescendants(disconnectOwner bool) {
        let helper = CompileHelper("System.Threading.Thread.Sleep(60000);")
        let pidFile = Path.Combine(directory, "helper.pid")
        let generator = Path.Combine(directory, "Generator.dll")
        CompileDll(
            GeneratorSource.Replace("__VERSION__", "blocked").Replace(
                "var inputs =",
                "using (var child = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(\"dotnet\") { UseShellExecute = false, ArgumentList = { " +
                    SymbolDisplay.FormatLiteral(helper, true) +
                    " } })) { System.IO.File.WriteAllText(" +
                    SymbolDisplay.FormatLiteral(pidFile, true) +
                    ", child.Id.ToString()); } System.IO.File.WriteAllText(\"started\", \"yes\"); System.Threading.Thread.Sleep(60000); var inputs ="
            ),
            generator,
            "Generator"
        )
        let gs = Write("Input.gs", "package App\n@Obsolete\npartial class Foo {}")
        using let worker = GeneratorWorker(directory)
        try {
            worker.Begin(Arguments(gs, generator).ToArray())
            WaitForGeneratorStart()
            Assert.True(File.Exists(pidFile))
            if disconnectOwner {
                worker.DisconnectOwner()
            } else {
                worker.Kill()
            }
            Assert.True(worker.WaitForExit())
            if FindHelper(pidFile) is {} child {
                using let owned = child
                Assert.True(owned.WaitForExit(10000), "An interrupted generator request left its helper alive.")
            }
        } finally {
            StopHelper(pidFile)
        }
    }

    private func StopHelper(pidFile string) {
        if FindHelper(pidFile) is {} child {
            using let owned = child
            if !owned.HasExited {
                owned.Kill(entireProcessTree: true)
            }
            owned.WaitForExit()
        }
    }

    private func CompileHelper(body string) string {
        let helper = Path.Combine(directory, "Helper.dll")
        CompileDll(
            "public static class Helper { public static void Main() { " + body + " } }",
            helper,
            "Helper",
            outputKind: OutputKind.ConsoleApplication
        )
        File.Copy(
            Path.ChangeExtension(typeof(GsgenProgram).Assembly.Location, ".runtimeconfig.json"),
            Path.ChangeExtension(helper, ".runtimeconfig.json")
        )
        return helper
    }

    private func FindHelper(pidFile string) Process? {
        if !File.Exists(pidFile) {
            return nil
        }
        try {
            return Process.GetProcessById(int32.Parse(File.ReadAllText(pidFile)))
        } catch (ex ArgumentException) {
            return nil
        }
    }

    private func WaitForGeneratorStart() {
        Assert.True(
            SpinWait.SpinUntil(() -> File.Exists(Path.Combine(directory, "started")), 10000),
            "The generator did not reach its blocked execution point."
        )
    }

    private class GeneratorWorker : IDisposable {
        private let directory string
        private let process Process
        private let writer BinaryWriter
        private let protocol NamedPipeServerStream
        private let stdout WorkerDiagnosticCapture
        private let stderr WorkerDiagnosticCapture
        private let identity string
        private let timeout CancellationTokenSource = CancellationTokenSource(TimeSpan.FromMinutes(2))
        private let cancel CancellationTokenRegistration

        init(directory string, startupDirectory string? = nil) {
            this.directory = directory
            let random = Convert
                .ToBase64String(Guid.NewGuid().ToByteArray())
                .Replace('/', '_')
                .Replace('+', '-')
                .TrimEnd('=')
            let pipeName = if OperatingSystem.IsWindows() {
                "gsharp-" + random
            } else {
                Path.Combine(Path.GetFullPath(Path.GetTempPath()), "p" + random)
            }
            protocol = NamedPipeServerStream(
                pipeName,
                PipeDirection.In,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly
            )
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = startupDirectory ?? directory
            }
            start.ArgumentList.Add(typeof(GsgenProgram).Assembly.Location)
            start.ArgumentList.Add("--generator-worker")
            start.ArgumentList.Add(pipeName)
            process = Process.Start(start) ?? throw InvalidOperationException("Cannot launch generator worker.")
            cancel = timeout.Token.Register(Kill)
            stdout = WorkerDiagnosticCapture(process.StandardOutput, Kill)
            stderr = WorkerDiagnosticCapture(process.StandardError, Kill)
            protocol.WaitForConnectionAsync(timeout.Token).GetAwaiter().GetResult()
            Reader = BinaryReader(protocol, Encoding.UTF8)
            writer = BinaryWriter(process.StandardInput.BaseStream, Encoding.UTF8)
            Assert.Equal(WorkerProtocol.Version, Reader.ReadInt32())
            identity = Reader.ReadString()
        }

        prop Reader BinaryReader {
            get;
        }

        prop ProcessId int32 -> process.Id

        func Begin(arguments[]string) {
            let environment = Dictionary[string, string](StringComparer.Ordinal)
            for entry DictionaryEntry in Environment.GetEnvironmentVariables() {
                environment.Add(cast[string](entry.Key), cast[string](entry.Value))
            }
            environment["GSHARP_TEST_SCOPE_5039"] = "request-scope"
            let fence = "\u001egsharp-" + Guid.NewGuid().ToString("N") + "\u001f"
            stdout.Begin(fence)
            stderr.Begin(fence)
            WorkerProtocol.WriteRequest(writer, identity, directory, arguments, environment, 1, fence)
            Assert.Equal(WorkerProtocol.Accepted, Reader.ReadByte())
        }

        func Run(arguments[]string, allowStderr bool = false)(
            ExitCode int32,
            Stdout string,
            Retire bool,
            Stderr string
        ) {
            Begin(arguments)
            Assert.Equal(WorkerProtocol.Completed, Reader.ReadByte())
            let exitCode = Reader.ReadInt32()
            let retire = Reader.ReadBoolean()
            Reader.ReadInt64()
            Reader.ReadInt64()
            let output = StringBuilder()
            let errors = StringBuilder()
            stdout.Complete(
                timeout.Token,
                (text string) -> {
                    output.AppendLine(text)
                }
            )
            stderr.Complete(
                timeout.Token,
                (text string) -> {
                    Assert.True(allowStderr, "Unexpected worker stderr: " + text)
                    errors.AppendLine(text)
                }
            )
            return (exitCode, output.ToString(), retire, errors.ToString())
        }

        func WaitForExit() bool -> process.WaitForExit(10000)

        func DisconnectOwner() -> writer.Dispose()

        func Kill() {
            if !process.HasExited {
                process.Kill(entireProcessTree: true)
            }
        }

        func Dispose() {
            Kill()
            process.WaitForExit()
            stdout.Dispose()
            stderr.Dispose()
            cancel.Dispose()
            timeout.Dispose()
            writer.Dispose()
            Reader.Dispose()
            protocol.Dispose()
            process.Dispose()
        }
    }

    private func Write(name string, source string) string {
        let path = Path.Combine(directory, name)
        File.WriteAllText(path, source)
        return path
    }

    private func Arguments(gs string, analyzer string) List[string] {
        let args = List[string]{
            "/gs:$gs",
            "/analyzer:$analyzer",
            "/out:${Path.Combine(directory, "output")}",
            "/manifest:${Path.Combine(directory, "manifest")}"
        }
        args.AddRange(References.Select((reference string) -> "/r:$reference"))
        return args
    }

    private func GeneratedFiles()[]string {
        let output = Path.Combine(directory, "output")
        return if Directory.Exists(output) {
            Directory.GetFiles(output, "*.g.gs")
        } else {
            Array.Empty[string]()
        }
    }

    private func Run(args List[string], cache MetadataReferenceCache) string {
        let stdout = StringWriter()
        let exit = GsgenProgram.Run(args.ToArray(), stdout, cache)
        Assert.True(exit == 0, stdout.ToString())
        return stdout.ToString()
    }

    private func CompileGenerator(version string) string {
        let path = Path.Combine(directory, "Generator.dll")
        // C# is the Roslyn analyzer input, not repository implementation source.
        CompileDll(GeneratorSource.Replace("__VERSION__", version), path, "Generator")
        return path
    }

    shared {
        private prop References[]string -> (
            AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty
        ).Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)

        private func CompileDll(
            source string,
            path string,
            name string,
            dependency string? = nil,
            outputKind OutputKind = OutputKind.DynamicallyLinkedLibrary
        ) {
            let references = References.Select(
                (reference string) -> cast[MetadataReference](MetadataReference.CreateFromFile(reference))
            )
                .ToList()
            if dependency != nil {
                references.Add(MetadataReference.CreateFromFile(dependency))
            }
            let compilation = CSharpCompilation.Create(
                name,
                []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(outputKind)
            )
            using let image = MemoryStream()
            let emitted = compilation.Emit(image)
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics))
            File.WriteAllBytes(path, image.ToArray())
        }

        @MethodImpl(MethodImplOptions.NoInlining)
        private func DiscoverContext(path string) WeakReference {
            using let discovery = GeneratorRunner.Discover([]string{path})
            Assert.Empty(discovery.Failures)
            Assert.Single(discovery.Generators)
            // Incremental generators are wrapped by a host-owned Roslyn type.
            let context = Assert.Single(
                AssemblyLoadContext.All.Where(
                    (candidate AssemblyLoadContext) -> candidate.Assemblies.Any(
                        (assembly System.Reflection.Assembly) -> assembly.Location == path
                    )
                )
            )
            Assert.True(context.IsCollectible)
            return WeakReference(context)
        }

        private func Collect() {
            GC.Collect()
            GC.WaitForPendingFinalizers()
            GC.Collect()
        }

        private const GeneratorSource string = `
using System.Linq;
using Microsoft.CodeAnalysis;

[Generator]
public sealed class ProbeGenerator : IIncrementalGenerator
{
    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        var inputs = context.CompilationProvider.Combine(context.AdditionalTextsProvider.Collect())
            .Combine(context.AnalyzerConfigOptionsProvider);
        context.RegisterSourceOutput(inputs, (spc, input) =>
        {
            var compilation = input.Left.Left;
            var files = input.Left.Right;
            input.Right.GlobalOptions.TryGetValue("build_property.Emit", out var option);
            option = option ?? "on";
            var additional = files.IsEmpty ? "" : files[0].GetText().ToString();
            var marker = compilation.GetTypeByMetadataName("Contract.Marker");
            var value = (marker?.GetMembers("Value").FirstOrDefault() as IFieldSymbol)?.ConstantValue as string ?? "";
            var message = "__VERSION__|" + additional + "|" + value + "|" + option;
            spc.ReportDiagnostic(Diagnostic.Create(
                new DiagnosticDescriptor("PROBE5039", "probe", "{0}", "Tests", DiagnosticSeverity.Warning, true),
                Location.None, message));
            var type = compilation.GetTypeByMetadataName("App.Foo");
            if (option != "off" && type != null && type.GetAttributes().Length != 0)
                spc.AddSource("Foo.g.cs", "namespace App { partial class Foo { public string Greeting => \"" + message + "\"; } }");
        });
    }
}
`
    }
}
