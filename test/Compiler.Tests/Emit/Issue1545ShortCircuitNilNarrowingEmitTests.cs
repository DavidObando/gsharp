// <copyright file="Issue1545ShortCircuitNilNarrowingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1545 — gsc threaded type-test narrowing (<c>x is T</c>, issues
/// #700/#712) into the right operand of <c>&amp;&amp;</c>/<c>||</c>, but did NOT
/// thread <em>nil-guard</em> narrowing (<c>x == nil</c> / <c>x != nil</c>). So
/// the canonical short-circuit null-guard idiom
/// (<c>x == nil || x.Member</c> / <c>x != nil &amp;&amp; x.Member</c>) failed
/// with GS0158 even though the receiver is provably non-nil where used.
/// <para>
/// The fix adds the nil-guard leaf to
/// <c>ExpressionBinder.ClassifyTypeTestNarrowing</c> via a shared static leaf
/// (<c>SmartCastStability.TryClassifyNilGuardLeaf</c>) reused by the
/// if-condition classifier (<c>StatementBinder.TryClassifyNilGuard</c>).
/// </para>
/// Every facet failed to compile on current main and passes after the fix. Each
/// uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed for user types.
/// <para>
/// The short-circuit path intentionally restricts nil-guard narrowing to
/// nullable REFERENCE types: narrowing a nullable value type (<c>int32?</c>)
/// is not an IL no-op and the variable-load path does not emit the required
/// unwrap, so applying it produced invalid IL (regressed Issue1518's
/// <c>v != nil &amp;&amp; v!! &gt; 0</c>). Value-type nullables still work in the
/// guard via the nullable-lifted operator or an explicit <c>!!</c> — see
/// <see cref="Control_ValueTypeNullable_ShortCircuitGuard_NotNarrowedButRuns"/>.
/// </para>
/// </summary>
public class Issue1545ShortCircuitNilNarrowingEmitTests
{
    [Fact]
    public void EndToEnd_OrGuard_NullableArray_Runs()
    {
        const string source = """
            package i1545orarray
            import System

            func OrGuard(x []?uint8) bool -> x == nil || x.Length < 8

            func Main() {
                var big = []uint8{1,2,3,4,5,6,7,8,9,10}
                var small = []uint8{1,2,3}
                System.Console.WriteLine(OrGuard(nil))
                System.Console.WriteLine(OrGuard(big))
                System.Console.WriteLine(OrGuard(small))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\nTrue\n", output);
    }

    [Fact]
    public void EndToEnd_AndGuard_NullableArray_Runs()
    {
        const string source = """
            package i1545andarray
            import System

            func AndGuard(x []?uint8) bool -> x != nil && x.Length >= 8

            func Main() {
                var big = []uint8{1,2,3,4,5,6,7,8,9,10}
                var small = []uint8{1,2,3}
                System.Console.WriteLine(AndGuard(nil))
                System.Console.WriteLine(AndGuard(big))
                System.Console.WriteLine(AndGuard(small))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nTrue\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_OrGuard_NullableStringReference_Runs()
    {
        const string source = """
            package i1545orstring
            import System

            func IsBlank(s string?) bool -> s == nil || s.Length == 0

            func Main() {
                System.Console.WriteLine(IsBlank(nil))
                System.Console.WriteLine(IsBlank(""))
                System.Console.WriteLine(IsBlank("abc"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nTrue\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_AndGuard_NullableUserClassMemberCall_Runs()
    {
        const string source = """
            package i1545anduserclass
            import System

            class Widget {
                prop On bool { get; init; }
                func IsOn() bool -> On
            }

            func Enabled(o Widget?) bool -> o != nil && o.IsOn()

            func Main() {
                System.Console.WriteLine(Enabled(nil))
                System.Console.WriteLine(Enabled(Widget() { On = true }))
                System.Console.WriteLine(Enabled(Widget() { On = false }))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nTrue\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_OrGuard_GenericNullableSequence_Runs()
    {
        const string source = """
            package i1545orsequence
            import System
            import System.Collections.Generic
            import System.Linq

            func CountIt(e IEnumerable[int32]) int32 -> e.Count()

            func IsEmpty(e IEnumerable[int32]?) bool -> e == nil || CountIt(e) == 0

            func Main() {
                System.Console.WriteLine(IsEmpty(nil))
                var l = List[int32]()
                System.Console.WriteLine(IsEmpty(l))
                l.Add(7)
                System.Console.WriteLine(IsEmpty(l))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nTrue\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_OrGuard_StableMemberPath_Runs()
    {
        const string source = """
            package i1545stablepath
            import System

            class Holder {
                prop Field string? { get; init; }
                func Blank() bool -> this.Field == nil || this.Field.Length == 0
            }

            func Main() {
                System.Console.WriteLine(Holder() { Field = nil }.Blank())
                System.Console.WriteLine(Holder() { Field = "" }.Blank())
                System.Console.WriteLine(Holder() { Field = "abc" }.Blank())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nTrue\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_AndGuard_StableMemberPath_Runs()
    {
        const string source = """
            package i1545stablepathand
            import System

            class Holder {
                prop Field string? { get; init; }
                func HasText() bool -> this.Field != nil && this.Field.Length > 0
            }

            func Main() {
                System.Console.WriteLine(Holder() { Field = nil }.HasText())
                System.Console.WriteLine(Holder() { Field = "" }.HasText())
                System.Console.WriteLine(Holder() { Field = "abc" }.HasText())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nFalse\nTrue\n", output);
    }

    [Fact]
    public void EndToEnd_NilOnLeftOperand_Runs()
    {
        // Either operand order must be recognised: `nil == x` / `nil != x`.
        const string source = """
            package i1545operandorder
            import System

            func OrGuard(s string?) bool -> nil == s || s.Length == 0
            func AndGuard(s string?) bool -> nil != s && s.Length > 0

            func Main() {
                System.Console.WriteLine(OrGuard(nil))
                System.Console.WriteLine(OrGuard("abc"))
                System.Console.WriteLine(AndGuard(nil))
                System.Console.WriteLine(AndGuard("abc"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\nFalse\nTrue\n", output);
    }

    [Fact]
    public void Negative_UnguardedMemberRead_ReportsGs0158()
    {
        // OUTSIDE the guarded operand, `.Length` on a nullable is still GS0158.
        const string source = """
            package i1545neg158

            func Bad(x []?uint8) int32 -> x.Length
            """;

        var (exit, output) = CompileOnly(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0158", output);
    }

    [Fact]
    public void Negative_NonNullableComparedToNil_ReportsGs0129()
    {
        // A non-nullable operand compared to nil must still report GS0129; the
        // nil-guard leaf only fires for NullableTypeSymbol targets.
        const string source = """
            package i1545neg129

            func Bad(x int32) bool -> x == nil || x > 8
            """;

        var (exit, output) = CompileOnly(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0129", output);
    }

    [Fact]
    public void Control_ValueTypeNullable_ShortCircuitGuard_NotNarrowedButRuns()
    {
        // A nullable VALUE type in a short-circuit guard is intentionally NOT
        // narrowed (that would need an unwrap the load path doesn't emit, giving
        // invalid IL). The idiom still runs: `v!!` unwraps explicitly and the
        // lifted `>` handles the un-narrowed operand. Both must produce valid,
        // ilverify-clean IL and the correct runtime result.
        const string source = """
            package i1545vt

            import System
            import System.Linq

            func CountForced(xs []int32?) int32 -> xs.Where((v int32?) -> v != nil && v!! > 0).Count()
            func CountLifted(xs []int32?) int32 -> xs.Where((v int32?) -> v != nil && v > 0).Count()

            func Main() {
                var xs = []int32?{1, nil, 2, nil, 3}
                Console.WriteLine(CountForced(xs))
                Console.WriteLine(CountLifted(xs))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n3\n", output);
    }

    private static (int Exit, string Output) CompileOnly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1545_neg_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            return (compileExit, stdoutWriter + stderrWriter.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1545_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
