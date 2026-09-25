// <copyright file="ReaderAgreementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Core.Tests.ReaderAgreement;

/// <summary>
/// ADR-0193 §4, one corpus per test class so xunit runs the corpora in
/// parallel. The whole namespace is its own CI shard
/// (<c>build/generate-ci-test-matrix.py</c>, band <c>reader-agreement</c>).
/// </summary>
public abstract class ReaderAgreementTestBase
{
    private readonly ITestOutputHelper output;

    /// <summary>Initializes a new instance of the <see cref="ReaderAgreementTestBase"/> class.</summary>
    /// <param name="output">The xunit output sink.</param>
    protected ReaderAgreementTestBase(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// Runs the differential over <paramref name="corpus"/> and fails on any
    /// disagreement the allowlist does not excuse.
    /// </summary>
    /// <param name="corpusName">The corpus name for the report.</param>
    /// <param name="resolver">The resolver whose metadata context loaded the corpus.</param>
    /// <param name="corpus">The assemblies to walk.</param>
    protected void AssertReadersAgree(string corpusName, ReferenceResolver resolver, IReadOnlyList<Assembly> corpus)
    {
        Assert.NotEmpty(corpus);
        var harness = new ReaderAgreementHarness(resolver, corpusName);
        var summary = harness.Run(corpus);
        this.output.WriteLine(summary);

        var excused = harness.Disagreements.Where(ReaderAgreementAllowlist.IsExcused).ToList();
        var unexcused = harness.Disagreements.Where(d => !ReaderAgreementAllowlist.IsExcused(d)).ToList();
        this.output.WriteLine($"excused by the allowlist: {excused.Count}");
        foreach (var entry in ReaderAgreementAllowlist.Entries)
        {
            this.output.WriteLine($"  {string.Join("+", entry.Readers)} [{entry.Tag ?? "any position"}] ({entry.Issue}): "
                + excused.Count(d => (entry.Tag == null || d.Tags.Contains(entry.Tag))
                    && d.Results.Any(r => entry.Readers.Contains(r.Reader))));
        }

        if (unexcused.Count > 0)
        {
            ReaderAgreementHarness.Report(this.output, unexcused);
        }

        // Triage affordance: `GSHARP_READER_AGREEMENT_DUMP=<dir>` writes every
        // unexcused disagreement as one tab-separated line per position.
        if (Environment.GetEnvironmentVariable("GSHARP_READER_AGREEMENT_DUMP") is { Length: > 0 } dumpDirectory)
        {
            Directory.CreateDirectory(dumpDirectory);
            File.WriteAllLines(
                Path.Combine(dumpDirectory, corpusName + ".tsv"),
                unexcused.Select(d => string.Join(
                    '\t',
                    d.Corpus,
                    d.Member,
                    d.PositionName,
                    d.Argument,
                    string.Join("+", d.Dissenters),
                    d.OpenPositionType.ToString(),
                    string.Join(" ; ", d.Results.Select(r => $"{r.Reader}={r.Shape} ({r.Display})")))));
        }

        Assert.True(harness.PositionsCompared > 0, $"the corpus produced no positions: {summary}");
        Assert.True(
            harness.EnumerationErrorCount == 0,
            $"{harness.EnumerationErrorCount} corpus enumeration error(s) shrank the corpus: {summary}");
        Assert.True(
            harness.ReaderExceptionCount == 0,
            $"{harness.ReaderExceptionCount} reader call(s) threw; see the summary line: {summary}");
        Assert.True(
            unexcused.Count == 0,
            $"{unexcused.Count} reader disagreement(s) not on the allowlist; first: {unexcused.FirstOrDefault()}");
    }

    /// <summary>Returns the resolver's assemblies that were loaded from <paramref name="paths"/>.</summary>
    /// <param name="resolver">The resolver.</param>
    /// <param name="paths">The corpus's own paths.</param>
    /// <returns>The corpus assemblies.</returns>
    protected static IReadOnlyList<Assembly> LoadedFrom(ReferenceResolver resolver, IEnumerable<string> paths)
    {
        var names = new HashSet<string>(
            paths.Select(p => Path.GetFileNameWithoutExtension(p)),
            StringComparer.OrdinalIgnoreCase);
        return resolver.Assemblies
            .Where(a => names.Contains(a.GetName().Name ?? string.Empty))
            .OrderBy(a => a.GetName().Name, StringComparer.Ordinal)
            .ToList();
    }
}

/// <summary>ADR-0193 §4: the reference BCL — the targeting pack gsc resolves.</summary>
public sealed class BclReaderAgreementTests : ReaderAgreementTestBase
{
    /// <summary>Initializes a new instance of the <see cref="BclReaderAgreementTests"/> class.</summary>
    /// <param name="output">The xunit output sink.</param>
    public BclReaderAgreementTests(ITestOutputHelper output)
        : base(output)
    {
    }

    /// <summary>Every public generic declaration of the <c>Microsoft.NETCore.App.Ref</c> targeting pack.</summary>
    [Fact]
    public void Readers_Agree_Over_The_Reference_Bcl()
    {
        var refDirectory = LocateRefPack();
        var paths = Directory.EnumerateFiles(refDirectory, "*.dll").ToList();
        using var resolver = ReferenceResolver.WithReferences(paths);
        this.AssertReadersAgree("bcl", resolver, LoadedFrom(resolver, paths));
    }

    private static string LocateRefPack()
    {
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)
            ?? throw new Xunit.Sdk.XunitException("prerequisite missing: host runtime directory");
        var dotnetRoot = Directory.GetParent(runtimeDirectory)?.Parent?.Parent?.FullName
            ?? throw new Xunit.Sdk.XunitException("prerequisite missing: dotnet root");
        var packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
        var tfm = $"net{Environment.Version.Major}.0";
        var exact = Path.Combine(packsRoot, Environment.Version.ToString(3), "ref", tfm);
        if (Directory.Exists(exact))
        {
            return exact;
        }

        return Directory.Exists(packsRoot)
            ? Directory.EnumerateDirectories(packsRoot, Environment.Version.Major + ".*")
                .OrderByDescending(d => d, StringComparer.Ordinal)
                .Select(d => Path.Combine(d, "ref", tfm))
                .FirstOrDefault(Directory.Exists)
                ?? throw new Xunit.Sdk.XunitException($"prerequisite missing: no {tfm} ref pack under '{packsRoot}'")
            : throw new Xunit.Sdk.XunitException($"prerequisite missing: '{packsRoot}'");
    }
}

/// <summary>
/// ADR-0193 §4: an unannotated netstandard2.0 assembly — no nullable metadata
/// at all, the #4361 shape.
/// </summary>
public sealed class NetStandardReaderAgreementTests : ReaderAgreementTestBase
{
    /// <summary>Initializes a new instance of the <see cref="NetStandardReaderAgreementTests"/> class.</summary>
    /// <param name="output">The xunit output sink.</param>
    public NetStandardReaderAgreementTests(ITestOutputHelper output)
        : base(output)
    {
    }

    /// <summary><c>netstandard.dll</c> from <c>NETStandard.Library</c> 2.0.3.</summary>
    [Fact]
    public void Readers_Agree_Over_NetStandard20()
    {
        var refDirectory = typeof(NetStandardReaderAgreementTests).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(attribute => attribute.Key == "NetStandard20ReferenceDirectory")
            .Value ?? throw new Xunit.Sdk.XunitException("prerequisite missing: NetStandard20ReferenceDirectory");
        Assert.True(Directory.Exists(refDirectory), $"prerequisite missing: '{refDirectory}'");
        var paths = Directory.EnumerateFiles(refDirectory, "*.dll").ToList();
        using var resolver = ReferenceResolver.WithReferences(paths);
        this.AssertReadersAgree(
            "netstandard2.0",
            resolver,
            LoadedFrom(resolver, paths.Where(p => Path.GetFileName(p) == "netstandard.dll")));
    }
}

/// <summary>ADR-0193 §4: FsCheck, an unannotated F# library (a #4361 witness).</summary>
public sealed class FsCheckReaderAgreementTests : ReaderAgreementTestBase
{
    /// <summary>Initializes a new instance of the <see cref="FsCheckReaderAgreementTests"/> class.</summary>
    /// <param name="output">The xunit output sink.</param>
    public FsCheckReaderAgreementTests(ITestOutputHelper output)
        : base(output)
    {
    }

    /// <summary>The FsCheck assembly the test project references.</summary>
    [Fact]
    public void Readers_Agree_Over_FsCheck()
    {
        var fsCheck = Path.Combine(AppContext.BaseDirectory, "FsCheck.dll");
        var fsharpCore = Path.Combine(AppContext.BaseDirectory, "FSharp.Core.dll");
        Assert.True(File.Exists(fsCheck), $"prerequisite missing: '{fsCheck}'");
        using var resolver = ReferenceResolver.WithReferences(new[] { fsCheck, fsharpCore });
        this.AssertReadersAgree("FsCheck", resolver, LoadedFrom(resolver, new[] { fsCheck }));
    }
}

/// <summary>
/// ADR-0193 §4: a csc-compiled fixture exercising every open-slot state
/// (<c>[Nullable(2)]</c>, not-annotated, oblivious explicit and absent),
/// constraints, arrays, tuples, value-type generics and generic methods.
/// Emitted by <c>csc</c> at test time, as <c>aac0c452b</c> did for the #4361
/// reader test, so it stays C# metadata when the suite is self-migrated.
/// </summary>
public sealed class CscFixtureReaderAgreementTests : ReaderAgreementTestBase, IDisposable
{
    private const string AssemblyName = "ReaderAgreementFixture";

    private const string Source = """
        using System;
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

            public static class Statics
            {
                public static T Identity<T>(T value) => value;
                public static List<T> Empty<T>() => new List<T>();
                public static T[] FindAll<T>(T[] values, Predicate<T> match) => values;
            }
        }
        """;

    private readonly string directory;

    /// <summary>Initializes a new instance of the <see cref="CscFixtureReaderAgreementTests"/> class.</summary>
    /// <param name="output">The xunit output sink.</param>
    public CscFixtureReaderAgreementTests(ITestOutputHelper output)
        : base(output)
    {
        this.directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(CscFixtureReaderAgreementTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.directory);
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        try
        {
            Directory.Delete(this.directory, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>The csc-emitted fixture library.</summary>
    [Fact]
    public void Readers_Agree_Over_The_Csc_Fixture()
    {
        var path = this.EmitFixture();
        using var resolver = ReferenceResolver.WithReferences(new[] { path });
        this.AssertReadersAgree("csc-fixture", resolver, LoadedFrom(resolver, new[] { path }));
    }

    private string EmitFixture()
    {
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator) ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            AssemblyName,
            new[] { CSharpSyntaxTree.ParseText(Source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var path = Path.Combine(this.directory, AssemblyName + ".dll");
        using (var stream = File.Create(path))
        {
            var emit = compilation.Emit(stream);
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        }

        return path;
    }
}

/// <summary>
/// The harness's own guard: a corpus hole is an error, not a skip. A generic
/// whose constraint names a type from an assembly the resolver was not given
/// cannot be closed or read by any reader; that must surface as an
/// enumeration error rather than a silently skipped closing.
/// </summary>
public sealed class ReaderAgreementHarnessGuardTests : IDisposable
{
    private readonly string directory;

    /// <summary>Initializes a new instance of the <see cref="ReaderAgreementHarnessGuardTests"/> class.</summary>
    public ReaderAgreementHarnessGuardTests()
    {
        this.directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(ReaderAgreementHarnessGuardTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.directory);
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        try
        {
            Directory.Delete(this.directory, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>An unresolvable constraint type trips the enumeration-error guard.</summary>
    [Fact]
    public void An_Unresolvable_Constraint_Type_Is_An_Enumeration_Error()
    {
        var basePath = this.Emit("GuardBase", "namespace Guard { public class Base { } }", Array.Empty<string>());
        var genericPath = this.Emit(
            "GuardGeneric",
            "namespace Guard { public class Gen<T> where T : Base { public T Value; public T Get() => Value; } }",
            new[] { basePath });

        // Only the generic's own assembly: `Base` cannot be resolved.
        using var resolver = ReferenceResolver.WithReferences(new[] { genericPath });
        var corpus = resolver.Assemblies
            .Where(a => a.GetName().Name == "GuardGeneric")
            .ToList();
        Assert.NotEmpty(corpus);

        var harness = new ReaderAgreementHarness(resolver, "guard");
        harness.Run(corpus);

        Assert.True(harness.EnumerationErrorCount > 0, "an unresolvable constraint must count as an enumeration error");
    }

    private string Emit(string assemblyName, string source, string[] extraReferences)
    {
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator) ?? Array.Empty<string>())
            .Where(File.Exists)
            .Concat(extraReferences)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var path = Path.Combine(this.directory, assemblyName + ".dll");
        using (var stream = File.Create(path))
        {
            var emit = compilation.Emit(stream);
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        }

        return path;
    }
}
