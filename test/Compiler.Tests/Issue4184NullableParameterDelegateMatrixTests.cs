// <copyright file="Issue4184NullableParameterDelegateMatrixTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4184 — the parameter-side sibling of the return-type nullable
/// erasure fixed for issue #4165 (see
/// <c>Emit.Issue1518NullableDelegateInferenceEmitTests</c>).
/// <para>
/// <see cref="GSharp.Core.CodeAnalysis.Binding.Conversion.IsFunctionToDelegateConvertible"/>'s
/// parameter-compatibility fast path compared a method group's declared
/// parameter type against the delegate's declared parameter type using the
/// RAW <c>ClrType</c>. <c>NullableTypeSymbol.ClrType</c> erases a nullable
/// value type (<c>int32?</c>) to its bare underlying type (<c>int32</c>), so
/// a method declaring <c>int32?</c> was indistinguishable from one declaring
/// plain <c>int32</c> and silently satisfied a delegate slot declared
/// <c>int32</c> — a conversion <c>csc</c> rejects with <c>CS0123</c>.
/// </para>
/// <para>
/// <b>The fix</b> routes the comparison through
/// <c>NullableLifting.GetEffectiveClrType</c> (the same helper #4165 used for
/// the analogous RETURN-type erasure), which re-wraps a value-type underlying
/// in <c>Nullable[T]</c>. That alone was not sufficient: measured directly,
/// <c>Type.IsAssignableFrom</c> has its own CLR-level special case where
/// <c>Nullable&lt;T&gt;.IsAssignableFrom(T)</c> is <see langword="true"/>
/// (supporting the implicit <c>T -&gt; T?</c> lift used in ordinary
/// expression contexts), which would have silently reintroduced this issue's
/// exact bug in the REVERSE direction (a method declaring bare <c>T</c>
/// wrongly satisfying a delegate slot declared <c>T?</c> — also
/// <c>CS0123</c> under <c>csc</c>) the moment the erasure stopped masking it.
/// A second, narrow guard (<c>IsClrNullableWideningMismatch</c>) closes that
/// too.
/// </para>
/// <para>
/// <b>The full T/T? parameter matrix</b>, each fact measured against <c>csc</c>
/// before being pinned here:
/// </para>
/// <list type="bullet">
/// <item><c>T -&gt; T</c> (<see cref="ParameterMatrix_NonNullableToNonNullable_CompilesAndRuns"/>): accepted.</item>
/// <item><c>T? -&gt; T</c> (<see cref="ParameterMatrix_NullableToNonNullable_IsRejected"/>): this issue's own repro, rejected with <c>GS0155</c>.</item>
/// <item><c>T -&gt; T?</c> (<see cref="ParameterMatrix_NonNullableToNullable_IsRejected"/>): the reverse gap found while building this matrix, rejected with <c>GS0155</c>.</item>
/// <item><c>T? -&gt; T?</c> (<see cref="ParameterMatrix_NullableToNullable_CompilesAndRuns"/>): accepted.</item>
/// </list>
/// <para>
/// <b>Out of scope, filed separately.</b> The identical CLR
/// <c>Nullable&lt;T&gt;.IsAssignableFrom(T)</c> quirk also affects the RETURN
/// side's <c>T -&gt; T?</c> direction for a bare METHOD GROUP (measured:
/// <c>func RTN(x int32) bool -&gt; x != 0; var f Func[int32, bool?] = RTN</c>
/// still compiles on <c>gsc</c> where <c>csc</c> reports <c>CS0407</c>). It is
/// NOT fixed here: unlike the parameter side, <c>IsFunctionToDelegateConvertible</c>
/// is shared with LAMBDA return-type matching, where <c>csc</c> DOES accept a
/// <c>bool</c>-returning lambda body target-typed against <c>Func&lt;int,
/// bool?&gt;</c> (measured directly with <c>csc</c>) — applying the same
/// return-side guard without a method-group/lambda discriminator at this call
/// site risks regressing that legitimate lambda shape, so it is left for a
/// dedicated follow-up issue rather than half-fixed here.
/// </para>
/// </summary>
public class Issue4184NullableParameterDelegateMatrixTests
{
    [Fact]
    public void OriginalRepro_NullableValueTypeParameterMismatchesDelegate_IsRejected()
    {
        // The issue's own repro: `HasValue(x int32?)` cannot satisfy
        // `Func[int32, bool]` — csc measured: CS0123.
        const string source = """
            package Issue4184Repro
            import System

            func HasValue(x int32?) bool -> x != nil

            func Main() {
                var f Func[int32, bool] = HasValue
                Console.WriteLine(f(5))
            }
            """;

        var diagnostics = CompileExpectingFailure(source, "issue4184repro");
        Assert.Contains("GS0155", diagnostics);
    }

    [Fact]
    public void ParameterMatrix_NonNullableToNonNullable_CompilesAndRuns()
    {
        // T -> T: method declares bare int32, delegate declares bare int32.
        // csc measured: accepted.
        const string source = """
            package Issue4184MatrixTT
            import System

            func TT(x int32) bool -> x != 0

            func Main() {
                var f Func[int32, bool] = TT
                Console.WriteLine(f(5))
            }
            """;

        Assert.Equal($"True{Environment.NewLine}", CompileAndRun(source, "issue4184matrixtt"));
    }

    [Fact]
    public void ParameterMatrix_NullableToNonNullable_IsRejected()
    {
        // T? -> T: method declares int32?, delegate declares bare int32.
        // csc measured: CS0123. Same shape as the issue's own repro, with a
        // distinct package name to keep the FunctionTypeSymbol cache from
        // colliding with the other facts in this matrix.
        const string source = """
            package Issue4184MatrixNT
            import System

            func NT(x int32?) bool -> x != nil

            func Main() {
                var f Func[int32, bool] = NT
                Console.WriteLine(f(5))
            }
            """;

        var diagnostics = CompileExpectingFailure(source, "issue4184matrixnt");
        Assert.Contains("GS0155", diagnostics);
    }

    [Fact]
    public void ParameterMatrix_NonNullableToNullable_IsRejected()
    {
        // T -> T?: method declares bare int32, delegate declares int32?.
        // csc measured: CS0123 (the reverse-direction gap this fix closes
        // beyond the issue's literal repro).
        const string source = """
            package Issue4184MatrixTN
            import System

            func TN(x int32) bool -> x != 0

            func Main() {
                var f Func[int32?, bool] = TN
                Console.WriteLine(f(5))
            }
            """;

        var diagnostics = CompileExpectingFailure(source, "issue4184matrixtn");
        Assert.Contains("GS0155", diagnostics);
    }

    [Fact]
    public void ParameterMatrix_NullableToNullable_CompilesAndRuns()
    {
        // T? -> T?: method declares int32?, delegate declares int32?.
        // csc measured: accepted (identity match).
        const string source = """
            package Issue4184MatrixNN
            import System

            func NN(x int32?) bool -> x != nil

            func Main() {
                var f Func[int32?, bool] = NN
                Console.WriteLine(f(5))
            }
            """;

        Assert.Equal($"True{Environment.NewLine}", CompileAndRun(source, "issue4184matrixnn"));
    }

    [Fact]
    public void ReturnSideRegressionGuard_NullableReturnStillSatisfiesNonNullableDelegate_IsRejected()
    {
        // Guards against a regression of #4165's own return-side fix while
        // this issue's parameter-side fix lives in the same function: a
        // method returning bool? must not satisfy Func[int32, bool].
        const string source = """
            package Issue4184ReturnGuardNT
            import System

            func NT(x int32) bool? -> x != 0

            func Main() {
                var f Func[int32, bool] = NT
                Console.WriteLine(f(5))
            }
            """;

        var diagnostics = CompileExpectingFailure(source, "issue4184returnguardnt");
        Assert.Contains("GS0155", diagnostics);
    }

    /// <summary>
    /// Compiles <paramref name="source"/> and asserts it succeeds and runs,
    /// returning the process's captured stdout.
    /// </summary>
    private static string CompileAndRun(string source, string testName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4184_" + testName + "_").FullName;
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

            return stdout;
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
                // Best-effort cleanup; a concurrent agent sharing /tmp may
                // still hold a handle.
            }
        }
    }

    /// <summary>
    /// Compiles <paramref name="source"/>, asserting it FAILS, and returns
    /// the captured diagnostic text (stdout + stderr).
    /// </summary>
    private static string CompileExpectingFailure(string source, string testName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4184_" + testName + "_").FullName;
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

            Assert.True(compileExit != 0, "expected gsc to fail, but it succeeded");

            return stdoutWriter + stderrWriter.ToString();
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
                // Best-effort cleanup; a concurrent agent sharing /tmp may
                // still hold a handle.
            }
        }
    }
}
