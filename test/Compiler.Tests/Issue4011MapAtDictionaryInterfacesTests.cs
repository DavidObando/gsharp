// <copyright file="Issue4011MapAtDictionaryInterfacesTests.cs" company="GSharp">
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
/// Issue #4011: a <c>map[K, V]</c> reached an open <c>Dictionary[K, V]</c>
/// but not the interfaces that class implements, so
/// <c>IDictionary[K, V]</c> reported <c>GS0155</c> where the CLOSED spelling
/// of the very same conversion was accepted.
/// </summary>
/// <remarks>
/// <para><b>Root cause.</b> #3987 taught <c>Conversion</c> that a
/// <c>map[K, V]</c> IS a <c>Dictionary&lt;K, V&gt;</c> (ADR-0104) by SHAPE
/// rather than by comparing the two sides' <c>ClrType</c>s, which an open key
/// or value leaves null on the structural side and type-ERASED on the imported
/// side. It stopped at the concrete CLASS. The interfaces that class
/// implements had no rule of their own, and the reflective assignability rules
/// that would otherwise answer need a <c>ClrType</c> the open map does not
/// have — <c>MapTypeSymbol.MakeClrType</c> gives up the moment a key or value
/// has no CLR backing. So <c>map[string, int32] -&gt; IDictionary[string,
/// int32]</c> converted and <c>map[K, V] -&gt; IDictionary[K, V]</c> did not:
/// the one row where the two spellings of one conversion disagreed, and it
/// disagreed in the direction that rejects working code.</para>
/// <para><b>The rule.</b> A <c>map[K, V]</c> converts IMPLICITLY to each of
/// the five interfaces its <c>Dictionary&lt;K, V&gt;</c> backing implements
/// over its own key and value — <c>IDictionary[K, V]</c>,
/// <c>IReadOnlyDictionary[K, V]</c>, and <c>ICollection</c> /
/// <c>IReadOnlyCollection</c> / <c>IEnumerable</c> of
/// <c>KeyValuePair[K, V]</c> (with <c>sequence[KeyValuePair[K, V]]</c> as the
/// ADR-0040 alias spelling of the last) — recognised by shape, exactly as
/// #3987 recognised the class and #3982 recognised the channel. The conversion
/// emits no IL: the value on the stack already IS that interface.</para>
/// <para><b>Where it manifests, measured.</b> At an ASSIGNMENT and at a
/// G#-DECLARED parameter. NOT at an imported one: an imported call ranks its
/// argument on the ERASED shape, where an open map presents as
/// <c>Dictionary&lt;object, object&gt;</c> and is already CLR-assignable to
/// the equally erased <c>IDictionary&lt;object, object&gt;</c> parameter, so
/// no conversion is ever asked for. Every row in <see cref="AcceptedCases"/>
/// and <see cref="RejectedCases"/> is red on the parent commit; the
/// <see cref="InteropCases"/> row is green there and is kept as a
/// must-not-change row rather than as proof.</para>
/// <para><b>One-way by construction.</b> The source must be map-shaped and the
/// target must be one of the interfaces, so nothing here lets an
/// <c>IDictionary[K, V]</c> flow back into a <c>map[K, V]</c> — which is why
/// the interfaces were NOT folded into <c>MapTypeSymbol.TryGetMapShape</c>,
/// whose consumers would have read the pair as identity.</para>
/// <para><b>Predicted side effect: half right, and the issue names the wrong
/// parameter kind.</b> It predicted that <c>(map[K, V])?</c> at a non-nullable
/// open <c>IDictionary[K, V]</c> would start reporting <c>GS0154</c> — the
/// null-safety gate (#3999) declines to blame nullability when the argument's
/// NON-nullable form would not reach the parameter either, and before this fix
/// it would not. That is exactly what happens at a G#-DECLARED parameter, and
/// it is pinned below. At the IMPORTED parameter the issue actually names,
/// nothing changes and nothing did disagree: BOTH spellings are accepted,
/// before and after, because <c>BindClrParameterConversions</c> is lenient
/// about a CLR parameter's declared nullability in general. Both halves of
/// that measurement are pinned so the correction cannot be lost.</para>
/// </remarks>
public class Issue4011MapAtDictionaryInterfacesTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library the interop cases link against: genuine imported
    /// parameters typed as the dictionary interface family.
    /// </summary>
    private const string LibrarySource = """
        using System.Collections.Generic;

        namespace Interop;

        public static class MapProbes
        {
            public static int CountDictionary<K, V>(IDictionary<K, V> map) => map.Count;

            // The already-CLOSED imported slot, for the nullability
            // correction below: it must behave the same as the generic one.
            public static int CountClosed(IDictionary<string, int> map) => map.Count;

            public static int CountReadOnly<K, V>(IReadOnlyDictionary<K, V> map) => map.Count;

            public static int CountPairs<K, V>(IEnumerable<KeyValuePair<K, V>> pairs)
            {
                var n = 0;
                foreach (var _ in pairs)
                {
                    n++;
                }

                return n;
            }
        }
        """;

    /// <summary>
    /// The rows this issue fixes: an OPEN map reaching each interface its
    /// backing class implements, beside the CLOSED spelling that already
    /// worked. Each case prints the two answers so a disagreement is visible.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> AcceptedCases()
    {
        // The reported row, and the full family beside it.
        yield return new object[]
        {
            "an-open-map-reaches-every-dictionary-interface",
            """
            package Demo
            import System
            import System.Collections.Generic

            func countVia[K, V](m map[K, V]) int32 {
                var d IDictionary[K, V] = m
                var r IReadOnlyDictionary[K, V] = m
                var c ICollection[KeyValuePair[K, V]] = m
                var rc IReadOnlyCollection[KeyValuePair[K, V]] = m
                var e IEnumerable[KeyValuePair[K, V]] = m
                var s sequence[KeyValuePair[K, V]] = m
                var n int32 = 0
                for kv in s {
                    n = n + 1
                }

                var m2 int32 = 0
                for kv in e {
                    m2 = m2 + 1
                }

                return d.Count + r.Count + c.Count + rc.Count + n + m2
            }

            func main2() {
                var m = map[string, int32]{"a": 1, "b": 2}
                Console.WriteLine(countVia[string, int32](m).ToString())
            }

            main2()
            """,
            new[] { "12" },
        };

        // The CLOSED spelling of the same conversions, which already worked.
        // Kept beside the open one so the two are read together: the whole
        // claim of this issue is that they must agree.
        yield return new object[]
        {
            "the-closed-spelling-still-reaches-every-dictionary-interface",
            """
            package Demo
            import System
            import System.Collections.Generic

            func countVia(m map[string, int32]) int32 {
                var d IDictionary[string, int32] = m
                var r IReadOnlyDictionary[string, int32] = m
                var c ICollection[KeyValuePair[string, int32]] = m
                var e IEnumerable[KeyValuePair[string, int32]] = m
                return d.Count + r.Count + c.Count
            }

            func main2() {
                var m = map[string, int32]{"a": 1, "b": 2}
                Console.WriteLine(countVia(m).ToString())
            }

            main2()
            """,
            new[] { "6" },
        };

        // The class arm #3987 fixed, restated as the control: this PR extends
        // that rule to the interfaces and must not disturb it.
        yield return new object[]
        {
            "control-an-open-map-still-reaches-the-concrete-dictionary",
            """
            package Demo
            import System
            import System.Collections.Generic

            func toDictionary[K, V](m map[K, V]) int32 {
                var d Dictionary[K, V] = m
                return d.Count
            }

            func main2() {
                var m = map[string, int32]{"a": 1, "b": 2, "c": 3}
                Console.WriteLine(toDictionary[string, int32](m).ToString())
            }

            main2()
            """,
            new[] { "3" },
        };

        // A SAME-COMPILATION element is the other half of "no CLR identity",
        // and takes the identical path: the map's ClrType is null for the same
        // reason, so the same arm has to answer.
        yield return new object[]
        {
            "a-map-over-a-same-compilation-element-reaches-the-interfaces",
            """
            package Demo
            import System
            import System.Collections.Generic

            struct Pair { var X int32 }

            func main2() {
                var m = map[string, Pair]{"a": Pair{X: 1}, "b": Pair{X: 2}}
                var d IDictionary[string, Pair] = m
                var e IEnumerable[KeyValuePair[string, Pair]] = m
                Console.WriteLine(d.Count.ToString())
                Console.WriteLine(d["b"].X.ToString())
            }

            main2()
            """,
            new[] { "2", "2" },
        };

        // The NULLABLE row, which the fix reaches through #3843's widening
        // rather than through the new arm itself (the arm declines a nullable
        // pair by design, leaving the lifted rules their say). It has an
        // emitter arm of its own: a `map[K, V]?` is a `Dictionary<K, V>`
        // reference with an annotation, so the wrappers are stripped and the
        // upcast emits the same nothing. Before this PR it was accepted only
        // because NO conversion existed at all; the moment one did, the
        // emitter crashed with GS9998 until the wrappers were stripped, which
        // is why this row executes rather than merely compiling.
        yield return new object[]
        {
            "a-nullable-open-map-reaches-a-nullable-interface",
            """
            package Demo
            import System
            import System.Collections.Generic

            func takeNullable[K, V](d (IDictionary[K, V])?) int32 {
                if d == nil {
                    return 0
                }

                return 1
            }

            func passNullable[K, V](m (map[K, V])?) int32 {
                return takeNullable[K, V](m)
            }

            func main2() {
                var m = map[string, int32]{"a": 1}
                Console.WriteLine(passNullable[string, int32](m).ToString())
            }

            main2()
            """,
            new[] { "1" },
        };
    }

    /// <summary>
    /// Rows that must still be REFUSED. The new arm is one-way and
    /// element-exact; nothing about it may widen the lattice.
    /// </summary>
    /// <returns>Name, G# source, a substring the diagnostics must name.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // The reverse direction. An `IDictionary[K, V]` is not necessarily a
        // `Dictionary[K, V]`, so nothing here may make it one.
        yield return new object[]
        {
            "an-open-dictionary-interface-does-not-flow-back-into-a-map",
            """
            package Demo
            import System
            import System.Collections.Generic

            func fromInterface[K, V](d IDictionary[K, V]) int32 {
                var m map[K, V] = d
                return 1
            }

            Console.WriteLine("x")
            """,
            "Cannot convert type",
        };

        // Element-exact: the interface's own arguments must be the map's own
        // key and value, not merely something the erasure could confuse them
        // with.
        yield return new object[]
        {
            "an-open-map-does-not-reach-a-dictionary-interface-of-other-elements",
            """
            package Demo
            import System
            import System.Collections.Generic

            func mismatched[K, V](m map[K, V]) int32 {
                var d IDictionary[V, K] = m
                return 1
            }

            Console.WriteLine("x")
            """,
            "Cannot convert type",
        };

        // The side effect the issue predicted. Before this fix the null-safety
        // gate (#3999) declined to blame nullability, because the NON-nullable
        // form would not have reached the parameter either — for exactly the
        // reason this issue exists. With the conversion in place the row is
        // now a plain nullability error, which is the correct answer.
        yield return new object[]
        {
            "a-nullable-open-map-at-a-non-nullable-interface-is-a-nullability-error",
            """
            package Demo
            import System
            import System.Collections.Generic

            func takeIt[K, V](d IDictionary[K, V]) int32 { return 1 }

            func pass[K, V](m (map[K, V])?) int32 {
                return takeIt[K, V](m)
            }

            Console.WriteLine("x")
            """,
            "GS0154",
        };
    }

    /// <summary>
    /// An open <c>map[K, V]</c> at a genuine IMPORTED interface parameter —
    /// a MUST-NOT-CHANGE row, not proof.
    /// </summary>
    /// <remarks>
    /// <para>Review feedback on #4030 was right twice over. The map is now
    /// passed DIRECTLY to each probe: an earlier draft converted it to
    /// interface-typed locals first, so the imported parameter received an
    /// interface and the argument boundary was never crossed (the row did fail
    /// on the parent commit, but on the local assignments, not on the
    /// call).</para>
    /// <para>And once corrected, the row is GREEN on the parent commit too —
    /// measured, not assumed. An imported call ranks its argument on the
    /// ERASED shape, where an open <c>map[K, V]</c> presents as
    /// <c>Dictionary&lt;object, object&gt;</c>
    /// (<c>MemberLookup.TryProjectErasedClrType</c>) and is CLR-assignable to
    /// the equally erased <c>IDictionary&lt;object, object&gt;</c> parameter,
    /// so the argument is left alone and no conversion is ever asked for. That
    /// is the same reason the nullability correction above holds: at an
    /// IMPORTED parameter this issue does not manifest at all. It manifests at
    /// an assignment and at a G#-DECLARED parameter, which is where
    /// <see cref="AcceptedCases"/> and <see cref="RejectedCases"/> measure it
    /// — every one of those rows IS red on the parent.</para>
    /// </remarks>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> InteropCases()
    {
        yield return new object[]
        {
            "interop-an-open-map-reaches-an-imported-dictionary-interface-parameter",
            """
            package Demo
            import System
            import System.Collections.Generic
            import Interop

            func countVia[K, V](m map[K, V]) int32 {
                return MapProbes.CountDictionary[K, V](m)
                    + MapProbes.CountReadOnly[K, V](m)
                    + MapProbes.CountPairs[K, V](m)
            }

            func main2() {
                var m = map[string, int32]{"a": 1, "b": 2}
                Console.WriteLine(countVia[string, int32](m).ToString())
            }

            main2()
            """,
            new[] { "6" },
        };
    }

    /// <summary>
    /// An open map reaches the interfaces its backing implements, and the
    /// program compiles, IL-verifies, runs, and prints what it claims.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(AcceptedCases))]
    public void AnOpenMap_ReachesTheInterfacesItsBackingImplements(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4011_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");
            Assert.True(File.Exists(appPath), $"'{name}' must compile:\n{appLog}");

            IlVerifier.Verify(appPath);

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");
            Assert.Equal(expectedLines, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The lattice stays one-way and element-exact.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedMention">A substring the diagnostics must name.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void APairTheLatticeDoesNotRelate_IsStillRefused(string name, string source, string expectedMention)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4011_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The conversion also holds at a genuine imported parameter — where,
    /// measured, it already held before this fix. See <see cref="InteropCases"/>.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(InteropCases))]
    public void AnOpenMap_StillReachesAnImportedInterfaceParameter(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4011_interop_").FullName;
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

    /// <summary>
    /// The issue's predicted side effect, measured at BOTH parameter kinds —
    /// and the issue names the wrong one.
    /// </summary>
    /// <remarks>
    /// <para>The issue says a <c>(map[K, V])?</c> at an open IMPORTED
    /// <c>IDictionary[K, V]</c> parameter is silently accepted while the
    /// closed <c>(map[string, int32])?</c> at
    /// <c>IDictionary[string, int32]</c> correctly reports <c>GS0154</c>, and
    /// predicts this fix will make the open one report <c>GS0154</c> too.
    /// Measured on the parent commit and on this one: at an IMPORTED parameter
    /// BOTH spellings are accepted, before and after, whether the imported
    /// method is generic (<c>CountDictionary[K, V]</c>) or takes an already
    /// closed <c>IDictionary&lt;string, int&gt;</c> (<c>CountClosed</c>). That
    /// is <c>BindClrParameterConversions</c>' standing leniency about a CLR
    /// parameter's DECLARED nullability — the same reason a <c>string?</c>
    /// reaches an imported <c>string</c> parameter — and it has nothing to do
    /// with this issue. The two spellings AGREE there, so there was no
    /// asymmetry to fix.</para>
    /// <para>The prediction IS right about a G#-DECLARED parameter, which is
    /// where the null-safety gate (#3999) applies: the closed spelling
    /// reported <c>GS0154</c> before this fix and still does, and the open
    /// spelling was silently accepted and now reports <c>GS0154</c> as well.
    /// That row is pinned in <see cref="RejectedCases"/> as
    /// <c>a-nullable-open-map-at-a-non-nullable-interface-is-a-nullability-error</c>,
    /// and its closed twin is the second test below. Both halves are pinned so
    /// the correction cannot be lost.</para>
    /// </remarks>
    [Fact]
    public void ANullableMap_AtAnImportedInterfaceParameter_IsAcceptedInBothSpellings()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4011_nullable_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            const string OpenSource = """
                package Demo
                import System
                import System.Collections.Generic
                import Interop

                func pass[K, V](m (map[K, V])?) int32 {
                    return MapProbes.CountDictionary[K, V](m)
                }

                Console.WriteLine("x")
                """;

            var openPath = Path.Combine(tempDir, "open.dll");
            var openLog = Compile(tempDir, "Open.gs", OpenSource, openPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(openPath), $"the open spelling is accepted at an imported parameter:\n{openLog}");
            Assert.DoesNotContain("GS9998", openLog, StringComparison.Ordinal);

            const string ClosedSource = """
                package Demo
                import System
                import System.Collections.Generic
                import Interop

                func pass(m (map[string, int32])?) int32 {
                    return MapProbes.CountClosed(m)
                }

                Console.WriteLine("x")
                """;

            var closedPath = Path.Combine(tempDir, "closed.dll");
            var closedLog = Compile(tempDir, "Closed.gs", ClosedSource, closedPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(closedPath), $"and so is the closed spelling — the two agree:\n{closedLog}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The other half of the correction: at a G#-DECLARED parameter the CLOSED
    /// spelling reported <c>GS0154</c> before this fix too, so the two
    /// spellings there now agree on the error rather than disagreeing.
    /// </summary>
    [Fact]
    public void ANullableClosedMap_AtADeclaredNonNullableInterfaceParameter_StillReportsGS0154()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4011_closednull_").FullName;
        try
        {
            const string Source = """
                package Demo
                import System
                import System.Collections.Generic

                func takeClosed(d IDictionary[string, int32]) int32 { return 1 }

                func pass(m (map[string, int32])?) int32 {
                    return takeClosed(m)
                }

                Console.WriteLine("x")
                """;

            var appPath = Path.Combine(tempDir, "closedNull.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe");
            Assert.False(File.Exists(appPath), $"the closed spelling must not compile. Log:\n{appLog}");
            Assert.Contains("GS0154", appLog, StringComparison.Ordinal);
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
