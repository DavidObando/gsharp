// <copyright file="Issue893FuncLiteralTrailingReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #893 — a value-returning function literal
/// <c>func(p T) R { ... &lt;trailing-expr&gt; }</c> whose block body ends in a bare
/// trailing expression must treat that expression as the implicit return value.
/// <para>
/// Before the fix the trailing expression bound to a discarded expression
/// statement, so the emitted method had a non-void signature but no <c>ret</c>
/// returning a value. The CLR rejected the body with
/// <c>System.InvalidProgramException</c> at runtime (and ilverify flagged the
/// invalid IL). This was most visible when such a literal was passed as a
/// <c>Func&lt;TSource,bool&gt;</c> predicate to a generic LINQ method like
/// <c>Single</c> / <c>Where</c>, exactly as in the issue's
/// <c>report.Checks.Single(func(c DoctorCheck) bool { c.Id == "audible-api" })</c>.
/// </para>
/// </summary>
public class Issue893FuncLiteralTrailingReturnEmitTests
{
    [Fact]
    public void FuncLiteralPredicate_TrailingBoolExpression_AsLinqSinglePredicate_Runs()
    {
        // Faithful shape of the issue: a `func(c T) bool { <comparison> }` literal
        // passed straight to LINQ Single<TSource>(IEnumerable<TSource>, Func<TSource,bool>).
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            let ids = List[string]()
            ids.Add("audible-api")
            ids.Add("network")
            let net = ids.Single(func(c string) bool { c == "network" })
            Console.WriteLine(net)
            """;

        Assert.Equal("network\n", CompileAndRun(source));
    }

    [Fact]
    public void FuncLiteralPredicate_TrailingBoolExpression_AsLinqWherePredicate_Runs()
    {
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            let nums = List[int32]()
            nums.Add(1)
            nums.Add(2)
            nums.Add(3)
            nums.Add(4)
            let evens = nums.Where(func(n int32) bool { n % 2 == 0 })
            Console.WriteLine(evens.Count())
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void FuncLiteral_TrailingExpression_WithPrefixStatements_ReturnsTrailingValue()
    {
        // A multi-statement block whose final statement is a bare expression: the
        // prefix statements run, then the trailing expression is the return value.
        var source = """
            package P
            import System

            let doubleThenAddOne = func(x int32) int32 {
                let doubled = x * 2
                doubled + 1
            }
            Console.WriteLine(doubleThenAddOne(20))
            """;

        Assert.Equal("41\n", CompileAndRun(source));
    }

    [Fact]
    public void FuncLiteral_TrailingExpression_RequiringConversion_ReturnsConvertedValue()
    {
        // The trailing expression's type (int32) differs from the declared return
        // type (int64); it must be converted on the synthesized return.
        var source = """
            package P
            import System

            let widen = func(x int32) int64 { x + 1 }
            Console.WriteLine(widen(41))
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void FuncLiteral_TrailingExpression_InsideAsyncMethod_ClosureContext_Runs()
    {
        // Mirrors the issue's setting: the predicate literal is created inside an
        // async function and captures an outer local (closure context), then is
        // passed to LINQ Single. Exercises the trailing-return rewrite for a
        // value-returning literal that lives in a state machine / display class.
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic
            import System.Threading.Tasks

            async func findAsync(items List[string], wanted string) string {
                await Task.Yield()
                return items.Single(func(c string) bool { c == wanted })
            }

            let data = List[string]()
            data.Add("audible-api")
            data.Add("network")
            data.Add("disk")
            let found = findAsync(data, "network").GetAwaiter().GetResult()
            Console.WriteLine(found)
            """;

        Assert.Equal("network\n", CompileAndRun(source));
    }

    [Fact]
    public void FuncLiteral_VoidBody_StatementOnly_StillRunsWithoutImplicitReturn()
    {
        // Regression guard for issue #889: a void function literal (Action-style)
        // must NOT gain an implicit value return from its trailing expression
        // statement; it stays a statement body.
        var source = """
            package P
            import System

            let act = func(s string) { Console.WriteLine(s) }
            act("ok")
            """;

        Assert.Equal("ok\n", CompileAndRun(source));
    }

    [Fact]
    public void FuncLiteral_ExplicitReturn_StillRuns()
    {
        // A value-returning literal that already ends in an explicit `return` must
        // be left untouched by the trailing-return rewrite.
        var source = """
            package P
            import System

            let pick = func(flag bool) int32 {
                if flag {
                    return 1
                }
                return 2
            }
            Console.WriteLine(pick(true))
            Console.WriteLine(pick(false))
            """;

        Assert.Equal("1\n2\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue893_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new System.Collections.Generic.List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");

            // (a) Static verification: the emitted IL must be valid.
            IlVerifier.Verify(outPath);

            // (b) Dynamic verification: the emitted code must execute without an
            // InvalidProgramException (the runtime symptom in issue #893).
            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
