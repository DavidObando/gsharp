// <copyright file="Issue3924DirectionalChannelStructuralElementTests.cs" company="GSharp">
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
/// Issue #3924: a channel whose element is a STRUCTURAL G# type — <c>[]int32</c>,
/// <c>map[string,int32]</c>, <c>[][]int32</c> — did not convert to the
/// <c>in</c>/<c>out</c> directional view (ADR-0174 D2), while the identical
/// conversion over a named element (<c>int32</c>, <c>string</c>, a
/// same-compilation <c>struct</c>) bound fine.
/// </summary>
/// <remarks>
/// <para>Root cause: the direction lattice compares the two sides' element
/// types by SYMBOL shape. A channel recovered from CLR metadata — both the
/// constructed <c>Gsharp.Concurrency.Chan&lt;T&gt;</c> that <c>chan[T](n)</c>
/// builds and a foreign BCL <c>Channel&lt;T&gt;</c> — carries whatever
/// <c>TypeSymbol.FromClrType</c> mints for the reflected type argument, and a
/// structural shape has no CLR counterpart symbol: <c>[]int32</c> comes back as
/// an <c>ImportedTypeSymbol</c> over <c>int32[]</c>, never the
/// <c>SliceTypeSymbol</c> the <c>chan[T]</c> type clause bound. The elements
/// denote ONE runtime type, so the CLR-type comparison the fix adds is the
/// question <c>Channel&lt;T&gt;</c>'s invariance actually asks.</para>
/// <para>Discrimination (ADR-0154): every executable case below failed with
/// GS0154 at bind on the pre-fix build (measured on <c>ffa46214</c>) EXCEPT
/// <c>struct-slice-element</c>, which travels the symbolic-type-argument branch
/// and passed before and after — it is the control that keeps a blanket
/// "any channel converts to any channel" mutant from passing. The negative
/// facts pin the other edge: a mismatched element (<c>[]int64</c> for
/// <c>[]int32</c>), a nullable element (<c>int32?</c> for <c>int32</c> — the
/// case that forces the EFFECTIVE CLR type, since a
/// <c>NullableTypeSymbol</c> borrows its underlying type's <c>ClrType</c>), and
/// <c>in</c> → <c>out</c> must all still be rejected. Three more are green
/// before and after, and pin the fallback's "one side came back from
/// reflection carrying no symbolic type arguments" guard: a fixed-array length
/// mismatch between two type clauses, and two shapes over a source-constructed
/// generic element, whose <c>ClrType</c> has erased the very arguments that
/// distinguish it (<c>List[Foo]</c> and <c>List[Bar]</c> over two
/// same-compilation structs are one <c>List&lt;object&gt;</c>).</para>
/// <para>Every case compiles, IL-verifies AND runs: binding alone cannot tell
/// whether <c>get_Reader</c>/<c>get_Writer</c> was really emitted for a
/// structural element, which is the half of the fix that reaches metadata.</para>
/// </remarks>
public class Issue3924DirectionalChannelStructuralElementTests
{
    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        yield return new object[]
        {
            "slice-element-out-and-in",
            """
            package P
            import System

            func produce(w out chan[[]int32]) {
                w <- [3]int32{1, 2, 3}
                w <- [2]int32{4, 5}
                w.Close()
            }

            func consume(r in chan[[]int32]) int32 {
                var sum = 0
                for batch in r {
                    var i = 0
                    while i < batch.Length {
                        sum = sum + batch[i]
                        i = i + 1
                    }
                }

                return sum
            }

            let ch = chan[[]int32](4)
            produce(ch)
            Console.WriteLine(consume(ch))
            """,
            new[] { "15" },
        };

        yield return new object[]
        {
            "map-element-out-and-in",
            """
            package P
            import System

            func produce(w out chan[map[string,int32]]) {
                var m = map[string,int32]{}
                m["a"] = 2
                m["b"] = 3
                w <- m
                w.Close()
            }

            func consume(r in chan[map[string,int32]]) int32 {
                var total = 0
                for entry in r {
                    total = total + entry["a"] + entry["b"]
                }

                return total
            }

            let ch = chan[map[string,int32]](2)
            produce(ch)
            Console.WriteLine(consume(ch))
            """,
            new[] { "5" },
        };

        yield return new object[]
        {
            "nested-slice-element",
            """
            package P
            import System

            func produce(w out chan[[][]int32]) {
                var outer = [2][]int32{}
                outer[0] = [2]int32{1, 2}
                outer[1] = [1]int32{4}
                w <- outer
                w.Close()
            }

            func consume(r in chan[[][]int32]) int32 {
                var sum = 0
                for rows in r {
                    var i = 0
                    while i < rows.Length {
                        var j = 0
                        while j < rows[i].Length {
                            sum = sum + rows[i][j]
                            j = j + 1
                        }

                        i = i + 1
                    }
                }

                return sum
            }

            let ch = chan[[][]int32](2)
            produce(ch)
            Console.WriteLine(consume(ch))
            """,
            new[] { "7" },
        };

        yield return new object[]
        {
            "slice-of-string-element",
            """
            package P
            import System

            func produce(w out chan[[]string]) {
                w <- [2]string{"a", "b"}
                w.Close()
            }

            let ch = chan[[]string](2)
            produce(ch)
            for parts in ch {
                Console.WriteLine(parts[0] + parts[1])
            }
            """,
            new[] { "ab" },
        };

        // Control: a same-compilation struct element has no reference-context
        // CLR type, so `chan[[]Point](2)` closes over a symbolic type argument
        // and `TryGetChannelShape` reads the ORIGINAL element symbol back out
        // of `TypeArguments[0]`. This bound before the fix and must keep
        // binding after it.
        yield return new object[]
        {
            "struct-slice-element",
            """
            package P
            import System

            struct Point {
                var X int32
            }

            func produce(w out chan[[]Point]) {
                var arr = [1]Point{}
                arr[0].X = 9
                w <- arr
                w.Close()
            }

            let ch = chan[[]Point](2)
            produce(ch)
            for points in ch {
                Console.WriteLine(points[0].X)
            }
            """,
            new[] { "9" },
        };

        // A foreign BCL channel is the case the fix must cover that no amount
        // of preserving G# element symbols at CONSTRUCTION could: this
        // `Channel<int32[]>` was never built by `chan[T](n)`, so its element
        // exists only as reflected CLR metadata.
        yield return new object[]
        {
            "foreign-bcl-channel-with-slice-element",
            """
            package P
            import System
            import System.Threading.Channels

            func produce(w out chan[[]int32]) {
                w <- [2]int32{10, 20}
                w.Close()
            }

            func consume(r in chan[[]int32]) int32 {
                var sum = 0
                for batch in r {
                    var i = 0
                    while i < batch.Length {
                        sum = sum + batch[i]
                        i = i + 1
                    }
                }

                return sum
            }

            let ch = Channel.CreateBounded[[]int32](2)
            produce(ch)
            Console.WriteLine(consume(ch))
            """,
            new[] { "30" },
        };
    }

    /// <summary>
    /// Gets the rejection cases: each is (name, source, the expected substring
    /// of the reported diagnostic).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        yield return new object[]
        {
            "mismatched-slice-element",
            """
            package P

            func wants(w out chan[[]int32]) {
            }

            let wrong = chan[[]int64](1)
            wants(wrong)
            """,
            "requires a value of type 'out chan[[]int32]'",
        };

        yield return new object[]
        {
            "nullable-element-is-not-the-bare-element",
            """
            package P

            func wants(w out chan[int32?]) {
            }

            let plain = chan[int32](1)
            wants(plain)
            """,
            "requires a value of type 'out chan[int32?]'",
        };

        // A no-regression pin, green before and after: where BOTH sides still
        // carry their G# symbols, the fixed length discriminates, and the
        // CLR-type fallback must not reach them — `[3]int32` and `[4]int32`
        // are one `int32[]`. A mutant that drops the fallback's
        // "one side came back from metadata" guard compiles this.
        yield return new object[]
        {
            "fixed-array-lengths-still-discriminate",
            """
            package P

            func wants(w out chan[[4]int32]) {
            }

            var a chan[[3]int32] = chan[[3]int32](1)
            wants(a)
            """,
            "requires a value of type 'out chan[[4]int32]'",
        };

        // A source-constructed generic still holds its type arguments as
        // SYMBOLS, and its own `ClrType` may have erased them to close over
        // `object`: `List[Foo]` and `List[Bar]` over two same-compilation
        // structs are one `List<object>`. Comparing that would conflate two
        // elements that are not the same type at all — ordinary assignment
        // rejects `List[Bar]` to `List[Foo]` with GS0155 — so the fallback
        // must not reach a source-constructed element. A mutant that widens
        // the guard from "no symbolic type arguments" to "any imported
        // symbol" compiles both of these.
        yield return new object[]
        {
            "source-constructed-generic-elements-are-not-conflated",
            """
            package P
            import System.Collections.Generic

            struct Foo {
                var X int32
            }

            struct Bar {
                var Y int32
            }

            func wants(w out chan[List[Foo]]) {
            }

            var barChan chan[List[Bar]] = chan[List[Bar]](1)
            wants(barChan)
            """,
            "requires a value of type 'out chan[System.Collections.Generic.List[Foo]]'",
        };

        yield return new object[]
        {
            "fixed-array-length-inside-a-constructed-generic-element",
            """
            package P
            import System.Collections.Generic

            struct Foo {
                var X int32
            }

            func wants(w out chan[List[[4]Foo]]) {
            }

            var nested chan[List[[3]Foo]] = chan[List[[3]Foo]](1)
            wants(nested)
            """,
            "requires a value of type 'out chan[System.Collections.Generic.List[[4]Foo]]'",
        };

        yield return new object[]
        {
            "receive-only-does-not-satisfy-send-only",
            """
            package P

            func wants(w out chan[[]int32]) {
            }

            func pass(r in chan[[]int32]) {
                wants(r)
            }
            """,
            "requires a value of type 'out chan[[]int32]'",
        };
    }

    /// <summary>
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void DirectionalChannel_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3924_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, name + ".dll");
            var (exitCode, diagnostics) = Compile(tempDir, source, outPath);
            Assert.True(exitCode == 0, $"gsc failed for '{name}':\n{diagnostics}");

            IlVerifier.Verify(outPath);

            var (exit, output) = RunDotnet(outPath);
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
    /// A channel whose element is merely CLR-compatible, not the same type,
    /// still fails to convert: the fix compares the element's effective CLR
    /// type, it does not wave every channel through.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedMessage">The expected diagnostic substring.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void MismatchedChannel_IsStillRejected(string name, string source, string expectedMessage)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3924_neg_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, name + ".dll");
            var (exitCode, diagnostics) = Compile(tempDir, source, outPath);
            Assert.True(exitCode != 0, $"'{name}' must not compile, but gsc succeeded.");
            Assert.Contains("GS0154", diagnostics, StringComparison.Ordinal);
            Assert.Contains(expectedMessage, diagnostics, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static (int ExitCode, string Diagnostics) Compile(string tempDir, string source, string outPath)
    {
        var srcPath = Path.Combine(tempDir, "Program.gs");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
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
            var exitCode = Program.Main(args.ToArray());
            return (exitCode, compileOut.ToString() + compileErr.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }
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
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
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
