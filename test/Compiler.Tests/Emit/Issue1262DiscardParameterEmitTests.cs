// <copyright file="Issue1262DiscardParameterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1262: a parameter list with more than one discard parameter named
/// <c>_</c> was rejected with GS0101 ("A parameter with the name '_' already
/// exists."). In C# <c>_</c> is a discard and repeated <c>_</c> parameters are
/// allowed (e.g. event handlers <c>(_, _) =&gt; ...</c>). G# now permits
/// repeated <c>_</c> discard parameters on lambdas and named functions.
/// <para>
/// These emit tests prove that each <c>_</c> still occupies a real positional
/// slot: a two-<c>_</c>-param lambda invoked through its delegate produces the
/// right result and the emitted IL verifies.
/// </para>
/// </summary>
public class Issue1262DiscardParameterEmitTests
{
    [Fact]
    public void TwoDiscardParameters_FuncLambda_HasArityTwo_AndRuns()
    {
        // A `(_, _) -> 42` lambda assigned to a two-arg Func delegate must
        // carry both positional slots so the indirect call binds two
        // arguments; the body discards them and returns the constant.
        var source = """
            package P
            import System

            let f func(int32, int32) int32 = (_ int32, _ int32) -> 42
            Console.Write(f(7, 9))
            """;

        var stdout = CompileRunCapture(source);
        Assert.Equal("42", stdout);
    }

    [Fact]
    public void MixedDiscardAndNamed_Lambda_KeepsPositionalSlots()
    {
        // `(_ int32, x int32) -> x` proves the discard occupies the first slot
        // and the named parameter still resolves to the second argument.
        var source = """
            package P
            import System

            let f func(int32, int32) int32 = (_ int32, x int32) -> x
            Console.Write(f(5, 9))
            """;

        var stdout = CompileRunCapture(source);
        Assert.Equal("9", stdout);
    }

    [Fact]
    public void TwoDiscardParameters_EventHandlerShapedLambda_Runs()
    {
        // Event-handler-shaped callback `(_ object, _ EventArgs) -> ...`: the
        // canonical motivating case. The delegate is invoked with two
        // arguments which the body ignores.
        var source = """
            package P
            import System

            var fired = 0
            let h EventHandler = (_ object, _ EventArgs) -> fired = fired + 1
            h(nil, EventArgs.Empty)
            h(nil, EventArgs.Empty)
            Console.Write(fired)
            """;

        var stdout = CompileRunCapture(source);
        Assert.Equal("2", stdout);
    }

    [Fact]
    public void TwoDiscardParameters_NamedFunction_HasArityTwo_AndRuns()
    {
        // A named function `func add(_ int32, _ int32) int32` still has two
        // positional slots; calling it with two arguments returns the body's
        // constant, proving the signature arity is correct.
        var source = """
            package P
            import System

            func discardBoth(_ int32, _ int32) int32 {
              return 11
            }

            Console.Write(discardBoth(3, 4))
            """;

        var stdout = CompileRunCapture(source);
        Assert.Equal("11", stdout);
    }

    private static string CompileRunCapture(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1262_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var bytes = File.ReadAllBytes(outPath);
            var assembly = Assembly.Load(bytes);

            var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
            var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);

            var captured = new StringWriter();
            var prevOut2 = Console.Out;
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(prevOut2);
            }

            return captured.ToString().Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // Best-effort cleanup of the temp compilation directory.
            }
        }
    }
}
