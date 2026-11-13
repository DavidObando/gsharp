// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import System.Text.Json
import System.Text.RegularExpressions
import Xunit

class Issue5581ExpandedParamsNullElementsTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func SameRunReferencePacking_UsesTheEmittedElementContract(inferred bool) {
        let calls = if inferred {
            `Counter.Generic(null!, "x") + "|" + Counter.Generic("x") + "|" +
            Counter.Generic(null!, Pick(1), Pick(2)) + "|" +
            Counter.Nullable(null, "x") + "|" + Counter.Strict("ok") + "|" + trace`
        } else {
            `Counter.Count(null!, "x") + "|" + Counter.CountE(null!, "x") + "|" +
            Counter.CountA(null!, "x") + "|" + Counter.Count() + "|" +
            Counter.Count("x") + "|" + Counter.Count(null!, Pick(1), Pick(2)) + "|" +
            Counter.Nullable(null, "x") + "|" + Counter.Strict("ok") + "|" +
            Counter.Count(new List<string?> { null, "x" }) + "|" + trace`
        }
        let source = `
#nullable enable
using System.Collections.Generic;
namespace Demo {
    public static class P {
        static int trace;
        static string Pick(int n) { trace = trace * 10 + n; return "x"; }
        public static void Main() => System.Console.Write(` + calls + `);
    }
}
`
        let expected = if inferred {
            "2|1|3|2|2|12"
        } else {
            "2|2|2|0|1|3|2|2|2|12"
        }
        WithTranslation(
            source,
            (directory string, printed string, compiled ProcessRunResult) -> {
                let library = Path.Combine(directory, "Library.dll")
                AssertSuccessfulTarget(directory, compiled, expected, library)
                AssertStrictIl(library)
                let compact = Regex.Replace(printed, `\s+`, string.Empty)
                Assert.Contains("Counter.Strict(List[string]{\"ok\"})", compact)
                Assert.Contains("Counter.Nullable(cast[IEnumerable[string?]](List[string?]{nil,\"x\"}))", compact)
                Assert.DoesNotContain("!!", printed)
                let contract = CSharpCompilation.Create(
                    "ContractProbe",
                    references: CSharpProjectLoader.RuntimeReferences().Concat(
                        []MetadataReference{
                            MetadataReference.CreateFromFile(Path.Combine(directory, "Library.ref.dll"))
                        }
                    )
                )
                    .GetTypeByMetadataName("Demo.Counter")!!
                let strict = cast[INamedTypeSymbol](
                    cast[IMethodSymbol](contract.GetMembers("Strict").Single()).Parameters[0].Type
                )
                Assert.Equal(NullableAnnotation.NotAnnotated, strict.TypeArguments[0].NullableAnnotation)
                if inferred {
                    Assert.Contains("Counter.Generic(List[string?]{default(string),\"x\"})", compact)
                } else {
                    for name in[]string{"Count", "CountE", "CountA"} {
                        let parameter = cast[IMethodSymbol](contract.GetMembers(name).Single()).Parameters[0]
                        Assert.Equal(NullableAnnotation.NotAnnotated, parameter.Type.NullableAnnotation)
                        let element = if parameter.Type is IArrayTypeSymbol array {
                            array.ElementType
                        } else {
                            cast[INamedTypeSymbol](parameter.Type).TypeArguments[0]
                        }
                        Assert.Equal(NullableAnnotation.Annotated, element.NullableAnnotation)
                    }
                    Assert.Contains("Counter.Count(List[string?]{nil,\"x\"})", compact)
                    Assert.Contains("Counter.Count(List[string?]())", compact)
                    Assert.Contains("Counter.Count(List[string?]{\"x\"})", compact)
                }
            },
            expected,
            `
#nullable enable
using System.Collections.Generic;
using System.Linq;
namespace Demo {
    public static class Counter {
        public static int Count(params List<string> items) => items.Count;
        public static int CountE(params IEnumerable<string> items) => items.Count();
        public static int CountA(params string[] items) => items.Length;
        public static int Generic<T>(params List<T> items) => items.Count;
        public static int Nullable(params IEnumerable<string?> items) => items.Count();
        public static int Strict(params List<string> items) => items[0].Length;
    }
}
`
        )
    }

    @Fact
    func ExpandedNullElements_PreserveTheIssueOutputThroughThePublicDrivers() {
        WithTranslation(`
#nullable enable
using System.Collections.Generic;
using System.Linq;
namespace Demo {
    public static class P {
        public static int Count(params List<string> items) => items.Count;
        public static int Forward(string value) => Count(value);
        public static int CountE(params IEnumerable<string> items) => items.Count();
        public static int ForwardE(string value) => CountE(value);
        public static string Run() => Forward(null!) + " " + ForwardE(null!);
        public static void Main() => System.Console.Write(Run());
    }
}
`, (
                directory string,
                printed string,
                compiled ProcessRunResult
            ) -> {
                AssertSuccessfulTarget(
                    directory,
                    compiled,
                    "1 1"
                )
                Assert.Contains(
                    "items ...List[string?]",
                    printed
                )
                Assert.Contains(
                    "items ...IEnumerable[string?]",
                    printed
                )
                Assert.Contains(
                    "Forward(value string?)",
                    printed
                )
                Assert.Contains(
                    "ForwardE(value string?)",
                    printed
                )
                Assert.DoesNotContain(
                    "!!",
                    printed
                )
            }, "1 1")
    }

    @Fact
    func ElementContracts_KeepCardinalityForwardingOrderAndNormalFormSeparate() {
        WithTranslation(`
#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
public class Bag<T> : List<string?> { }
public static class P {
    static int trace;
    static int Count(params List<string> items) => items.Count;
    static int CountE(params IEnumerable<string> items) => Enumerable.Count(items);
    static int CountA(params string[] items) => items.Length;
    static int CountR(params IReadOnlyList<string> items) => items.Count;
    static int Forward(string value) => Count("x", value, value);
    static int ForwardE(string value) => CountE(value);
    static int ForwardA(string value) => CountA(value);
    static int ForwardR(string value) => CountR(value);
    static int Relay(params List<string> items) => Count(items);
    static int ForwardRelay(string value) => Relay(value);
    static int Recursive(int depth, params IEnumerable<string> items) =>
        depth == 0 ? items.Count() : Recursive(depth - 1, items);
    static int ForwardRecursive(string value) => Recursive(2, value);
    static int Normal(params List<string> items) => items.Count;
    static int Nullable(params List<string?> items) => items.Count;
    static int Nonnull(params List<string> items) => items.Count;
    static string? Pick(int digit) { trace = trace * 10 + digit; return digit == 2 ? null : "x"; }
    public static void Main() {
        Console.Write(Count() + " " + Count("a", "b") + " " + Forward(null!) + " " +
            ForwardE(null!) + " " + ForwardA(null!) + " " + ForwardRelay(null!) + " " +
            ForwardRecursive(null!) + " " + Normal(new List<string> { "x" }) + " " +
            Nullable(null, "x") + " " + Nonnull("x") + " " + Count(Pick(1)!, Pick(2)!, Pick(3)!) + " " +
            Count(new List<string?> { null, "x" }) + " " + CountA(new string?[] { null }) + " " + ForwardR(null!) +
            " " + Count(new Bag<int>()));
        _ = Count(Pick(4)!);
        Console.Write("|" + trace);
    }
}
`, (
                directory string,
                printed string,
                compiled ProcessRunResult
            ) -> {
                AssertSuccessfulTarget(
                    directory,
                    compiled,
                    "0 2 3 1 1 1 1 1 2 1 3 2 1 1 0|1234"
                )
                Assert.Contains(
                    "CountA(items ...string?)",
                    printed
                )
                Assert.Contains(
                    "Relay(items ...List[string?])",
                    printed
                )
                Assert.Contains(
                    "Recursive(depth int32, items ...IEnumerable[string?])",
                    printed
                )
                Assert.Contains(
                    "Normal(items ...List[string])",
                    printed
                )
                Assert.Contains(
                    "Nonnull(items ...List[string])",
                    printed
                )
                Assert.DoesNotContain(
                    "Pick(2)!!",
                    printed
                )
            }, "0 2 3 1 1 1 1 1 2 1 3 2 1 1 0|1234")
    }

    @Fact
    func NullableImportedParamsCarrier_PreservesWholeCollectionNullForwarding() {
        WithTranslation(`
#nullable enable
using System;
public class Node { public int Value = 7; }
public static class P {
    static object Make(object?[] args) => Activator.CreateInstance(typeof(Node), args)!;
    public static void Main() => Console.Write(((Node)Make(null!)).Value);
}
`, (
                directory string,
                printed string,
                compiled ProcessRunResult
            ) -> {
                AssertSuccessfulTarget(
                    directory,
                    compiled,
                    "7"
                )
                Assert.Contains(
                    "Make(nil)",
                    printed
                )
                Assert.DoesNotContain(
                    "args!!",
                    printed
                )
            }, "7")
    }

    @Fact
    func UnsafeReadsAndUnchangedCollectionIdentities_KeepAuthoredNilRejected() {
        WithTranslation(`
#nullable enable
using System;
using System.Collections.Generic;
public static class P {
    static int Open(params List<string> items) => items.Count;
    static int ForwardOpen(string value) => Open(value);
    static int Read(params List<string> items) => items[0].Length;
    static int ForwardRead(string value) => Read(value);
    static int Escape(params List<string> items) { GC.KeepAlive(items); return 0; }
    static int ForwardEscape(string value) => Escape(value);
    static T Id<T>(T value) => value;
    static int Generic(params List<string> items) => Id(items).Count;
    static int ForwardGeneric(string value) => Generic(value);
    static int OpenGeneric<T>(params List<T> items) => items.Count;
    static int ForwardOpenGeneric(string value) => OpenGeneric<string>(value);
    static int Mixed(params List<string> items) => items.Count;
    static int ForwardMixed(string value) => Mixed(value);
    static int Normal() => Mixed(new List<string> { "x" });
    static int Collection(params List<string> items) => items.Count;
    static int ForwardCollection(List<string> value) => Collection(value);
    static int Reassigned(params List<string> items) { items = new List<string> { "x" }; return items.Count; }
    static int ForwardReassigned(string value) => Reassigned(value);
    static int Explicit(params IEnumerable<string> items) => System.Linq.Enumerable.Count<string>(items);
    static int ForwardExplicit(string value) => Explicit(value);
    static int Carrier(params List<string> items) => items.Count;
    static int ForwardCarrier(string value) => Carrier(value);
    static int NormalCarrier() => Carrier(new Bag<string?>());
    public static void Main() {
        ForwardOpen(null!);
        ForwardRead(null!);
        ForwardEscape(null!);
        ForwardGeneric(null!);
        ForwardOpenGeneric(null!);
        ForwardMixed(null!);
        ForwardCollection(null!);
        ForwardReassigned(null!);
        ForwardExplicit(null!);
        ForwardCarrier(null!);
    }
}
public class Bag<T> : List<string> { }
`, (
                directory string,
                printed string,
                compiled ProcessRunResult
            ) -> {
                Assert.False(
                    compiled.TimedOut,
                    compiled.Output
                )
                Assert.NotEqual(
                    0,
                    compiled.ExitCode
                )
                Assert.False(
                    File.Exists(Path.Combine(directory, "Target.dll"))
                )
                let diagnostics = Regex
                    .Matches(compiled.Output, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`)
                    .Select(
                    (match_ Match) -> string.Join(
                        ",",
                        Enumerable.Range(1, 5).Select((index int32) -> match_.Groups[index].Value)
                    )
                )
                    .ToArray()
                let expected = []string{
                    "ForwardRead",
                    "ForwardEscape",
                    "ForwardGeneric",
                    "ForwardOpenGeneric",
                    "ForwardMixed",
                    "ForwardCollection",
                    "ForwardReassigned",
                    "ForwardExplicit",
                    "ForwardCarrier"
                }
                    .Select((method string) -> NilRange(printed, method))
                    .ToArray()
                Assert.NotEmpty(
                    diagnostics
                )
                Assert.Equal(
                    expected,
                    diagnostics
                )
                Assert.Contains(
                    "Open(items ...List[string?])",
                    printed
                )
                Assert.Contains(
                    "Read(items ...List[string])",
                    printed
                )
                Assert.Contains(
                    "Mixed(items ...List[string])",
                    printed
                )
            })
    }

    shared {
        internal func WithTranslation(
            source string,
            verify Action[string, string, ProcessRunResult],
            nativeExpected string? = nil,
            librarySource string? = nil,
            referenceTypeName string = "Demo.Counter",
            referenceMemberName string = "Count"
        ) {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue-5581", Guid.NewGuid().ToString("N"))
            let native = Path.Combine(directory, "native")
            Directory.CreateDirectory(native)
            try {
                GsharpTestProjectRunner.WriteIsolationBoundary(native)
                let app = if librarySource == nil {
                    native
                } else {
                    Path.Combine(native, "App")
                }
                Directory.CreateDirectory(app)
                if librarySource != nil {
                    let library = Path.Combine(native, "Library")
                    Directory.CreateDirectory(library)
                    File.WriteAllText(Path.Combine(library, "Library.cs"), librarySource)
                    File.WriteAllText(
                        Path.Combine(library, "Library.csproj"),
                        `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>`
                    )
                }
                File.WriteAllText(Path.Combine(app, "Probe.cs"), source)
                let reference = if librarySource == nil {
                    string.Empty
                } else {
                    `<ItemGroup><ProjectReference Include="../Library/Library.csproj" /></ItemGroup>`
                }
                File.WriteAllText(
                    Path.Combine(app, "Probe.csproj"),
                    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><Nullable>enable</Nullable></PropertyGroup>` +
                        reference +
                        `</Project>`
                )
                AssertProcess(ProcessRunner.Run("git", []string{"init", "--quiet"}, native))
                let nativeBuild = ProcessRunner.Run(
                    "dotnet",
                    []string{"build", "Probe.csproj", "-c", "Release", "--nologo"},
                    app
                )
                AssertProcess(nativeBuild)
                if nativeExpected != nil {
                    AssertOutput(
                        ProcessRunner.Run(
                            "dotnet",
                            []string{Path.Combine(app, "bin", "Release", "net10.0", "Probe.dll")}
                        ),
                        nativeExpected
                    )
                }
                if librarySource != nil {
                    let loaded = CSharpProjectLoader
                        .LoadProjectAsync(Path.Combine(app, "Probe.csproj"), configuration: "Release")
                        .GetAwaiter()
                        .GetResult()
                    let counter = loaded.Compilation.GetTypeByMetadataName(referenceTypeName)!!
                    Assert.Empty(counter.GetMembers(referenceMemberName).Single().DeclaringSyntaxReferences)
                    let reference = loaded
                        .Compilation
                        .References
                        .OfType[PortableExecutableReference]()
                        .Single(
                        (candidate PortableExecutableReference) ->
                        loaded.Compilation.GetAssemblyOrModuleSymbol(candidate)?.Name == "Library"
                    )
                    Assert.EndsWith(Path.Combine("ref", "Library.dll"), reference.FilePath)
                    let tree = loaded
                        .Compilation
                        .SyntaxTrees
                        .Single((candidate SyntaxTree) -> Path.GetFileName(candidate.FilePath) == "Probe.cs")
                    let model = loaded.Compilation.GetSemanticModel(tree)
                    for call in tree.GetRoot().DescendantNodes().OfType[InvocationExpressionSyntax]() {
                        if model.GetSymbolInfo(call).Symbol is IMethodSymbol{Name: "Generic"} generic {
                            Assert.Empty(generic.DeclaringSyntaxReferences)
                            Assert.Equal(NullableAnnotation.NotAnnotated, generic.TypeArguments[0].NullableAnnotation)
                        }
                    }
                }
                let compiler = GscInvoker.Resolve(nil, "Release", AppContext.BaseDirectory)
                Assert.NotNull(compiler)
                using let global = JsonDocument.Parse(
                    File.ReadAllText(Path.Combine(IlVerifyRunner().RepoRoot, "global.json"))
                )
                let sdk = global.RootElement.GetProperty("msbuild-sdks").GetProperty("Gsharp.NET.Sdk").GetString()
                let translated = Path.Combine(directory, "translated")
                AssertProcess(
                    ProcessRunner.Run(
                        "dotnet",
                        []string{
                            typeof(Cs2Gs.Cli.Program).Assembly.Location,
                            "migrate",
                            "--corpus",
                            native,
                            "--out",
                            translated,
                            "--artifacts",
                            Path.Combine(directory, "artifacts"),
                            "--sdk-version",
                            sdk!!,
                            "--sdk-pin",
                            "global-json",
                            "--translate-only",
                            "--gsc",
                            compiler!!
                        },
                        native
                    )
                )
                let compileArguments = List[string]{
                    compiler!!,
                    "/target:exe",
                    "/out:" + Path.Combine(directory, "Target.dll")
                }
                if librarySource != nil {
                    let library = Path.Combine(directory, "Library.dll")
                    let reference = Path.Combine(directory, "Library.ref.dll")
                    AssertProcess(
                        ProcessRunner.Run(
                            "dotnet",
                            []string{
                                compiler!!,
                                "/target:library",
                                "/assemblyname:Library",
                                "/out:" + library,
                                "/refout:" + reference,
                                Path.Combine(translated, "Library", "Library.gs")
                            }
                        )
                    )
                    compileArguments.Add("/reference:" + reference)
                }
                let gs = if librarySource == nil {
                    Path.Combine(translated, "Probe.gs")
                } else {
                    Path.Combine(translated, "App", "Probe.gs")
                }
                compileArguments.Add(gs)
                let compiled = ProcessRunner.Run("dotnet", compileArguments)
                verify(directory, File.ReadAllText(gs), compiled)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        internal func AssertSuccessfulTarget(
            directory string,
            compiled ProcessRunResult,
            expected string,
            references ...string
        ) {
            AssertProcess(compiled)
            Assert.DoesNotContain(": warning ", compiled.Output)
            let assembly = Path.Combine(directory, "Target.dll")
            AssertOutput(ProcessRunner.Run("dotnet", []string{assembly}), expected)
            AssertStrictIl(assembly, references)
        }

        internal func AssertStrictIl(assembly string, additionalReferences ...string) {
            let arguments = List[string]{"tool", "run", "ilverify", assembly, "-s", "System.Private.CoreLib"}
            let references = Directory.EnumerateFiles(
                Path.GetDirectoryName(typeof(object).Assembly.Location)!!,
                "*.dll"
            )
                .ToArray()
            Assert.NotEmpty(references)
            for reference in references.Concat(additionalReferences) {
                arguments.Add("-r")
                arguments.Add(reference)
            }
            AssertProcess(ProcessRunner.Run("dotnet", arguments, IlVerifyRunner().RepoRoot))
        }

        private func AssertOutput(result ProcessRunResult, expected string) {
            AssertProcess(result)
            Assert.Equal(string.Empty, result.Stderr)
            Assert.Equal(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(result.Stdout))
        }

        private func AssertProcess(result ProcessRunResult) {
            Assert.False(result.TimedOut, result.Output)
            Assert.True(result.ExitCode == 0, result.Output)
        }

        private func NilRange(printed string, method string) string {
            let call = method + "(nil)"
            let start = printed.IndexOf(call, StringComparison.Ordinal)
            Assert.True(start >= 0, printed)
            let offset = start + method.Length + 1
            let before = printed.Substring(0, offset)
            let line = before.Count((value char) -> value == '\n') + 1
            let column = offset - before.LastIndexOf('\n')
            return "$line,$column,$line,${column + 3},GS0154"
        }
    }
}
