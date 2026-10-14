// <copyright file="ReaderAgreementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.ReaderAgreement

import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit
import Xunit.Abstractions
import Xunit.Sdk

/// ADR-0193 §4, one corpus per test class so xunit runs the corpora in
/// parallel. The whole namespace is its own CI shard
/// (`build/generate-ci-test-matrix.py`, band `reader-agreement`).
abstract class ReaderAgreementTestBase {
    private let output ITestOutputHelper

    /// Initializes a new instance of the (cref:ReaderAgreementTestBase) class.
    /// @param output The xunit output sink.
    protected init(output ITestOutputHelper) {
        this.output = output
    }

    /// Runs the differential over [`corpus`](paramref) and fails on any
    /// disagreement the allowlist does not excuse.
    /// @param corpusName The corpus name for the report.
    /// @param resolver The resolver whose metadata context loaded the corpus.
    /// @param corpus The assemblies to walk.
    protected func AssertReadersAgree(corpusName string, resolver ReferenceResolver, corpus IReadOnlyList[Assembly]) {
        Assert.NotEmpty(corpus)
        let harness = ReaderAgreementHarness(resolver, corpusName)
        let summary = harness.Run(corpus)
        this.output.WriteLine(summary)
        let excused = harness.Disagreements.Where(ReaderAgreementAllowlist.IsExcused).ToList()
        let unexcused = harness
            .Disagreements
            .Where((d ReaderAgreementHarness.Disagreement) -> !ReaderAgreementAllowlist.IsExcused(d))
            .ToList()
        this.output.WriteLine("excused by the allowlist: ${excused.Count}")
        for entry in ReaderAgreementAllowlist.Entries {
            this.output.WriteLine(
                "  ${string.Join("+", entry.Readers)} [${entry.Tag ?? "any position"}] (${entry.Issue}): " +
                    excused
                    .Count(
                    (d ReaderAgreementHarness.Disagreement) -> (entry.Tag == nil || d.Tags.Contains(entry.Tag)) &&
                        d
                        .Results
                        .Any((r ReaderAgreementHarness.ReaderResult) -> entry.Readers.Contains(r.Reader))
                )
                    .ToString()
            )
        }
        if unexcused.Count > 0 {
            ReaderAgreementHarness.Report(this.output, unexcused)
        }
        // Triage affordance: `GSHARP_READER_AGREEMENT_DUMP=<dir>` writes every
        // unexcused disagreement as one tab-separated line per position.
        if Environment.GetEnvironmentVariable("GSHARP_READER_AGREEMENT_DUMP") is {Length: > 0} dumpDirectory {
            Directory.CreateDirectory(dumpDirectory)
            File.WriteAllLines(
                Path.Combine(dumpDirectory, corpusName + ".tsv"),
                unexcused.Select(
                    (d ReaderAgreementHarness.Disagreement) -> string.Join(
                        '\t',
                        d.Corpus,
                        d.Member,
                        d.PositionName,
                        d.Argument,
                        string.Join("+", d.Dissenters),
                        d.OpenPositionType.ToString(),
                        string.Join(
                            " ; ",
                            d.Results.Select(
                                (r ReaderAgreementHarness.ReaderResult) -> "${r.Reader}=${r.Shape} (${r.Display})"
                            )
                        )
                    )
                )
            )
        }
        Assert.True(harness.PositionsCompared > 0, "the corpus produced no positions: $summary")
        Assert.True(
            harness.EnumerationErrorCount == 0,
            "${harness.EnumerationErrorCount} corpus enumeration error(s) shrank the corpus: $summary"
        )
        Assert.True(
            harness.ReaderExceptionCount == 0,
            "${harness.ReaderExceptionCount} reader call(s) threw; see the summary line: $summary"
        )
        Assert.True(
            unexcused.Count == 0,
            "${unexcused.Count} reader disagreement(s) not on the allowlist; first: ${unexcused.FirstOrDefault()}"
        )
    }

    shared {
        /// Returns the resolver's assemblies that were loaded from [`paths`](paramref).
        /// @param resolver The resolver.
        /// @param paths The corpus's own paths.
        /// @returns The corpus assemblies.
        protected func LoadedFrom(resolver ReferenceResolver, paths IEnumerable[string]) IReadOnlyList[Assembly] {
            let names = HashSet[string](
                paths.Select((p string) -> Path.GetFileNameWithoutExtension(p)),
                StringComparer.OrdinalIgnoreCase
            )
            return resolver
                .Assemblies
                .Where((a Assembly) -> names.Contains(a.GetName().Name ?? string.Empty))
                .OrderBy((a Assembly) -> a.GetName().Name, StringComparer.Ordinal)
                .ToList()
        }
    }
}

/// ADR-0193 §4: the reference BCL — the targeting pack gsc resolves.
class BclReaderAgreementTests : ReaderAgreementTestBase {
    /// Initializes a new instance of the (cref:BclReaderAgreementTests) class.
    /// @param output The xunit output sink.
    init(output ITestOutputHelper) : base(output) { }

    /// Every public generic declaration of the `Microsoft.NETCore.App.Ref` targeting pack.
    @Fact
    func Readers_Agree_Over_The_Reference_Bcl() {
        let refDirectory = LocateRefPack()
        let paths = Directory.EnumerateFiles(refDirectory, "*.dll").ToList()
        using let resolver = ReferenceResolver.WithReferences(paths)
        this.AssertReadersAgree("bcl", resolver, ReaderAgreementTestBase.LoadedFrom(resolver, paths))
    }

    shared {
        private func LocateRefPack() string {
            let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location) ??
                throw XunitException("prerequisite missing: host runtime directory")
            let dotnetRoot = Directory
                .GetParent(runtimeDirectory)
                ?.Parent
                ?.Parent
                ?.FullName ??
                throw XunitException("prerequisite missing: dotnet root")
            let packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
            let tfm = "net${Environment.Version.Major}.0"
            let exact = Path.Combine(packsRoot, Environment.Version.ToString(3), "ref", tfm)
            if Directory.Exists(exact) {
                return exact
            }
            return if Directory.Exists(packsRoot) {
                Directory
                    .EnumerateDirectories(packsRoot, Environment.Version.Major.ToString() + ".*")
                    .OrderByDescending((d string) -> d, StringComparer.Ordinal)
                    .Select((d string) -> Path.Combine(d, "ref", tfm))
                    .FirstOrDefault(Directory.Exists) ??
                    throw XunitException("prerequisite missing: no $tfm ref pack under '$packsRoot'")
            } else {
                throw XunitException("prerequisite missing: '$packsRoot'")
                default(string)
            }
        }
    }
}

/// ADR-0193 §4: an unannotated netstandard2.0 assembly — no nullable metadata
/// at all, the #4361 shape.
class NetStandardReaderAgreementTests : ReaderAgreementTestBase {
    /// Initializes a new instance of the (cref:NetStandardReaderAgreementTests) class.
    /// @param output The xunit output sink.
    init(output ITestOutputHelper) : base(output) { }

    /// `netstandard.dll` from `NETStandard.Library` 2.0.3.
    @Fact
    func Readers_Agree_Over_NetStandard20() {
        let refDirectory = typeof(NetStandardReaderAgreementTests)
            .Assembly
            .GetCustomAttributes[AssemblyMetadataAttribute]()
            .Single((attribute AssemblyMetadataAttribute) -> attribute.Key == "NetStandard20ReferenceDirectory")
            .Value ??
            throw XunitException("prerequisite missing: NetStandard20ReferenceDirectory")
        Assert.True(Directory.Exists(refDirectory), "prerequisite missing: '$refDirectory'")
        let paths = Directory.EnumerateFiles(refDirectory, "*.dll").ToList()
        using let resolver = ReferenceResolver.WithReferences(paths)
        this.AssertReadersAgree(
            "netstandard2.0",
            resolver,
            ReaderAgreementTestBase.LoadedFrom(
                resolver,
                paths.Where((p string) -> Path.GetFileName(p) == "netstandard.dll")
            )
        )
    }
}

/// ADR-0193 §4: FsCheck, an unannotated F# library (a #4361 witness).
class FsCheckReaderAgreementTests : ReaderAgreementTestBase {
    /// Initializes a new instance of the (cref:FsCheckReaderAgreementTests) class.
    /// @param output The xunit output sink.
    init(output ITestOutputHelper) : base(output) { }

    /// The FsCheck assembly the test project references.
    @Fact
    func Readers_Agree_Over_FsCheck() {
        let fsCheck = Path.Combine(AppContext.BaseDirectory, "FsCheck.dll")
        let fsharpCore = Path.Combine(AppContext.BaseDirectory, "FSharp.Core.dll")
        Assert.True(File.Exists(fsCheck), "prerequisite missing: '$fsCheck'")
        using let resolver = ReferenceResolver.WithReferences([]string{fsCheck, fsharpCore})
        this.AssertReadersAgree("FsCheck", resolver, ReaderAgreementTestBase.LoadedFrom(resolver, []string{fsCheck}))
    }
}

/// ADR-0193 §4: a csc-compiled fixture exercising every open-slot state
/// (`[Nullable(2)]`, not-annotated, oblivious explicit and absent),
/// constraints, arrays, tuples, value-type generics and generic methods.
/// Emitted by `csc` at test time, as `aac0c452b` did for the #4361
/// reader test, so it stays C# metadata when the suite is self-migrated.
class CscFixtureReaderAgreementTests : ReaderAgreementTestBase, IDisposable {
    private let directory string

    /// Initializes a new instance of the (cref:CscFixtureReaderAgreementTests) class.
    /// @param output The xunit output sink.
    init(output ITestOutputHelper) : base(output) {
        this.directory = Path.Combine(
            AppContext.BaseDirectory,
            "CscFixtureReaderAgreementTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(this.directory)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        try {
            Directory.Delete(this.directory, recursive: true)
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    /// The csc-emitted fixture library.
    @Fact
    func Readers_Agree_Over_The_Csc_Fixture() {
        let path = this.EmitFixture()
        using let resolver = ReferenceResolver.WithReferences([]string{path})
        this.AssertReadersAgree("csc-fixture", resolver, ReaderAgreementTestBase.LoadedFrom(resolver, []string{path}))
    }

    private func EmitFixture() string {
        let references = (
            (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                Array.Empty[string]()
        )
            .Where(File.Exists).Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
        let compilation = CSharpCompilation.Create(
            CscFixtureReaderAgreementTests.AssemblyName,
            []SyntaxTree{CSharpSyntaxTree.ParseText(Source, CSharpParseOptions(LanguageVersion.Latest))},
            references,
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let path = Path.Combine(this.directory, CscFixtureReaderAgreementTests.AssemblyName + ".dll")
        {
            using let stream = File.Create(path)
            let emit = compilation.Emit(stream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        }
        return path
    }

    shared {
        private const AssemblyName string = "ReaderAgreementFixture"

        private const Source string = `using System;
using System.Collections.Generic;

#nullable enable
namespace ReaderAgreement.Fixture
{
    public class Annotated<T>
    {
        public T? MaybeDefault() => default;
        public T Get() => default;
        public void Set(T value) { }
        public void SetMaybe(T? value) { }
        public List<T?> Nulls = new();
        public List<T> NonNulls = new();
        public Dictionary<string, T>? Map;
        public Dictionary<T, string?> Keys = new();
        public T[]? Array;
        public T?[] ArrayOfMaybe = System.Array.Empty<T?>();
        public (T, string?) Tuple;
        public KeyValuePair<T, string?> Pair;
        public Func<T?, string> Projection = _ => "";
        public T this[int index] => default;
        public List<List<T>> Nested = new();
        public U? Convert<U>(T value) where U : class => null;
        public U? Pick<U>(IEnumerable<U> source) => default;
        public IEnumerable<U> Many<U>(Func<T, U> selector) => System.Array.Empty<U>();
        public void Out(out T? value) { value = default; }
        public ref T Ref() => throw new InvalidOperationException();
        public event Action<T?>? Changed;
        public static event Action<T>? StaticChanged;
        internal void Raise() { Changed?.Invoke(default); StaticChanged?.Invoke(default); }
    }

    public class Constrained<TClass, TStruct>
        where TClass : class
        where TStruct : struct
    {
        public TClass? MaybeClass;
        public TStruct? MaybeStruct;
        public List<TClass?> Classes = new();
        public TStruct Value;
    }

    public class Mixed<T>
    {
#nullable disable
        public T ObliviousField;
        public List<T> ObliviousList;
        public string ObliviousString;
        public T ObliviousMethod(List<T> items) => default;
#nullable enable
        public T NonNullField = default;
        public T? AnnotatedField;
    }

    public static class Statics
    {
        public static T? FirstOrNothing<T>(IEnumerable<T> source) => default;
        public static T Identity<T>(T value) => value;
        public static List<T?> Wrap<T>(T value) => new() { value };
        public static T[] Repeat<T>(T value, int count) => System.Array.Empty<T>();
        public static Dictionary<TKey, TValue?> Index<TKey, TValue>(IEnumerable<TValue> values) where TKey : notnull => new();
    }
}
#nullable disable
namespace ReaderAgreement.Fixture.Oblivious
{
    public class Box<T>
    {
        public T Value;
        public T Get() => default;
        public List<T> Items = new List<T>();
        public T[] Array;
        public Dictionary<string, T> Map;
        public string Name;
        public (T, string) Tuple;
        public static event Action<T> StaticChanged;
        internal static void Raise() { StaticChanged?.Invoke(default); }
    }

    public class DerivedBox<T> : Box<T>
    {
        public T Other;
    }

    public class ArraySurface<T>
    {
        public string[] Field;
        public string[] Property { get; set; }
        public string[] Return() => null;
        public void Parameter(string[] value) { }
        public string[] this[string[] key] => null;
        public string[,] Grid;
        public int[] Values;
        public ref string[] RefReturn() => throw null;
        public void RefParameter(ref string[] value) { }
        public T Marker;
    }

    public static class Statics
    {
        public static T Identity<T>(T value) => value;
        public static List<T> Empty<T>() => new List<T>();
        public static T[] FindAll<T>(T[] values, Predicate<T> match) => values;
    }
}`
    }
}

/// The harness's own guard: a corpus hole is an error, not a skip. A generic
/// whose constraint names a type from an assembly the resolver was not given
/// cannot be closed or read by any reader; that must surface as an
/// enumeration error rather than a silently skipped closing.
class ReaderAgreementHarnessGuardTests : IDisposable {
    private let directory string

    /// Initializes a new instance of the (cref:ReaderAgreementHarnessGuardTests) class.
    init() {
        this.directory = Path.Combine(
            AppContext.BaseDirectory,
            "ReaderAgreementHarnessGuardTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(this.directory)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        try {
            Directory.Delete(this.directory, recursive: true)
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    /// An unresolvable constraint type trips the enumeration-error guard.
    @Fact
    func An_Unresolvable_Constraint_Type_Is_An_Enumeration_Error() {
        let basePath = this.Emit("GuardBase", "namespace Guard { public class Base { } }", Array.Empty[string]())
        let genericPath = this.Emit(
            "GuardGeneric",
            "namespace Guard { public class Gen<T> where T : Base { public T Value; public T Get() => Value; } }",
            []string{basePath}
        )
        // Only the generic's own assembly: `Base` cannot be resolved.
        using let resolver = ReferenceResolver.WithReferences([]string{genericPath})
        let corpus = resolver.Assemblies.Where((a Assembly) -> a.GetName().Name == "GuardGeneric").ToList()
        Assert.NotEmpty(corpus)
        let harness = ReaderAgreementHarness(resolver, "guard")
        harness.Run(corpus)
        Assert.True(harness.EnumerationErrorCount > 0, "an unresolvable constraint must count as an enumeration error")
    }

    private func Emit(assemblyName string, source string, extraReferences[]string) string {
        let references = (
            (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                Array.Empty[string]()
        )
            .Where(File.Exists)
            .Concat(extraReferences)
            .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
        let compilation = CSharpCompilation.Create(
            assemblyName,
            []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
            references,
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let path = Path.Combine(this.directory, assemblyName + ".dll")
        {
            using let stream = File.Create(path)
            let emit = compilation.Emit(stream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        }
        return path
    }
}
