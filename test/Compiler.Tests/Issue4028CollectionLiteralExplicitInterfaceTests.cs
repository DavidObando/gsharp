// <copyright file="Issue4028CollectionLiteralExplicitInterfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4028: a collection literal — and an ordinary call with a
/// same-compilation argument — still reached an explicitly-implemented
/// interface member, so <c>List[int32]{"x"}</c> compiled and threw.
/// </summary>
/// <remarks>
/// <para><b>What #4013 left open, and why.</b> #4013 took every abstract
/// interface member off a class's own surface, which is what C# does, and
/// <c>List[int32]().Add("x")</c> became <c>GS0159</c>. But the narrowing is
/// applied at candidate COLLECTION, which is memoized on <c>(Type, name)</c> and
/// cannot see arguments, so two exemptions had to be cut there instead — a
/// synthesized collection-initializer <c>Add</c>, and a call carrying a
/// same-compilation argument — and both re-admitted
/// <c>System.Collections.IList.Add(object)</c> and
/// <c>System.Collections.IDictionary.Add(object, object)</c> to calls that had
/// no erasure to repair. <c>List[int32]{"x"}</c> and
/// <c>Dictionary[string, int32]{"a": "x"}</c> went on compiling and throwing
/// <c>ArgumentException</c> from inside the BCL.</para>
/// <para><b>The three tests that forced the exemptions, and what changed for
/// them.</b></para>
/// <list type="number">
/// <item><c>Issue3096CollectionSpreadEmitTests.FieldPropertyAndCollectionSpreads…</c>
/// fills a <c>Dictionary[K, V]</c> through the explicitly-implemented
/// <c>ICollection&lt;KeyValuePair&lt;K, V&gt;&gt;.Add</c>. That member is on a
/// GENERIC interface, so on a constructed class receiver it is closed over the
/// receiver's own type arguments and cannot widen to <c>object</c> — it is not a
/// hazard and is not a target of this fix at all. It needs no exemption; it
/// simply is not touched.</item>
/// <item><c>Issue3096CollectionSpreadEmitTests.UserDefinedSpreadConversions…</c>
/// spreads a <c>[]Celsius</c> into a <c>List[float64]</c>. A same-compilation
/// struct has no CLR type while binding, so the element erases to
/// <c>object</c> and cannot match <c>Add(double)</c> — but the user-defined
/// conversion <c>Celsius -&gt; float64</c> EXISTS, and asking the conversion
/// classifier about the receiver's own <c>Add</c> on the real types finds it. That is a genuine erasure to repair, so the widening member stays. The
/// exemption is no longer needed because the question is now asked directly
/// rather than approximated by "some argument is same-compilation".</item>
/// <item><c>Issue2918InlineLambdaErasedReceiverTests.ImportedGenericReceiverMethods…</c>
/// adds a <c>(item Mode) -&gt; …</c> lambda to a
/// <c>List[System.Action[Mode]]</c>. Here the RECEIVER carries the
/// same-compilation type: it is built over the flat <c>System.Object</c>
/// placeholder of the generic-CONSTRUCTION path and presents as
/// <c>List&lt;Action&lt;object&gt;&gt;</c>, while the lambda erases the enum and
/// presents as <c>Action&lt;int&gt;</c>. Its own members' parameter types are
/// surrogates, so nothing here can judge the call and the widening member
/// stays. That is #4016's defect one site over — the two erasers of one type
/// disagree — and it is still open; this fixture's row keeps it working until
/// it is fixed there.</item>
/// </list>
/// <para><b>What is left is the reported hole and only it.</b> A genuine
/// <c>string</c> at a genuine <c>int32</c>, or a same-compilation
/// <c>Celsius</c> at an <c>int32</c> it does not convert to: no erasure to
/// repair, so the widening member goes and the call reports <c>GS0159</c> — the
/// same diagnostic the author-written form already reported, which is the bar
/// the issue sets.</para>
/// <para><b>Why not the fix order the issue's comment suggests.</b> It proposes
/// repairing the generic-CONSTRUCTION placeholder the way #4016 repaired the
/// method-type-argument one, so exemption (3) closes by deletion. Measured
/// against the cost: #4016's own version of that change leaked its surrogate
/// into a sibling type parameter's CONSTRAINT and took the
/// <c>cs2gs-code-exploder</c> gate red, and needed
/// <c>NormaliseErasedTypeArgsForConstraintCheck</c> to survive. The
/// construction-site placeholder is load-bearing for every constructed generic
/// in the language rather than for one call's type-argument list, so the same
/// change there is a larger blast radius than this issue. Both of the shapes
/// #4028 actually reports close without it, at applicability, which is where the
/// issue's own body says the discrimination has to happen. The Issue2918
/// disagreement stays filed as #4016-adjacent work.</para>
/// <para><b>Out of scope, measured.</b>
/// <c>List[float64]().Add(someCelsius)</c> — the author-written form of row (2),
/// with the user-defined conversion in scope — compiles and throws
/// <c>ArgumentException</c> on <c>main</c> and still does: the widening member
/// is correctly kept (the conversion exists), but the ordinary call path binds
/// it instead of applying the conversion at the type's own <c>Add(double)</c>.
/// That is a conversion-application bug, not a candidacy one; filed as
/// #4036.</para>
/// <para><b>A case the review raised, and what it measures as.</b> A collection
/// literal whose ELEMENT type is declared in this compilation —
/// <c>enum Mode { First }; List[Mode]{"x"}</c> — was suggested to be an open
/// hole, on the reading that keeping the member for an erased receiver waves it
/// through. It does not: such a receiver binds its own <c>Add</c> through the
/// SYMBOLIC member path, where the argument is converted against the real
/// element type, so the wrong element is refused with <c>GS0155</c> before any
/// widening member is reached — in the literal form and the author-written form
/// alike, and on <c>main</c> as well as here. Rows below pin it for an enum, a
/// class and an author-written call.</para>
/// <para>Not channel business, so no ADR-0174 erratum.</para>
/// </remarks>
public class Issue4028CollectionLiteralExplicitInterfaceTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The calls that reached a widening explicit-interface member with nothing
    /// to repair, and are refused now.
    /// </summary>
    /// <returns>Case name, G# source, expected diagnostic id.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // RED BEFORE: compiled; threw ArgumentException from
        // List<int>.System.Collections.IList.Add(object). The issue's repro.
        yield return new object[]
        {
            "a-collection-literal-with-a-wrong-element-no-longer-reaches-ilist-add",
            """
            package P
            import System
            import System.Collections.Generic

            let ys = List[int32]{"x"}
            Console.WriteLine(ys.Count)
            """,
            "GS0159",
        };

        // RED BEFORE: the same hole one interface over —
        // Dictionary<K, V>.System.Collections.IDictionary.Add(object, object).
        yield return new object[]
        {
            "a-dictionary-literal-with-a-wrong-value-no-longer-reaches-idictionary-add",
            """
            package P
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]{"a": "x"}
            Console.WriteLine(d.Count)
            """,
            "GS0159",
        };

        // RED BEFORE: the comment's second shape — an ordinary call whose
        // argument carries a same-compilation type that does NOT convert.
        yield return new object[]
        {
            "an-ordinary-call-with-a-same-compilation-argument-that-does-not-convert",
            """
            package P
            import System
            import System.Collections.Generic

            struct Celsius {
                var Degrees float64
            }

            let ys = List[int32]()
            ys.Add(Celsius{ Degrees: 2.5 })
            Console.WriteLine(ys.Count)
            """,
            "GS0159",
        };

        // RED BEFORE: the two-argument form of the same, on IDictionary.
        yield return new object[]
        {
            "a-dictionary-add-with-a-same-compilation-argument-that-does-not-convert",
            """
            package P
            import System
            import System.Collections.Generic

            struct Celsius {
                var Degrees float64
            }

            let d = Dictionary[string, int32]()
            d.Add("a", Celsius{ Degrees: 1.0 })
            Console.WriteLine(d.Count)
            """,
            "GS0159",
        };

        // Review finding: a collection literal whose ELEMENT type is declared
        // in this compilation was suggested to be an open hole, on the reading
        // that the erased-receiver escape waves it through. Measured, it is
        // not: a `List[Mode]` / `List[Thing]` / `List[Celsius]` receiver binds
        // its own `Add` through the SYMBOLIC member path, where the argument is
        // converted against the real element type, so a wrong element is
        // refused with GS0155 before any widening member can be reached — in
        // the literal form and the author-written form alike, and before this
        // PR as well as after. Pinned in all three element kinds so the claim
        // is checked rather than argued.
        yield return new object[]
        {
            "a-literal-of-a-same-compilation-enum-refuses-a-wrong-element",
            """
            package P
            import System
            import System.Collections.Generic

            enum Mode { First }

            let xs = List[Mode]{"x"}
            Console.WriteLine(xs.Count)
            """,
            "GS0155",
        };

        yield return new object[]
        {
            "a-literal-of-a-same-compilation-class-refuses-a-wrong-element",
            """
            package P
            import System
            import System.Collections.Generic

            class Thing {
            }

            let xs = List[Thing]{"x"}
            Console.WriteLine(xs.Count)
            """,
            "GS0155",
        };

        yield return new object[]
        {
            "an-author-written-add-of-a-same-compilation-element-refuses-it-too",
            """
            package P
            import System
            import System.Collections.Generic

            enum Mode { First }

            let xs = List[Mode]()
            xs.Add("x")
            Console.WriteLine(xs.Count)
            """,
            "GS0155",
        };

        // GREEN BEFORE (already refused by #4013). The author-written control
        // this issue's Expected section measures itself against: the literal
        // must now report what this reports.
        yield return new object[]
        {
            "the-author-written-control-still-reports-the-same-diagnostic",
            """
            package P
            import System
            import System.Collections.Generic

            let ys = List[int32]()
            ys.Add("x")
            Console.WriteLine(ys.Count)
            """,
            "GS0159",
        };
    }

    /// <summary>
    /// The neighbours that must keep binding: the three dependencies #4013
    /// measured, and the ordinary well-typed spellings.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> BindingCases()
    {
        // Dependency (1): a GENERIC explicit interface member, never a target.
        yield return new object[]
        {
            "a-dictionary-spread-still-fills-through-the-explicit-generic-add",
            """
            package P
            import System
            import System.Collections.Generic

            let pairs = []KeyValuePair[string, int32]{
                KeyValuePair[string, int32]("a", 1),
                KeyValuePair[string, int32]("b", 2),
            }
            let d = Dictionary[string, int32](){ ...pairs }
            Console.WriteLine(d.Count)
            """,
            new[] { "2" },
        };

        // Dependency (2): a genuine erasure to repair — the conversion exists.
        yield return new object[]
        {
            "a-user-defined-spread-conversion-still-reaches-the-widening-add",
            """
            package P
            import System
            import System.Collections.Generic

            struct Celsius {
                var Degrees float64
            }

            func operator implicit(value Celsius) float64 {
                return value.Degrees
            }

            let source = []Celsius{ Celsius{ Degrees: 2.5 } }
            let array = []float64{ ...source }
            let list = List[float64](){ ...source }
            Console.WriteLine(array[0])
            Console.WriteLine(list[0])
            """,
            new[] { "2.5", "2.5" },
        };

        // Dependency (3): an ERASED RECEIVER, whose own members are surrogates.
        yield return new object[]
        {
            "an-erased-receiver-still-reaches-the-widening-add",
            """
            package P
            import System
            import System.Collections.Generic

            enum Mode { First, Second }

            let enumCallbacks = List[System.Action[Mode]]()
            enumCallbacks.Add((item Mode) -> Console.WriteLine(17))
            enumCallbacks[0](Mode.Second)
            """,
            new[] { "17" },
        };

        // A well-typed literal binds the type's OWN Add, as it always did.
        yield return new object[]
        {
            "a-well-typed-collection-literal-still-binds-the-types-own-add",
            """
            package P
            import System
            import System.Collections.Generic

            let ys = List[int32]{1, 2, 3}
            Console.WriteLine(ys.Count)
            Console.WriteLine(ys[2])
            """,
            new[] { "3", "3" },
        };

        // A well-typed map literal, the sibling of the rejected row above.
        yield return new object[]
        {
            "a-well-typed-dictionary-literal-still-binds",
            """
            package P
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]{"a": 1, "b": 2}
            Console.WriteLine(d.Count)
            Console.WriteLine(d["b"])
            """,
            new[] { "2", "2" },
        };

        // An INTERFACE-typed receiver still reaches the member for real — the
        // "Expected" #4013 gives for anyone who wants IList.Add(object).
        yield return new object[]
        {
            "an-interface-typed-receiver-still-reaches-the-widening-member",
            """
            package P
            import System
            import System.Collections
            import System.Collections.Generic

            let ys = List[int32]()
            cast[IList](ys).Add(7)
            Console.WriteLine(ys.Count)
            Console.WriteLine(ys[0])
            """,
            new[] { "1", "7" },
        };

        // A same-compilation element in a literal of its OWN type: the argument
        // is erased, but the type's own Add takes it, so nothing is dropped.
        yield return new object[]
        {
            "a-literal-of-a-same-compilation-element-still-binds",
            """
            package P
            import System
            import System.Collections.Generic

            struct Celsius {
                var Degrees float64
            }

            let xs = List[Celsius]{ Celsius{ Degrees: 1.5 } }
            Console.WriteLine(xs.Count)
            Console.WriteLine(xs[0].Degrees)
            """,
            new[] { "1", "1.5" },
        };
    }

    /// <summary>
    /// A call with a genuine argument that simply does not fit no longer reaches
    /// a widening explicitly-implemented interface member.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void AWideningExplicitInterfaceMember_IsNotReachedWithNothingToRepair(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4028_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Every legitimate neighbour still binds, compiles to verifiable IL and
    /// runs — including the three dependencies #4013 measured.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(BindingCases))]
    public void ALegitimateNeighbour_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4028_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath);

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
