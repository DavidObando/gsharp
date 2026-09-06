// <copyright file="Issue3987StructuralSpellingIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3987: <c>Conversion</c> stopped relating <c>map[K, V]</c> to
/// <c>Dictionary&lt;K, V&gt;</c> — and a tuple to <c>System.ValueTuple&lt;…&gt;</c>
/// — the moment an element was open.
/// </summary>
/// <remarks>
/// <para>A <c>map[K, V]</c> IS a <c>System.Collections.Generic.Dictionary&lt;K,
/// V&gt;</c> (ADR-0104) and a G# tuple IS a <c>System.ValueTuple&lt;…&gt;</c>
/// (ADR-0158). With CLOSED elements <c>Conversion.Classify</c> said so, because
/// its first check compares the two sides' <c>ClrType</c>s. Once an element is
/// open both <c>ClrType</c>s are the ADR-0004 type-ERASED shape (or null), and
/// the only remaining identity rule — <c>TryClassifyWrappedElementIdentity</c> —
/// is guarded by <c>from.GetType() == to.GetType()</c>, which a
/// <c>MapTypeSymbol</c>/<c>ImportedTypeSymbol</c> pair does not satisfy. So the
/// two SPELLINGS of one type stopped being identity exactly when the element was
/// symbolic, and <c>makeMap[K, V](entries map[K, V])</c> could not pass
/// <c>entries</c> to the <c>Dictionary[K, V]</c> parameter it already is.</para>
/// <para>The repair is the move #3976 made for channels — the lattice reads the
/// TYPES, not the spelling. <c>MapTypeSymbol.TryGetMapShape</c> and
/// <c>TupleTypeSymbol.TryGetTupleShape</c> recognise both spellings, and
/// <c>Conversion</c> compares them element-wise.</para>
/// <para>Recognising the pair also means OWNING it. Both CLR families are
/// invariant, so over an open element the only relation that exists is
/// element-wise identity — and a substituted <c>ValueTuple&lt;int32, !T0&gt;</c>
/// still reports a type-erased <c>ClrType</c>, so a rule reading only CLR shapes
/// saw <c>ValueTuple&lt;int32, object&gt;</c> on both sides and accepted a pair
/// with no conversion to emit. That is why #3984 had to canonicalize the
/// projected parameter locally in <c>DeclarationBinder.ResolveClrBaseConstructor</c>;
/// with the classifier fixed, that workaround (<c>CanonicalizeStructuralShape</c>,
/// <c>ShouldCanonicalizeAgainst</c>, <c>TryFlattenValueTupleElements</c>) is
/// DELETED and the whole Issue3984 suite still passes.</para>
/// <para>Every behavioural case compiles against a separately compiled C#
/// library, IL-VERIFIES, RUNS, and asserts the program's own stdout — each
/// fixture type declares two same-arity constructors and records which one ran
/// in <c>Tag</c>, so binding the wrong one is observable rather than merely
/// verifiable.</para>
/// </remarks>
public class Issue3987StructuralSpellingIdentityTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library every fixture case links against. Each type declares TWO
    /// constructors of the same arity — one taking the structural shape, one
    /// taking a plain <c>int</c> — and records which ran in <c>Tag</c>.
    /// </summary>
    private const string LibrarySource = """
        using System.Collections.Generic;

        namespace Interop;

        public class MapHolder<K, V>
            where K : notnull
        {
            public MapHolder(Dictionary<K, V> entries)
            {
                this.Tag = "map:" + entries.Count;
            }

            public MapHolder(int capacity)
            {
                this.Tag = "int:" + capacity;
            }

            public string Tag { get; }
        }

        public class TupleHolder<T>
        {
            public TupleHolder((int, T) pair)
            {
                this.Tag = "tuple:" + pair.Item1 + ":" + pair.Item2;
            }

            public TupleHolder(int n)
            {
                this.Tag = "int:" + n;
            }

            public string Tag { get; }
        }

        public class BigTupleHolder<T>
        {
            public BigTupleHolder((int, int, int, int, int, int, int, T) pair)
            {
                this.Tag = "big:" + pair.Item1 + ":" + pair.Item8;
            }

            public BigTupleHolder(int n)
            {
                this.Tag = "int:" + n;
            }

            public string Tag { get; }
        }

        public class SeqHolder<T>
        {
            public SeqHolder(IEnumerable<T> items)
            {
                var n = 0;
                foreach (var _ in items)
                {
                    n++;
                }

                this.Tag = "seq:" + n;
            }

            public SeqHolder(int capacity)
            {
                this.Tag = "int:" + capacity;
            }

            public string Tag { get; }
        }

        public static class Probes
        {
            public static string CountEntries<K, V>(Dictionary<K, V> entries)
                where K : notnull
                => "probe:" + entries.Count;

            public static string FirstOf<T>((int, T) pair) => "probe:" + pair.Item1 + ":" + pair.Item2;
        }
        """;

    /// <summary>The behavioural cases: each compiles, IL-verifies, runs, and prints.</summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // The issue's own repro, in the ORDINARY imported-constructor probe
        // (ExpressionBinder), which is what makes it a `Conversion` gap rather
        // than anything specific to `: base(...)`.
        yield return new object[]
        {
            "the-reported-repro-binds",
            """
            package P
            import System
            import Interop

            func makeMap[K, V](entries map[K, V]) MapHolder[K, V] {
                return MapHolder[K, V](entries)
            }

            let m = map[string, int32]{}
            m["a"] = 1
            m["b"] = 2
            Console.WriteLine(makeMap[string, int32](m).Tag)
            """,
            new[] { "map:2" },
        };

        // The tuple form of the same gap, against the same probe.
        yield return new object[]
        {
            "a-tuple-over-an-open-element-reaches-a-valuetuple-parameter",
            """
            package P
            import System
            import Interop

            func makeTuple[T](pair (int32, T)) TupleHolder[T] {
                return TupleHolder[T](pair)
            }

            Console.WriteLine(makeTuple[string]((7, "x")).Tag)
            """,
            new[] { "tuple:7:x" },
        };

        // Symmetry: the author who spells the parameter as the IMPORTED type
        // reaches the very same constructor. #3984's workaround needed a
        // `ShouldCanonicalizeAgainst` guard precisely because rewriting the
        // target broke this direction; a rule in `Conversion` has no direction
        // to get wrong.
        yield return new object[]
        {
            "the-imported-spelling-of-the-same-type-binds-too",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            func makeMap[K, V](entries Dictionary[K, V]) MapHolder[K, V] {
                return MapHolder[K, V](entries)
            }

            let d = Dictionary[string, int32]()
            d.Add("a", 1)
            Console.WriteLine(makeMap[string, int32](d).Tag)
            """,
            new[] { "map:1" },
        };

        // The other way an element loses its CLR identity: a type declared in
        // this compilation. `Pair` has no CLR backing while binding, so
        // `map[string, Pair]`'s `ClrType` is null for exactly the same reason
        // an open `K` makes it null.
        yield return new object[]
        {
            "a-map-over-a-same-compilation-element-binds",
            """
            package P
            import System
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            func hold(entries map[string, Pair]) MapHolder[string, Pair] {
                return MapHolder[string, Pair](entries)
            }

            let m = map[string, Pair]{}
            m["p"] = Pair{a: 1, b: 2}
            Console.WriteLine(hold(m).Tag)
            """,
            new[] { "map:1" },
        };

        // An 8-element tuple is `ValueTuple<T1..T7, TRest>` on the imported
        // side and a flat element list on G#'s, so the comparison has to unwind
        // the chain — otherwise exactly the long tuples keep failing.
        yield return new object[]
        {
            "a-long-tuple-over-an-open-element-binds",
            """
            package P
            import System
            import Interop

            func makeBig[T](pair (int32, int32, int32, int32, int32, int32, int32, T)) BigTupleHolder[T] {
                return BigTupleHolder[T](pair)
            }

            Console.WriteLine(makeBig[string]((1, 2, 3, 4, 5, 6, 7, "tail")).Tag)
            """,
            new[] { "big:1:tail" },
        };

        // Not a constructor: the same gap on an imported STATIC method's
        // parameter, which is the plainest statement that this lives in
        // `Conversion` and not in any one probe.
        //
        // The tuple sibling of this row (`Probes.FirstOf[T]((int32, T))`) is
        // deliberately absent: it compiles on `main` today and emits IL
        // ILVerify rejects, identically before and after this fix, because a
        // symbolic tuple at an imported GENERIC METHOD's slot loses its
        // MethodSpec recovery. That is a different axis — issue #4000 — and
        // nothing here touches it.
        yield return new object[]
        {
            "an-imported-static-method-takes-a-map-over-an-open-element",
            """
            package P
            import System
            import Interop

            func countMap[K, V](entries map[K, V]) string {
                return Probes.CountEntries[K, V](entries)
            }

            let m = map[string, int32]{}
            m["a"] = 1
            Console.WriteLine(countMap[string, int32](m))
            """,
            new[] { "probe:1" },
        };

        // The issue's own control, kept as a row: the slice sibling in the same
        // file always bound, because `[]T -> IEnumerable[T]` has a rule of its
        // own. It must keep binding.
        yield return new object[]
        {
            "control-the-slice-sibling-already-bound",
            """
            package P
            import System
            import Interop

            func make[T](items []T) SeqHolder[T] {
                return SeqHolder[T](items)
            }

            Console.WriteLine(make[int32]([]int32{1, 2, 3}).Tag)
            """,
            new[] { "seq:3" },
        };

        // The issue's other control: the CLOSED map form bound all along,
        // because the `ClrType` comparison catches it before any of this runs.
        yield return new object[]
        {
            "control-the-closed-map-and-tuple-were-never-broken",
            """
            package P
            import System
            import Interop

            func closedMap(entries map[string, int32]) MapHolder[string, int32] {
                return MapHolder[string, int32](entries)
            }

            func closedTuple(pair (int32, string)) TupleHolder[string] {
                return TupleHolder[string](pair)
            }

            let m = map[string, int32]{}
            m["a"] = 1
            m["b"] = 2
            m["c"] = 3
            Console.WriteLine(closedMap(m).Tag)
            Console.WriteLine(closedTuple((4, "y")).Tag)
            """,
            new[] { "map:3", "tuple:4:y" },
        };

        // A `: base(...)` row, so the position #3984 fixed locally is still
        // covered once its local canonicalization is gone.
        yield return new object[]
        {
            "the-base-initializer-position-still-binds-without-its-workaround",
            """
            package P
            import System
            import Interop

            class Holder[K, V] : MapHolder[K, V] {
                init(entries map[K, V]) : base(entries) {
                }
            }

            let m = map[string, int32]{}
            m["a"] = 1
            m["b"] = 2
            Console.WriteLine(Holder[string, int32](m).Tag)
            """,
            new[] { "map:2" },
        };
    }

    /// <summary>The rejection cases: widening identity must not accept a different type.</summary>
    /// <returns>Case name, G# source, expected diagnostic id.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // Key and value are positional; swapping them is a different type.
        yield return new object[]
        {
            "the-key-and-value-still-have-to-match",
            """
            package P
            import System
            import Interop

            func makeMap[K, V](entries map[V, K]) MapHolder[K, V] {
                return MapHolder[K, V](entries)
            }

            Console.WriteLine(makeMap[string, int32](map[int32, string]{}).Tag)
            """,
            "GS0155",
        };

        // The row #3984 had to add its canonicalization to hold, now held by
        // `Conversion` itself: `(int32, object)` is not `(int32, T)`, and the
        // erased `ValueTuple<int32, object>` both sides report is exactly the
        // trap.
        yield return new object[]
        {
            "an-erased-tuple-spelling-does-not-satisfy-a-symbolic-element",
            """
            package P
            import System
            import Interop

            func makeTuple[T](pair (int32, object)) TupleHolder[T] {
                return TupleHolder[T](pair)
            }

            Console.WriteLine(makeTuple[string]((7, "x")).Tag)
            """,
            "GS0155",
        };

        // Same trap in the `: base(...)` position — the case that proves
        // deleting #3984's workaround did not re-open what it closed.
        yield return new object[]
        {
            "an-erased-tuple-spelling-does-not-satisfy-a-base-initializer",
            """
            package P
            import System
            import Interop

            class Pairish[T] : TupleHolder[T] {
                init(pair (int32, object)) : base(pair) {
                }
            }

            Console.WriteLine(Pairish[string]((7, "x")).Tag)
            """,
            "GS0155",
        };

        // Arity is part of the shape.
        yield return new object[]
        {
            "the-tuple-arity-still-has-to-match",
            """
            package P
            import System
            import Interop

            func makeTuple[T](pair (int32, T, T)) TupleHolder[T] {
                return TupleHolder[T](pair)
            }

            Console.WriteLine(makeTuple[string]((7, "x", "y")).Tag)
            """,
            "GS0267",
        };

        // A map is not a tuple, however open either one is.
        yield return new object[]
        {
            "a-map-is-not-a-tuple",
            """
            package P
            import System
            import Interop

            func makeTuple[K, V](entries map[K, V]) TupleHolder[V] {
                return TupleHolder[V](entries)
            }

            Console.WriteLine(makeTuple[int32, string](map[int32, string]{}).Tag)
            """,
            "GS0267",
        };
    }

    /// <summary>
    /// Compiles the C# library, compiles a G# consumer against it, IL-verifies
    /// the consumer, runs it, and asserts the program's own output.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void AStructuralArgumentOverAnOpenElement_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3987_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");

            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(expectedLines, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// A pair that is a different type stays rejected: recognising both
    /// spellings must widen identity, never truth.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void ADifferentStructuralShape_IsStillRefused(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3987_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "Interop",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "Interop.dll");
        var result = compilation.Emit(libPath);
        Assert.True(
            result.Success,
            "the C# library must compile:\n"
                + string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));

        return libPath;
    }

    private static string Compile(string dir, string fileName, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return compileOut.ToString() + compileErr;
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            return (-1, $"timed out after {RunTimeout / 1000}s.");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
