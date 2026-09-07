// <copyright file="Issue4035MapOverANullableValueTypeTests.cs" company="GSharp">
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
/// Issue #4035: a <c>map[K, V?]</c> over a nullable VALUE type compiled clean
/// and then emitted IL that ilverify rejected with <c>StackUnexpected</c> and
/// the runtime rejected with <see cref="InvalidProgramException"/> — the
/// backing <c>Dictionary</c> was closed over the BARE underlying type while
/// every value on the stack was a <c>Nullable&lt;V&gt;</c>.
/// </summary>
/// <remarks>
/// <para><b>Root cause.</b> <c>NullableTypeSymbol</c> passes its underlying
/// type's <c>ClrType</c> straight through — <c>int32?.ClrType</c> is
/// <c>System.Int32</c> — because for a nullable REFERENCE type the annotation
/// has no distinct runtime type. <c>MapTypeSymbol.MakeClrType</c> read
/// <c>ClrType</c> directly, so <c>map[string, int32?]</c> was backed by
/// <c>Dictionary&lt;string, int&gt;</c> while the literal, the indexer's
/// <c>out</c> slot and the loop variable all carried a <c>Nullable&lt;int&gt;</c>.
/// The compiler already owns the correction —
/// <c>NullableLifting.GetEffectiveClrType</c>, which
/// <c>SequenceTypeSymbol.MakeClrType</c> and
/// <c>AsyncSequenceTypeSymbol.MakeClrType</c> both call — and the map's
/// construction simply never called it.</para>
/// <para><b>Two arms, not one.</b> <c>GetEffectiveClrType</c> builds the
/// wrapper with the HOST <c>typeof(Nullable&lt;&gt;)</c>. For
/// <c>map[string, DateTime?]</c>, whose underlying <c>DateTime</c> is a
/// <c>MetadataLoadContext</c> type, that is exactly the
/// <c>TypeBuilderInstantiation</c> stand-in issue #4023 is about — not null, so
/// every <c>ClrType != null</c> gate takes it for a reflectable dictionary,
/// and its own assembly cannot name its context. So the reference-context arm
/// projects the open <c>Nullable&lt;&gt;</c> alongside the open
/// <c>Dictionary&lt;,&gt;</c> and closes it over the already-projected
/// underlying, inside the one context.
/// <see cref="AcceptedCases"/>'s <c>DateTime?</c> and <c>ImportedPoint?</c>
/// rows are what separate the complete fix from the naive
/// <c>GetEffectiveClrType</c> swap.</para>
/// <para><b>A third site, found by measurement.</b> With the construction
/// fixed, <c>for v in m.Values</c> over a <c>map[string, int32?]</c> still
/// failed ilverify — <c>MemberLookup.ProjectSymbolicArgToErasedClr</c> erased
/// the symbolic <c>int32?</c> argument through the same bare <c>ClrType</c>,
/// closing <c>ValueCollection</c> over <c>int32</c> while the receiver was a
/// <c>Dictionary&lt;string, Nullable&lt;int32&gt;&gt;</c>. Same dropped
/// wrapper, one erasure further out; <c>BuildErasedNullableInContext</c> is its
/// <c>Nullable&lt;&gt;</c> analogue of the existing
/// <c>BuildErasedTupleInContext</c>.</para>
/// <para><b>The issue leaves one row unprobed and it matters.</b> It records
/// the <c>Dictionary[string, int32?]</c> spelling as "not yet probed".
/// Measured on <c>3e5103de</c>, that spelling is GREEN — so the two spellings
/// of one type (ADR-0104) genuinely disagreed, and
/// <c>var d Dictionary[string, int32?] = map[string, int32?]{…}</c> failed with
/// <c>[found ref Dictionary`2&lt;string,int32&gt;][expected ref
/// Dictionary`2&lt;string,Nullable`1&lt;int32&gt;&gt;]</c>. That row is in
/// <see cref="AcceptedCases"/>; it is the one that proves the fix made the
/// spellings agree rather than merely moving the map.</para>
/// <para><b>Measured scope.</b> Every value-position operation was affected —
/// literal, <c>m[k]</c> read, <c>m[k] = v</c>, <c>m[k] = nil</c>,
/// <c>TryGetValue</c>, <c>ContainsValue</c>, <c>for k, v in m</c>,
/// <c>for v in m.Values</c> — and so was the KEY position
/// (<c>map[int32?, V]</c>, <c>map[DateTime?, V]</c>). The witness paragraph
/// below is the single place that states how many rows that is, so the count
/// cannot drift out of step with <see cref="AcceptedCases"/>.
/// Nullable REFERENCE values (<c>map[string, string?]</c>) were NOT affected
/// and are a control: the annotation has no distinct runtime type there, so
/// <c>Dictionary&lt;string, string&gt;</c> is the correct backing.</para>
/// <para><b>Discrimination witness (ADR-0154).</b> Reverting
/// <c>src/Core/CodeAnalysis/Symbols/MapTypeSymbol.cs</c>,
/// <c>src/Core/CodeAnalysis/Binding/MemberLookup.cs</c> and
/// <c>src/Core/CodeAnalysis/Emit/MethodBodyEmitter.MemberAccess.cs</c> to
/// <c>3e5103de</c> turns every <see cref="AcceptedCases"/> row red and leaves
/// every <see cref="ControlCases"/> row green.</para>
/// </remarks>
public class Issue4035MapOverANullableValueTypeTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library supplying an imported STRUCT, so a
    /// <c>map[string, ImportedPoint?]</c> exercises the reference-context arm
    /// with a type that is not a BCL primitive.
    /// </summary>
    private const string LibrarySource = """
        namespace HelperLib;

        public struct ImportedPoint
        {
            public int X { get; set; }
        }
        """;

    /// <summary>
    /// Every row compiles on <c>3e5103de</c> and then fails ilverify with one
    /// or more <c>StackUnexpected</c> errors (most also throw
    /// <see cref="InvalidProgramException"/> at runtime; the count per program
    /// varies with how many nullable values the row moves — the headline
    /// indexer repro shows two, a bare <c>.Values</c> iteration one). Each row
    /// moves a real value through the map and prints it, so it fails on a
    /// wrong value as well as on invalid IL.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> AcceptedCases()
    {
        // The issue's own repro.
        yield return new object[]
        {
            "read-a-nullable-int-value-through-the-indexer",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, int32?]{"a": 1}
                var x = m["a"]
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(x.ToString())
                Console.WriteLine(m.ContainsKey("a").ToString())
            }

            main2()
            """,
            new[] { "1", "1", "True" },
        };

        yield return new object[]
        {
            "write-a-nullable-int-value-through-the-indexer",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, int32?]{}
                m["a"] = 7
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m["a"].ToString())
            }

            main2()
            """,
            new[] { "1", "7" },
        };

        yield return new object[]
        {
            "trygetvalue-into-a-nullable-int-out-slot",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, int32?]{"a": 3}
                var got int32?
                if m.TryGetValue("a", out got) {
                    Console.WriteLine(got.ToString())
                }
            }

            main2()
            """,
            new[] { "3" },
        };

        yield return new object[]
        {
            "iterate-a-map-over-a-nullable-int-value",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, int32?]{"a": 4}
                for k, v in m {
                    Console.WriteLine(k + "=" + v.ToString())
                }
            }

            main2()
            """,
            new[] { "a=4" },
        };

        // The `.Values` iteration is the row that needed the erasure fix, not
        // only the construction fix.
        yield return new object[]
        {
            "iterate-the-values-of-a-map-over-a-nullable-int",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, int32?]{"a": 6}
                for v in m.Values {
                    Console.WriteLine(v.ToString())
                }
            }

            main2()
            """,
            new[] { "6" },
        };

        // An actual nil stored at a nullable value slot: the whole point of
        // `map[K, V?]`, and observable through HasValue.
        yield return new object[]
        {
            "store-nil-at-a-nullable-int-value",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, int32?]{}
                m["a"] = nil
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m["a"].HasValue.ToString())
            }

            main2()
            """,
            new[] { "1", "False" },
        };

        yield return new object[]
        {
            "containsvalue-over-a-nullable-int-value",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, int32?]{"a": 9}
                Console.WriteLine(m.ContainsValue(9).ToString())
            }

            main2()
            """,
            new[] { "True" },
        };

        // The reference-context arm: `DateTime` comes from the compilation's
        // MetadataLoadContext, so a host-built `Nullable<DateTime>` is the
        // unreflectable stand-in. The `.Value.Year` read moves a real value
        // through the wrapper.
        yield return new object[]
        {
            "a-nullable-imported-struct-value-datetime",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, DateTime?]{}
                m["a"] = DateTime(2020, 1, 2)
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m.ContainsKey("a").ToString())
                Console.WriteLine(m["a"].Value.Year.ToString())
            }

            main2()
            """,
            new[] { "1", "True", "2020" },
        };

        // The same arm over a struct from a user-supplied assembly rather than
        // the BCL, so the projector is exercised on a genuinely external one.
        yield return new object[]
        {
            "a-nullable-imported-struct-value-from-a-referenced-assembly",
            """
            package Demo
            import System
            import HelperLib

            func main2() {
                var m = map[string, ImportedPoint?]{}
                var p = ImportedPoint{}
                p.X = 42
                m["a"] = p
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m["a"].Value.X.ToString())
            }

            main2()
            """,
            new[] { "1", "42" },
        };

        // ITERATING an imported nullable value, not indexing it. This is the
        // only shape that reaches `BuildErasedNullableInContext`'s NON-HOST
        // arm — the one that resolves `System.Nullable`1` out of the erasure
        // context's own assembly instead of using the host
        // `typeof(Nullable<>)`. The `int32?` iteration row above cannot cover
        // it (its context IS the host), and the `DateTime?` rows above only
        // index. Verified load-bearing by mutation: replacing that arm's
        // lookup with `null` leaves the `int32?` iteration green and turns
        // this row and its `.Keys` twin into `GS0158: Cannot find member
        // Value`.
        yield return new object[]
        {
            "iterate-the-values-of-a-map-over-a-nullable-imported-struct",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, DateTime?]{}
                m["a"] = DateTime(2021, 3, 4)
                for v in m.Values {
                    Console.WriteLine(v.Value.Year.ToString())
                }
            }

            main2()
            """,
            new[] { "2021" },
        };

        // The `.Keys` twin of the row above, over a nullable imported KEY.
        yield return new object[]
        {
            "iterate-the-keys-of-a-map-over-a-nullable-imported-struct-key",
            """
            package Demo
            import System

            func main2() {
                var m = map[DateTime?, string]{}
                m[DateTime(2021, 3, 4)] = "x"
                for k in m.Keys {
                    Console.WriteLine(k.Value.Year.ToString())
                }
            }

            main2()
            """,
            new[] { "2021" },
        };

        // `for k, v in m` over an imported nullable value, so the destructured
        // form is covered alongside `.Values`.
        yield return new object[]
        {
            "iterate-key-and-value-of-a-map-over-a-nullable-imported-struct",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, DateTime?]{}
                m["a"] = DateTime(2021, 3, 4)
                for k, v in m {
                    Console.WriteLine(k + "=" + v.Value.Year.ToString())
                }
            }

            main2()
            """,
            new[] { "a=2021" },
        };

        // The KEY position. The issue only measured the value position.
        yield return new object[]
        {
            "a-nullable-int-in-the-key-position",
            """
            package Demo
            import System

            func main2() {
                var m = map[int32?, string]{}
                m[1] = "one"
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m.ContainsKey(1).ToString())
                Console.WriteLine(m[1])
            }

            main2()
            """,
            new[] { "1", "True", "one" },
        };

        // The key position on the reference-context arm.
        yield return new object[]
        {
            "a-nullable-imported-struct-in-the-key-position",
            """
            package Demo
            import System

            func main2() {
                var m = map[DateTime?, string]{}
                m[DateTime(2020, 1, 2)] = "x"
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m[DateTime(2020, 1, 2)])
            }

            main2()
            """,
            new[] { "1", "x" },
        };

        // The row the issue left unprobed: the two spellings of ONE type
        // (ADR-0104) must have the SAME backing dictionary. On 3e5103de the
        // `Dictionary` spelling was green and the `map` spelling was not, so
        // this assignment failed with
        // `[found ref Dictionary`2<string,int32>]
        //  [expected ref Dictionary`2<string,Nullable`1<int32>>]`.
        yield return new object[]
        {
            "a-map-over-a-nullable-int-assigns-to-the-dictionary-spelling",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var d Dictionary[string, int32?] = map[string, int32?]{"a": 2}
                Console.WriteLine(d.Count.ToString())
                Console.WriteLine(d["a"].ToString())
            }

            main2()
            """,
            new[] { "1", "2" },
        };

        // Passing a `map[string, int32?]` to an OPEN `map[K, V]` parameter.
        // The open map itself was never the problem — it has no CLR type at
        // all — but the CLOSED argument's wrong backing dictionary reached the
        // call, so this row is red on 3e5103de too. Its non-nullable
        // instantiation is the genuine control.
        yield return new object[]
        {
            "an-open-map-parameter-called-with-a-nullable-value-argument",
            """
            package Demo
            import System

            func countVia[K, V](m map[K, V], probe K) int32 {
                if m.ContainsKey(probe) {
                    return m.Count
                }

                return 0
            }

            func main2() {
                var m = map[string, int32?]{"a": 1, "b": 2}
                Console.WriteLine(countVia[string, int32?](m, "a").ToString())
            }

            main2()
            """,
            new[] { "2" },
        };
    }

    /// <summary>
    /// The shapes that were already correct and must stay correct — in
    /// particular the nullable REFERENCE value, whose backing dictionary must
    /// keep the BARE underlying type.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> ControlCases()
    {
        // The non-nullable sibling: unchanged.
        yield return new object[]
        {
            "control-a-map-over-a-plain-int-value",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, int32]{"a": 1}
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m["a"].ToString())
            }

            main2()
            """,
            new[] { "1", "1" },
        };

        // A nullable REFERENCE value has no distinct runtime type, so its
        // backing dictionary is `Dictionary<string, string>` and must NOT gain
        // a `Nullable<>`. An over-broad fix that wrapped every
        // NullableTypeSymbol would break this row.
        yield return new object[]
        {
            "control-a-map-over-a-nullable-string-value-is-unaffected",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, string?]{"a": "x"}
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m.ContainsKey("a").ToString())
                Console.WriteLine(m.ContainsValue("x").ToString())
            }

            main2()
            """,
            new[] { "1", "True", "True" },
        };

        // The `Dictionary` spelling over a nullable value was already green;
        // it must remain so, and it is the shape the map spelling now matches.
        yield return new object[]
        {
            "control-the-dictionary-spelling-over-a-nullable-int-value",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var m = Dictionary[string, int32?]()
                m["a"] = 5
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m["a"].ToString())
            }

            main2()
            """,
            new[] { "1", "5" },
        };

        // A map over an IMPORTED non-nullable value: #4023's shape, kept here
        // so the reference-context changes cannot regress it unnoticed.
        yield return new object[]
        {
            "control-a-map-over-a-non-nullable-imported-struct",
            """
            package Demo
            import System
            import HelperLib

            func main2() {
                var p = ImportedPoint{}
                p.X = 7
                var m = map[string, ImportedPoint]{"a": p}
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m.ContainsKey("a").ToString())
            }

            main2()
            """,
            new[] { "1", "True" },
        };

        // An OPEN map over type parameters has no CLR type at all; the fix
        // changes only how a CLOSED one is built. Instantiated at a
        // NON-nullable value here so the row is genuinely green before and
        // after — the `int32?` instantiation is an accepted row instead,
        // because passing a `map[string, int32?]` was itself broken.
        yield return new object[]
        {
            "control-an-open-map-over-type-parameters",
            """
            package Demo
            import System

            func countVia[K, V](m map[K, V], probe K) int32 {
                if m.ContainsKey(probe) {
                    return m.Count
                }

                return 0
            }

            func main2() {
                var m = map[string, int32]{"a": 1, "b": 2}
                Console.WriteLine(countVia[string, int32](m, "a").ToString())
            }

            main2()
            """,
            new[] { "2" },
        };
    }

    /// <summary>
    /// A <c>map[K, V?]</c> over a nullable value type is backed by
    /// <c>Dictionary&lt;K, Nullable&lt;V&gt;&gt;</c>, so the program compiles,
    /// IL-verifies, runs, and prints what it claims.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(AcceptedCases))]
    public void AMapOverANullableValueType_EmitsVerifiableIl(string name, string source, string[] expectedLines)
    {
        RunCase("gs_4035_", name, source, expectedLines);
    }

    /// <summary>
    /// The rows that were already correct stay correct.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(ControlCases))]
    public void AShapeThatWasAlreadyCorrect_StaysCorrect(string name, string source, string[] expectedLines)
    {
        RunCase("gs_4035_control_", name, source, expectedLines);
    }

    private static void RunCase(string prefix, string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory(prefix).FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"'{name}' must compile:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");
            Assert.Equal(expectedLines, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string[] SplitLines(string output) => output
        .Split('\n')
        .Select(line => line.TrimEnd('\r'))
        .Where(line => line.Length > 0)
        .ToArray();

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "HelperLib",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "HelperLib.dll");
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
