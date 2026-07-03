// <copyright file="Issue1785AsyncNullableUserStructAwaiterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1785: awaiting a <c>Task[T?]</c> where <c>T</c> is a same-
/// compilation user value type (struct/enum) mistyped the hoisted awaiter
/// field. <c>TryGetAwaiterTypeSymbol</c> only recognized a bare
/// <c>StructSymbol</c>/<c>InterfaceSymbol</c>/<c>EnumSymbol</c> type argument,
/// so a <c>NullableTypeSymbol</c> wrapping a user struct/enum fell through to
/// <see langword="null"/>, and the awaiter field/local ended up typed
/// <c>TaskAwaiter&lt;object&gt;</c> instead of the correct
/// <c>TaskAwaiter&lt;Nullable&lt;T&gt;&gt;</c>. The same narrow predicate
/// recurred in three other places that also need to agree on the widened
/// <c>Task&lt;T?&gt;</c> shape: <c>LambdaBinder.WrapAsTask</c> (the async
/// function's own declared/observable return type), <c>ReflectionMetadataEmitter
/// .IsAsyncUserDefinedResultType</c> (the kickoff method's real emitted
/// <c>Task&lt;T&gt;</c> return type), and <c>AsyncStateMachineTypeBuilder</c>'s
/// <c>ResolveAsyncReturnClrType</c>/<c>Build</c> (the async method builder's
/// erasure placeholder and the state machine's <c>&lt;&gt;t__builder</c> field
/// type). All four now use symbol-based detection (a
/// <c>NullableTypeSymbol</c> whose <c>UnderlyingType</c> is a
/// <c>StructSymbol</c>/<c>InterfaceSymbol</c>/<c>EnumSymbol</c>) instead of
/// <c>ClrType.IsValueType</c>, which is <see langword="null"/> for an
/// in-flight (same-compilation) user type and therefore can't distinguish the
/// nullable-wrapped case from an ordinary BCL/erased type.
/// </summary>
public class Issue1785AsyncNullableUserStructAwaiterEmitTests
{
    [Fact]
    public void Await_Task_Of_NullableUserStruct_Returns_Value()
    {
        const string source = """
            package i1785struct
            import System
            import System.Threading.Tasks

            struct Point1785(X int32) { }

            async func inner() Point1785 {
                return Point1785(42)
            }

            async func getVal() Point1785? {
                let v = await inner()
                return v
            }

            let opt = getVal().Result
            let p = opt ?? Point1785(0)
            Console.WriteLine(p.X)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Await_Task_Of_NullableUserEnum_Returns_Value()
    {
        const string source = """
            package i1785enum
            import System
            import System.Threading.Tasks

            enum Color1785 { Red, Green, Blue }

            async func inner() Color1785 {
                return Color1785.Green
            }

            async func getVal() Color1785? {
                let v = await inner()
                return v
            }

            let opt = getVal().Result
            let r = opt ?? Color1785.Red
            Console.WriteLine(r)
            """;

        // G# has no user-defined enum ToString override here, so
        // Console.WriteLine prints the underlying int32 value (Green = 1).
        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void Await_Task_Of_NullableUserClass_Still_Works()
    {
        // Regression guard: a nullable REFERENCE type (`UserClass?`) has the
        // same CLR shape as the bare class (no `Nullable<T>` wrapper), but its
        // NullableTypeSymbol also reports a null ClrType during compilation.
        // The fix must not force reference-type nullables down the
        // value-type-nullable path; they still need the widened detection so
        // `WrapAsTask` produces `Task[UserClass?]` instead of falling through
        // unwrapped.
        const string source = """
            package i1785class
            import System
            import System.Threading.Tasks

            class Box1785(X int32) { }

            async func inner() Box1785 {
                return Box1785(42)
            }

            async func getVal() Box1785? {
                let v = await inner()
                return v
            }

            let opt = getVal().Result
            let b = opt ?? Box1785(0)
            Console.WriteLine(b.X)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1785_exe_").FullName;
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
