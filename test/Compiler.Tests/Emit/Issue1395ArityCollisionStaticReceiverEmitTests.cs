// <copyright file="Issue1395ArityCollisionStaticReceiverEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1395: when a non-generic (arity-0) type and a generic type share the
/// same simple name (arity overloading, e.g. <c>Box</c> and <c>Box[T]</c>), a
/// generic static member-access receiver <c>Box[int32].Make(...)</c> must
/// resolve the receiver to the arity-1 generic type — selected by the supplied
/// type-argument count — while a plain <c>Box.Make()</c> still resolves to the
/// non-generic type. These end-to-end tests round-trip gsc → PE → dotnet exec
/// (with IL verification) proving both same-name static call sites emit the
/// correct, distinct constructions.
/// </summary>
public class Issue1395ArityCollisionStaticReceiverEmitTests
{
    [Fact]
    public void ArityCollision_GenericAndNonGenericStaticCalls_Execute()
    {
        // `Box` (arity-0) and `Box[T]` (arity-1) share a simple name. The
        // generic receiver `Box[int32].Make(7)` must bind to `Box[T]` and the
        // non-generic `Box.Make()` to `Box`, each carrying its own value.
        var source = """
            package P
            import System

            class Box {
                var tag int32
                init() { tag = -1 }
                shared { func Make() Box -> Box() }
            }

            class Box[T] {
                var value T
                init(v T) { value = v }
                shared { func Make(v T) Box[T] -> Box[T](v) }
            }

            func Run() int32 {
                let generic = Box[int32].Make(7)
                let nonGeneric = Box.Make()
                return generic.value + nonGeneric.tag
            }

            Console.WriteLine(Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n", output);
    }

    [Fact]
    public void ArityCollision_NullableTypeArg_Executes()
    {
        // The generic type argument is nullable (`Box[int32?]`); the receiver
        // must still resolve to the arity-1 generic construction.
        var source = """
            package P
            import System

            class Box {
                shared { func Tag() int32 -> 100 }
            }

            class Box[T] {
                var value T
                init(v T) { value = v }
                shared { func Make(v T) Box[T] -> Box[T](v) }
            }

            func Run() int32 {
                let g = Box[int32?].Make(41)
                return (g.value ?? 0) + Box.Tag()
            }

            Console.WriteLine(Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("141\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1395_").FullName;
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

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi);
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
