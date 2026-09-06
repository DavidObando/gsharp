// <copyright file="Issue4020AwaitForOverAnOpenAsyncSequenceTests.cs" company="GSharp">
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
/// Issue #4020: <c>await for v in s</c> over an <c>async sequence[T]</c> whose
/// element has no CLR backing reported <c>GS0134</c> ("cannot be iterated with
/// 'await for'"), while the CLOSED <c>async sequence[int32]</c> spelling of the
/// same parameter iterated and the SYNCHRONOUS <c>for v in s</c> over an
/// equally open <c>sequence[T]</c> iterated too.
/// </summary>
/// <remarks>
/// <para><b>Root cause, two layers.</b>
/// <c>MemberLookup.TryGetAsyncEnumerableElementType</c> — the binder's gate for
/// the <c>await for</c> operand — recognised the shape only through
/// <c>ClrType</c>, and <c>AsyncSequenceTypeSymbol.MakeClrType</c> answers null
/// the moment the element is an in-scope type parameter or a same-compilation
/// class. That is the #3982 / #3987 / #4011 family exactly: a shape known by
/// its <c>ClrType</c> when closed and by nothing at all when open. Teaching the
/// gate to answer from the symbol moved the failure one phase down, to
/// <c>Lowerer.LowerAwaitForRange</c>, whose first line reads the stream's
/// <c>ClrType</c> and returns an unreported error node when it is null —
/// GS9998. Both layers are fixed: the lowerer now surfaces the type-ERASED
/// <c>IAsyncEnumerable&lt;object&gt;</c> to drive reflection while carrying the
/// element symbolically, which is the same #1002 shape its existing arms
/// already handle and the async twin of what
/// <c>TryBuildSymbolicOpenGetEnumeratorCall</c> does for the synchronous
/// loop.</para>
/// <para><b>The `ClrType == null` trap, caught in review.</b> The first draft
/// of the lowering fix gated on <c>streamClr == null</c>. That is precisely the
/// mistake #4023's own correction warns about one file over: an
/// <c>async sequence[T]</c> over an IMPORTED element
/// (<c>async sequence[DateTime]</c>, <c>async sequence[List[int32]]</c>,
/// <c>async sequence[StringBuilder]</c>) has a NON-null <c>ClrType</c> —
/// closing the host <c>IAsyncEnumerable&lt;&gt;</c> over a
/// <c>MetadataLoadContext</c> argument answers a
/// <c>TypeBuilderInstantiation</c> — so the gate skipped it and
/// <c>GetMethod("GetAsyncEnumerator")</c> threw. Worse, the binder arm had by
/// then turned what used to be a GS0134 diagnostic into a GS9998 internal
/// error, so those shapes REGRESSED. Every <c>AsyncSequenceTypeSymbol</c> now
/// takes the symbolic path, exactly as every <c>SequenceTypeSymbol</c> already
/// does in <c>TryBuildSymbolicOpenGetEnumeratorCall</c> — whose own comment
/// gives this same reason, and which is why the synchronous
/// <c>for v in sequence[DateTime]</c> never had either half of this bug.</para>
/// <para><b>The misleading diagnostic, fixed alongside.</b> The issue notes
/// that both <c>SequenceTypeSymbol</c> and <c>AsyncSequenceTypeSymbol</c>
/// displayed as <c>sequence[T]</c>, so GS0134's own text could not say which
/// symbol the binder held — and it sent the issue's first reader to the wrong
/// one. <c>SymbolDisplay</c> now prints the async form as
/// <c>async sequence[T]</c>, the spelling the author writes for it (ADR-0041).
/// <see cref="TheTwoSequenceSymbols_NoLongerDisplayIdentically"/> pins both
/// halves: the async form names itself, and the sync form — which
/// <c>await for</c> must still refuse — still reads <c>sequence[T]</c>.</para>
/// <para><b>Not a channel change.</b> <c>async sequence</c> is
/// channel-ADJACENT, but nothing here touches a <c>chan[T]</c>, a select arm,
/// or a direction, and ADR-0174's D-series contract is unchanged — so no
/// erratum.</para>
/// <para><b>Discrimination witness (ADR-0154).</b> Reverting
/// <c>src/Core/CodeAnalysis/Binding/MemberLookup.cs</c>,
/// <c>src/Core/CodeAnalysis/Lowering/Lowerer.cs</c> and
/// <c>src/Core/CodeAnalysis/Symbols/Display/SymbolDisplay.cs</c> to
/// <c>565b9a04</c> turns every <see cref="AcceptedCases"/> row red with GS0134
/// and fails the display test, and leaves every <see cref="ControlCases"/> and
/// <see cref="RejectedCases"/> row exactly as it is.</para>
/// </remarks>
public class Issue4020AwaitForOverAnOpenAsyncSequenceTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// Every row reports <c>GS0134</c> on <c>565b9a04</c>. Each moves the
    /// loop's values into the printed answer, so a loop that binds but
    /// iterates the wrong thing prints the wrong answer.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> AcceptedCases()
    {
        // The issue's own repro, with the closed spelling beside the open one
        // so a disagreement between them is visible in the output.
        yield return new object[]
        {
            "an-open-async-sequence-parameter-iterates-like-the-closed-one",
            """
            package P
            import System

            async func numbers() async sequence[int32] {
                yield 1
                yield 2
                yield 3
            }

            async func closed(s async sequence[int32]) int32 {
                var n = 0
                await for v in s {
                    n = n + v
                }

                return n
            }

            async func openElement[T](s async sequence[T]) string {
                var acc = ""
                await for v in s {
                    acc = acc + v.ToString()
                }

                return acc
            }

            async func run() {
                Console.WriteLine((await closed(numbers())).ToString())
                Console.WriteLine(await openElement[int32](numbers()))
            }

            run().Wait()
            """,
            new[] { "6", "123" },
        };

        // A same-compilation class element: the OTHER way an async sequence
        // loses its ClrType, and the one that proves the loop variable keeps
        // the member-bearing symbol rather than the erased `object`.
        yield return new object[]
        {
            "an-async-sequence-over-a-same-compilation-class-reads-its-members",
            """
            package P
            import System

            class Item {
                var Tag string
            }

            async func items() async sequence[Item] {
                var a = Item{}
                a.Tag = "one"
                yield a
                var b = Item{}
                b.Tag = "two"
                yield b
            }

            async func tags(s async sequence[Item]) string {
                var acc = ""
                await for v in s {
                    acc = acc + v.Tag + ";"
                }

                return acc
            }

            async func run() {
                Console.WriteLine(await tags(items()))
            }

            run().Wait()
            """,
            new[] { "one;two;" },
        };

        // `break` and `continue` inside the loop (issue #937's labels) must
        // resolve against the newly-reachable lowering too.
        yield return new object[]
        {
            "break-and-continue-inside-an-open-async-sequence-loop",
            """
            package P
            import System

            async func numbers() async sequence[int32] {
                yield 1
                yield 2
                yield 3
                yield 4
            }

            async func pick[T](s async sequence[T]) string {
                var acc = ""
                await for v in s {
                    if v.ToString() == "2" {
                        continue
                    }

                    if v.ToString() == "4" {
                        break
                    }

                    acc = acc + v.ToString()
                }

                return acc
            }

            async func run() {
                Console.WriteLine(await pick[int32](numbers()))
            }

            run().Wait()
            """,
            new[] { "13" },
        };

        // Review feedback on #4034 (Copilot), measured and confirmed. The
        // first draft of the lowering fix gated on `streamClr == null`, which
        // is the very trap #4023's own correction describes: an
        // `async sequence[T]` over an IMPORTED element has a NON-null
        // `ClrType` that is a `TypeBuilderInstantiation`, so the gate skipped
        // it, `GetMethod("GetAsyncEnumerator")` threw
        // `NotSupportedException`, and the loop still reported GS9998 — a
        // REGRESSION, since the binder arm had by then turned what used to be
        // a GS0134 diagnostic into an internal compiler error. Every
        // `AsyncSequenceTypeSymbol` now takes the symbolic path, as every
        // `SequenceTypeSymbol` already did. These three rows are what proves
        // it: an imported STRUCT element (whose `Current` must not arrive
        // boxed), an imported CLASS element, and a constructed imported
        // GENERIC element — each reading a member off the loop variable so an
        // `object`-typed element would not compile.
        yield return new object[]
        {
            "an-async-sequence-over-an-imported-struct-element",
            """
            package P
            import System

            async func stamps() async sequence[DateTime] {
                yield DateTime.UnixEpoch
                yield DateTime.UnixEpoch
            }

            async func years(s async sequence[DateTime]) int32 {
                var n = 0
                await for v in s {
                    n = n + v.Year
                }

                return n
            }

            async func run() {
                Console.WriteLine((await years(stamps())).ToString())
            }

            run().Wait()
            """,
            new[] { "3940" },
        };

        yield return new object[]
        {
            "an-async-sequence-over-a-constructed-imported-generic-element",
            """
            package P
            import System
            import System.Collections.Generic

            async func bags() async sequence[List[int32]] {
                yield List[int32]()
                yield List[int32]()
            }

            async func total(s async sequence[List[int32]]) int32 {
                var n = 0
                await for v in s {
                    n = n + v.Count + 1
                }

                return n
            }

            async func run() {
                Console.WriteLine((await total(bags())).ToString())
            }

            run().Wait()
            """,
            new[] { "2" },
        };

        yield return new object[]
        {
            "an-async-sequence-over-an-imported-class-element",
            """
            package P
            import System
            import System.Text

            async func builders() async sequence[StringBuilder] {
                var b = StringBuilder()
                b.Append("abc")
                yield b
            }

            async func lengths(s async sequence[StringBuilder]) int32 {
                var n = 0
                await for v in s {
                    n = n + v.Length
                }

                return n
            }

            async func run() {
                Console.WriteLine((await lengths(builders())).ToString())
            }

            run().Wait()
            """,
            new[] { "3" },
        };
    }

    /// <summary>
    /// Rows already GREEN on <c>565b9a04</c> that must stay green: the closed
    /// spelling, the <c>IAsyncEnumerable[T]</c> workaround the issue names, and
    /// the synchronous sibling the issue measured as unaffected.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> ControlCases()
    {
        yield return new object[]
        {
            "control-the-open-iasyncenumerable-workaround-and-the-sync-sibling",
            """
            package P
            import System
            import System.Collections.Generic

            func syncNumbers() sequence[int32] {
                yield 7
                yield 8
            }

            async func numbers() async sequence[int32] {
                yield 1
                yield 2
                yield 3
            }

            async func countAsync[T](s IAsyncEnumerable[T]) int32 {
                var n = 0
                await for v in s {
                    n = n + 1
                }

                return n
            }

            func sumSync[T](s sequence[T]) string {
                var acc = ""
                for v in s {
                    acc = acc + v.ToString()
                }

                return acc
            }

            async func run() {
                Console.WriteLine((await countAsync[int32](numbers())).ToString())
                Console.WriteLine(sumSync[int32](syncNumbers()))
            }

            run().Wait()
            """,
            new[] { "3", "78" },
        };

        // The issue's "otherwise well-formed" rows: an open async sequence
        // still passes as an argument to both spellings of the parameter.
        yield return new object[]
        {
            "control-an-async-sequence-still-crosses-both-parameter-spellings",
            """
            package P
            import System
            import System.Collections.Generic

            async func numbers() async sequence[int32] {
                yield 1
            }

            func takesOpenAsync[T](s async sequence[T]) int32 { return 1 }

            func takesOpenIAsync[T](s IAsyncEnumerable[T]) int32 { return 3 }

            func main2() {
                Console.WriteLine(takesOpenAsync[int32](numbers()).ToString())
                Console.WriteLine(takesOpenIAsync[int32](numbers()).ToString())
            }

            main2()
            """,
            new[] { "1", "3" },
        };
    }

    /// <summary>
    /// What <c>await for</c> must still refuse, so recognising the async
    /// sequence symbol did not make the operand check accept anything that is
    /// not an async enumerable — a synchronous <c>sequence[T]</c> above all.
    /// </summary>
    /// <returns>Name, G# source, the diagnostic id and a substring of its text.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        yield return new object[]
        {
            "await-for-over-a-non-enumerable-is-still-refused",
            """
            package P
            import System

            async func run() {
                await for v in 5 {
                    Console.WriteLine(v.ToString())
                }
            }

            run().Wait()
            """,
            "GS0134",
            "'int32'",
        };

        yield return new object[]
        {
            "await-for-over-a-synchronous-open-sequence-is-still-refused",
            """
            package P
            import System

            func numbers() sequence[int32] {
                yield 1
            }

            async func bad[T](s sequence[T]) int32 {
                var n = 0
                await for v in s {
                    n = n + 1
                }

                return n
            }

            async func run() {
                Console.WriteLine((await bad[int32](numbers())).ToString())
            }

            run().Wait()
            """,
            "GS0134",
            "'sequence[T]'",
        };
    }

    /// <summary>
    /// An open <c>async sequence[T]</c> iterates, and the program compiles,
    /// IL-verifies, runs, and prints what it claims.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(AcceptedCases))]
    public void AnOpenAsyncSequence_IteratesWithAwaitFor(string name, string source, string[] expectedLines)
    {
        RunCase("gs_4020_", name, source, expectedLines);
    }

    /// <summary>
    /// The rows that already worked keep working.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(ControlCases))]
    public void AShapeThatAlreadyIterated_StillIterates(string name, string source, string[] expectedLines)
    {
        RunCase("gs_4020_control_", name, source, expectedLines);
    }

    /// <summary>
    /// <c>await for</c> still refuses what is not an async enumerable.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the compile must report.</param>
    /// <param name="expectedMention">A substring of the diagnostic's text.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void AnOperandThatIsNotAnAsyncEnumerable_IsStillRefused(
        string name,
        string source,
        string expectedId,
        string expectedMention)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4020_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal);
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The second half of the issue: the two sequence symbols used to print
    /// the same text, so a diagnostic could not say which one the binder had.
    /// The async form now names itself; the synchronous form is unchanged.
    /// </summary>
    [Fact]
    public void TheTwoSequenceSymbols_NoLongerDisplayIdentically()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4020_display_").FullName;
        try
        {
            const string AsyncSource = """
                package P
                import System

                async func numbers() async sequence[int32] {
                    yield 1
                }

                func takesInt(x int32) int32 { return x }

                func main2() {
                    Console.WriteLine(takesInt(numbers()).ToString())
                }

                main2()
                """;

            const string SyncSource = """
                package P
                import System

                func numbers() sequence[int32] {
                    yield 1
                }

                func takesInt(x int32) int32 { return x }

                func main2() {
                    Console.WriteLine(takesInt(numbers()).ToString())
                }

                main2()
                """;

            var asyncLog = Compile(
                tempDir,
                "Async.gs",
                AsyncSource,
                Path.Combine(tempDir, "async.dll"),
                "/target:exe");
            Assert.Contains("'async sequence[int32]'", asyncLog, StringComparison.Ordinal);

            var syncLog = Compile(
                tempDir,
                "Sync.gs",
                SyncSource,
                Path.Combine(tempDir, "sync.dll"),
                "/target:exe");
            Assert.Contains("'sequence[int32]'", syncLog, StringComparison.Ordinal);
            Assert.DoesNotContain("'async sequence[int32]'", syncLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static void RunCase(string prefix, string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory(prefix).FullName;
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

    private static string[] SplitLines(string output) => output
        .Split('\n')
        .Select(line => line.TrimEnd('\r'))
        .Where(line => line.Length > 0)
        .ToArray();

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
