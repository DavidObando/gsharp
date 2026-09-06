// <copyright file="Issue4026ExplicitTypeArgumentSoundnessTests.cs" company="GSharp">
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
/// Issue #4026: a generic call over a same-compilation element emitted a
/// MethodSpec closed over a type the pushed value is not — IL that runs but
/// does not verify.
/// </summary>
/// <remarks>
/// <para><b>Two faces, one sentence.</b> The MethodSpec and the value on the
/// stack have to name the same type. Both faces broke that, from opposite
/// ends.</para>
/// <para><b>Face 1 — the author names a BASE of the real element.</b>
/// <c>Probes.CountAny[ImportedBase](List[Derived]())</c> closes
/// <c>CountAny[T](List[T])</c> over a genuine <c>ImportedBase</c>, so the
/// parameter really is the INVARIANT <c>List&lt;ImportedBase&gt;</c>.
/// Applicability admitted it anyway: the argument's erased
/// <c>List&lt;object&gt;</c> surrogate found no CLR conversion, the ADR-0148
/// <c>structuralProjectionArgumentCheck</c> answered its usual nonsense yes (two
/// <c>List</c>s share a parameterless constructor and a <c>Capacity</c>), and
/// the #3989/#4006 erased-argument check that exists to refuse exactly that was
/// waived because <c>IsErasedGenericParameterSlot</c> saw <c>List&lt;!!T&gt;</c>
/// in the open declaration and called the slot "possibly erased". It was not:
/// the call site PINNED it. <c>ClrOverloadResolution</c> now carries one flag
/// per explicit type argument saying whether it names a type with a CLR identity
/// of its own, and a slot whose open declaration mentions only genuinely-pinned
/// method type parameters is no longer exempt. A type argument that is itself a
/// SURROGATE — a same-compilation class arriving as its imported base, which is
/// what #4016 made the placeholder produce — is not genuine and keeps the
/// exemption, which is why every #4016 row goes on binding.</para>
/// <para><b>Face 2 — inference reads the element off the SURROGATE.</b> No
/// explicit type arguments at all: <c>Probes.CountAnyMap(entries)</c> on a
/// <c>map[string, Derived]</c> compiled, ran and did not verify.
/// <c>MemberLookup.UnifyForMethodTypeArgs</c> — the symbolic recovery that
/// decides what the MethodSpec is emitted over — had no arm for
/// <c>MapTypeSymbol</c>, so <c>K</c> and <c>V</c> were never recovered and the
/// spec fell back to whatever the ERASURE presented: <c>ImportedBase</c> for a
/// class with an imported base, <c>object</c> for one without, while the value
/// pushed was the real <c>Dictionary&lt;string, Derived&gt;</c>. The
/// <c>List</c> and slice spellings never had it, because an
/// <c>ImportedTypeSymbol</c> reaches Pattern A on its own and a slice reaches
/// Pattern B. A <c>map</c> is now restated as the constructed
/// <c>Dictionary[K, V]</c> it IS (ADR-0104) and takes those same patterns, so
/// <c>IDictionary[K, V]</c>, <c>IReadOnlyDictionary[K, V]</c> and
/// <c>IEnumerable[KeyValuePair[K, V]]</c> formals come with it.</para>
/// <para><b>Face 2 is not imported-base-specific.</b> The issue reports it on a
/// <c>class Derived : ImportedBase</c>, but a base-less
/// <c>class Standalone</c> failed identically, with <c>object</c> where the
/// spec should have named <c>Standalone</c>. Both are pinned.</para>
/// <para><b>The asymmetry the issue's follow-up records, re-measured.</b> On
/// <c>main</c> at <c>565b9a04</c> the EXPLICIT map spelling verified (#4016
/// recovers the real element from <c>typeArgSymbols</c>) while the INFERRED one
/// did not. Both verify now, and the explicit row is kept here to hold that
/// half in place.</para>
/// <para><b>What face 1's fix must not do.</b> The verdict is per SLOT, never
/// per nested position: reading the open declaration position by position was
/// implemented and reverted once already (#3989), because
/// <c>Task.ContinueWith[TResult](Func[Task, TResult])</c> has one concrete
/// nested position beside one open one. The <c>mixed</c> row below is that
/// shape, with a genuine explicit type argument, and must stay green.</para>
/// <para>Not channel business, so no ADR-0174 erratum.</para>
/// </remarks>
public class Issue4026ExplicitTypeArgumentSoundnessTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>The C# library every fixture case links against.</summary>
    private const string LibrarySource = """
        using System;
        using System.Collections.Generic;

        namespace Interop;

        public class ImportedBase
        {
            public string Name { get; set; } = "base";
        }

        public static class Probes
        {
            // Inferred generic slots the erasure exists to serve.
            public static string CountAny<T>(List<T> items) => "any:" + items.Count;

            public static string CountAnyMap<K, V>(Dictionary<K, V> entries)
                where K : notnull
                => "anymap:" + entries.Count;

            public static string CountArray<T>(T[] items) => "arr:" + items.Length;

            // A genuinely COVARIANT slot: a base type argument is legitimate here.
            public static string CountSeq<T>(IEnumerable<T> items)
            {
                var n = 0;
                foreach (var unused in items)
                {
                    n++;
                }

                return "seq:" + n;
            }

            // One concrete nested position beside one open one — the shape a
            // per-position rewrite of the erasure gate broke (#3989).
            public static string Mixed<TResult>(Func<List<int>, TResult> project)
                => "mixed:" + project(new List<int> { 1, 2 });

            // Review finding 1: a call that can NAME its arguments out of
            // source order, with the map in the second parameter.
            public static string Marked<T>(int marker, Dictionary<string, T> entries)
                where T : class
                => "marked:" + marker + ":" + entries.Count;

            // Review finding 2: two method type parameters in ONE invariant
            // parameter, so a call can pin one genuinely and one not.
            public static string TakeMap<K, V>(Dictionary<K, V> entries)
                where K : notnull
                => "takemap:" + entries.Count;
        }
        """;

    /// <summary>
    /// Every row that must compile, IL-verify and run: the two faces' repairs
    /// and the neighbours that were already green.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> BindingCases()
    {
        // RED BEFORE (ILVerify). Face 2, the issue's own "working control":
        // inferred type arguments on the `map` spelling.
        yield return new object[]
        {
            "an-inferred-map-of-a-derived-class-emits-over-the-real-element",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let entries = map[string, Derived]{}
            entries["k"] = Derived{}
            Console.WriteLine(Probes.CountAnyMap(entries))
            """,
            new[] { "anymap:1" },
        };

        // RED BEFORE (ILVerify). Face 2 is not imported-base-specific: a
        // base-less class emitted `object` where it should have emitted itself.
        yield return new object[]
        {
            "an-inferred-map-of-a-base-less-class-emits-over-it-too",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Standalone {
            }

            let entries = map[string, Standalone]{}
            entries["k"] = Standalone{}
            Console.WriteLine(Probes.CountAnyMap(entries))
            """,
            new[] { "anymap:1" },
        };

        // RED BEFORE (ILVerify). The KEY position, same mechanism.
        yield return new object[]
        {
            "an-inferred-map-with-a-derived-key-emits-over-the-real-key",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let entries = map[Derived, string]{}
            Console.WriteLine(Probes.CountAnyMap(entries))
            """,
            new[] { "anymap:0" },
        };

        // GREEN BEFORE. The other half of the follow-up comment's asymmetry:
        // #4016 made the EXPLICIT map spelling verify, and it still does.
        yield return new object[]
        {
            "the-explicit-map-spelling-keeps-verifying",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let entries = map[string, Derived]{}
            entries["k"] = Derived{}
            Console.WriteLine(Probes.CountAnyMap[string, Derived](entries))
            """,
            new[] { "anymap:1" },
        };

        // GREEN BEFORE. An explicit type argument that IS the real element is a
        // surrogate, not a genuine pin, so face 1's rule leaves it alone.
        yield return new object[]
        {
            "an-explicit-type-argument-naming-the-real-element-still-binds",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let items = List[Derived]()
            items.Add(Derived{})
            Console.WriteLine(Probes.CountAny[Derived](items))
            """,
            new[] { "any:1" },
        };

        // GREEN BEFORE, and the issue names it: a COVARIANT slot really does
        // accept a base type argument, so this must not be caught by face 1.
        yield return new object[]
        {
            "a-covariant-sequence-slot-still-takes-a-base-type-argument",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let items = List[Derived]()
            items.Add(Derived{})
            Console.WriteLine(Probes.CountSeq[ImportedBase](items))
            """,
            new[] { "seq:1" },
        };

        // GREEN BEFORE. The #3989 lesson, pinned: one concrete nested position
        // beside one open one, with a GENUINE explicit type argument, which is
        // exactly the combination face 1's flag vector newly reasons about.
        yield return new object[]
        {
            "a-mixed-concrete-and-open-delegate-slot-still-binds-with-a-genuine-pin",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            Console.WriteLine(Probes.Mixed[string]((xs List[int32]) -> "n=" + xs.Count.ToString()))
            """,
            new[] { "mixed:n=2" },
        };

        // GREEN BEFORE, and the row that shows this fix is not a blanket
        // "a base type argument is refused". The ARRAY slot is covariant in the
        // CLR for a reference element, so `Derived[]` really is an
        // `ImportedBase[]` and `Probes.CountArray[ImportedBase]` verifies —
        // measured, not assumed; it was drafted as a rejection row and the
        // measurement said otherwise. Face 1's rule removes an exemption and
        // leaves the verdict to `Conversion`, which is why this one survives
        // while the invariant `List` and `Dictionary` slots do not.
        yield return new object[]
        {
            "an-explicit-base-at-a-covariant-array-slot-still-binds",
            """
            package P
            import System
            import Interop

            class Derived : ImportedBase {
            }

            let items = []Derived{Derived{}}
            Console.WriteLine(Probes.CountArray[ImportedBase](items))
            """,
            new[] { "arr:1" },
        };

        // RED BEFORE this PR's review round (ILVerify). Review finding 1: the
        // symbolic recovery zipped the open parameters with the arguments in
        // SOURCE order, so naming them out of order paired the map with `int`,
        // recovered no `T`, and closed the MethodSpec over the erasure again.
        // CLR inference has reordered since #343; this pins the symbolic side
        // doing the same, with the in-order spelling beside it as the control
        // that was green throughout.
        yield return new object[]
        {
            "a-named-argument-call-out-of-source-order-still-emits-over-the-real-element",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let entries = map[string, Derived]{}
            entries["k"] = Derived{}
            Console.WriteLine(Probes.Marked(entries: entries, marker: 0))
            Console.WriteLine(Probes.Marked(7, entries))
            """,
            new[] { "marked:0:1", "marked:7:1" },
        };

        // GREEN BEFORE, and the row the whole per-position question turns on.
        // `Task.ContinueWith[TResult](Func[Task, TResult])` is one concrete
        // nested position beside one open one — the exact shape that made a
        // per-position rewrite of the erasure gate fail twice (#4004 reverted
        // after nine tests went red, #4019 reverted before commit). The
        // symbolic gate this PR adds is per position by construction, so this
        // row is what says it survives: a GENUINE explicit pin on a delegate
        // parameter whose other position is concrete, compiling, verifying and
        // running. It stays green because the gate declines to judge a lambda
        // argument at all.
        yield return new object[]
        {
            "the-task-continuewith-shape-with-a-genuine-pin-still-binds",
            """
            package P
            import System
            import System.Threading.Tasks

            let t = Task.Run(() -> Console.WriteLine("ran"))
            let r = t.ContinueWith[string]((prev Task) -> "done")
            Console.WriteLine(r.Result)
            """,
            new[] { "ran", "done" },
        };

        // GREEN BEFORE. Primitives never reached the placeholder branch.
        yield return new object[]
        {
            "a-primitive-map-is-untouched-inferred-and-explicit",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            let entries = map[string, int32]{"a": 1}
            Console.WriteLine(Probes.CountAnyMap(entries))
            Console.WriteLine(Probes.CountAnyMap[string, int32](entries))
            """,
            new[] { "anymap:1", "anymap:1" },
        };

        // GREEN BEFORE. The slice spelling reached Pattern B on its own and is
        // the row `Issue4016…Tests` carries as its inferred control.
        yield return new object[]
        {
            "a-slice-at-an-inferred-array-slot-is-untouched",
            """
            package P
            import System
            import Interop

            class Derived : ImportedBase {
            }

            let items = []Derived{Derived{}}
            Console.WriteLine(Probes.CountArray(items))
            Console.WriteLine(Probes.CountArray[Derived](items))
            """,
            new[] { "arr:1", "arr:1" },
        };
    }

    /// <summary>
    /// Face 1: naming a BASE of the real element as the explicit type argument
    /// is refused rather than compiled to unverifiable IL.
    /// </summary>
    /// <returns>Case name, G# source, expected diagnostic id.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // RED BEFORE: compiled, ran, printed `any:0`, and ILVerify reported
        // StackUnexpected (List<Derived> found, List<ImportedBase> expected).
        yield return new object[]
        {
            "an-explicit-base-of-the-real-element-does-not-satisfy-an-invariant-list-slot",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let items = List[Derived]()
            Console.WriteLine(Probes.CountAny[ImportedBase](items))
            """,
            "GS0159",
        };

        // RED BEFORE this PR's review round. Review finding 2: pinning one
        // type parameter GENUINELY beside one that is only a surrogate. The
        // per-slot flag exempts the whole parameter because `V` is not genuine,
        // so the genuine INVARIANT `K` mismatch went unchecked and a
        // `Dictionary<Derived, Derived>` was pushed at a MethodSpec closed over
        // `Dictionary<ImportedBase, Derived>`. No CLR-level correlation can see
        // it — the argument's erased key IS `ImportedBase`, exactly what the
        // pin says — so the verdict is asked on the REAL symbols instead.
        yield return new object[]
        {
            "one-genuine-pin-beside-one-surrogate-still-checks-the-genuine-position",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let entries = map[Derived, Derived]{}
            Console.WriteLine(Probes.TakeMap[ImportedBase, Derived](entries))
            """,
            "GS0159",
        };

        // RED BEFORE: the `map` spelling of the same mistake, identical
        // StackUnexpected on the Dictionary shape.
        yield return new object[]
        {
            "an-explicit-base-of-the-real-value-does-not-satisfy-an-invariant-dictionary-slot",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let entries = map[string, Derived]{}
            Console.WriteLine(Probes.CountAnyMap[string, ImportedBase](entries))
            """,
            "GS0159",
        };

    }

    /// <summary>
    /// A generic call over a same-compilation element compiles, IL-verifies and
    /// runs — the MethodSpec names the type the pushed value actually is.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(BindingCases))]
    public void AGenericCallOverASameCompilationElement_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4026_").FullName;
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
    /// An explicit type argument naming a BASE of the real element is refused,
    /// rather than compiled to IL that ILVerify rejects.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void AnExplicitBaseTypeArgument_IsRefusedAtAnInvariantSlot(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4026_neg_").FullName;
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
