// <copyright file="Issue1819AsyncStructResultEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1819 — awaiting a <c>Task&lt;UserValueType&gt;</c> (a same-compilation
/// user struct or enum, non-nullable OR nullable) whose CLR type is still
/// <see langword="null"/> at bind time forced the closed-over-object CLR
/// signature of the generic BCL method that produced the task (for example
/// <c>Task.FromResult&lt;T&gt;(T)</c>) to be used for ARGUMENT conversion,
/// classifying the concrete struct/enum argument as an implicit
/// value-to-object boxing conversion and inserting a spurious <c>box</c>.
/// Meanwhile the call is actually re-instantiated at emit over the REAL
/// symbolic type argument (e.g. <c>Task&lt;Pt&gt;::FromResult&lt;Pt&gt;</c>), whose
/// MethodSpec expects the raw (unboxed) value on the stack — producing an
/// ilverify <c>StackUnexpected</c> ("found ref 'X' expected value 'X'") at the
/// call site. Every downstream consumer of the produced <c>Task&lt;X&gt;</c> (an
/// awaited local, a field, a member-access receiver, a <c>??</c> operand)
/// inherits the same corrupted value, since the bug already occurs before the
/// <c>Task&lt;X&gt;</c> is even constructed.
/// <para>
/// The fix teaches <c>ConversionClassifier.BindClrParameterConversions</c> to
/// recover the real symbolic parameter type (via
/// <c>TrySubstituteParameterTypeFromMethodTypeArgs</c>) whenever the argument's
/// OWN bound type is already a concrete same-compilation user type
/// (<c>TypeSymbol.IsSameCompilationUserTypeTopLevel</c> — struct, enum,
/// interface, delegate; unwraps <c>Nullable&lt;T&gt;</c>), not just when the
/// argument is a bare <see cref="GSharp.Core.CodeAnalysis.Symbols.TypeParameterSymbol"/>
/// or a function literal (the pre-existing #1512/#1540 recoveries). This
/// keeps the argument an identity conversion (<c>Pt -&gt; Pt</c>, no <c>box</c>),
/// matching what the emitter's <c>GetMethodEntityHandle</c> actually
/// instantiates.
/// </para>
/// Every facet failed ilverify on current main and passes after the fix. Each
/// uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </summary>
public class Issue1819AsyncStructResultEmitTests
{
    [Fact]
    public void EndToEnd_AwaitTaskUserStruct_LocalThenFieldAccess_Runs()
    {
        // The exact issue #1819 repro shape: `let v = await t; return v.X`.
        const string source = """
            package i1819structlocal
            import System
            import System.Threading.Tasks

            struct Pt1819A(X int32) { }

            async func getVal() int32 {
                let t = Task.FromResult(Pt1819A(42))
                let v = await t
                return v.X
            }

            func Main() { System.Console.WriteLine(getVal().Result) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_AwaitTaskUserStruct_FieldAssignment_Runs()
    {
        // Generalization: the awaited struct result is stored directly into a
        // FIELD (hoisted across the await) rather than a plain local, then
        // read back via field access — exercises the `TryGetHoistedField`
        // result-target path alongside the argument-conversion fix.
        const string source = """
            package i1819structfield
            import System
            import System.Threading.Tasks

            struct Pt1819B(X int32, Y int32) { }

            async func getSum() int32 {
                var acc = 0
                let v = await Task.FromResult(Pt1819B(10, 32))
                acc = v.X + v.Y
                let v2 = await Task.FromResult(Pt1819B(1, 1))
                acc = acc + v2.X
                return acc
            }

            func Main() { System.Console.WriteLine(getSum().Result) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("43\n", output);
    }

    [Fact]
    public void EndToEnd_AwaitTaskUserEnum_UsedDirectlyInBinaryExpression_Runs()
    {
        // Generalization: a same-compilation user ENUM (not a struct), and the
        // awaited result is consumed directly in a binary expression without
        // ever being assigned to an intermediate local.
        const string source = """
            package i1819enumbinary
            import System
            import System.Threading.Tasks

            enum Shade1819 { Dim, Mid, Bright }

            async func isBright() bool {
                let t = Task.FromResult(Shade1819.Bright)
                return await t == Shade1819.Bright
            }

            func Main() { System.Console.WriteLine(isBright().Result) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void EndToEnd_AwaitTaskNullableUserStruct_NullCoalesce_Runs()
    {
        // Generalization: a NULLABLE same-compilation user struct
        // (`Task<Pt?>`), with the awaited result immediately consumed as the
        // left operand of `??`.
        const string source = """
            package i1819nullablecoalesce
            import System
            import System.Threading.Tasks

            struct Pt1819C(X int32) { }

            async func getValOrDefault() int32 {
                let t = Task.FromResult[Pt1819C?](Pt1819C(7))
                let v = (await t) ?? Pt1819C(0)
                return v.X
            }

            func Main() { System.Console.WriteLine(getValOrDefault().Result) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_AwaitTaskUserStruct_MemberAccessReceiver_Runs()
    {
        // Generalization: the awaited struct result is used directly as the
        // RECEIVER of a member access (no intermediate local at all).
        const string source = """
            package i1819memberaccess
            import System
            import System.Threading.Tasks

            struct Pt1819D(X int32) { }

            async func getX() int32 {
                return (await Task.FromResult(Pt1819D(99))).X
            }

            func Main() { System.Console.WriteLine(getX().Result) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1819_exe_").FullName;
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
