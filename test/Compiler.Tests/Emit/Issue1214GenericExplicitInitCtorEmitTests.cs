// <copyright file="Issue1214GenericExplicitInitCtorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1214: end-to-end emit tests proving a generic class that declares an
/// explicit <c>init(...)</c> constructor can be constructed at a closed type
/// (<c>Box[int32](5, "x")</c>). The explicit <c>.ctor</c> is emitted once on the
/// erased generic <c>TypeDef</c>; the construction call site references it
/// through a <c>MemberRef</c> parented at the construction's <c>TypeSpec</c>
/// (<see cref="GSharp.CodeAnalysis.Emit.ReflectionMetadataEmitter"/>'s
/// <c>ResolveUserCtorTokenForExplicit</c>). Each test compiles via <c>gsc</c>,
/// runs <c>ilverify</c>, executes the produced assembly, and asserts that the
/// constructor actually ran (its argument round-trips through the instance) —
/// which can only hold when the ctor is correctly emitted and invoked.
/// </summary>
public class Issue1214GenericExplicitInitCtorEmitTests
{
    [Fact]
    public void GenericClass_ExplicitInitCtor_FieldsFromInitParams_RoundTrip()
    {
        var source = """
            package Probe
            import System

            class Box[T] {
                let value T
                var label string
                init(v T, l string) {
                    value = v
                    label = l
                }
                func Get() T { return value }
                func Label() string { return label }
            }

            let b = Box[int32](5, "x")
            Console.WriteLine(b.Get())
            Console.WriteLine(b.Label())
            """;

        var output = CompileAndRun(source);

        // 5 proves the `value = v` field assignment in the constructor ran and
        // the int32 argument round-tripped through the `!0` slot; "x" proves the
        // second (string) init parameter was passed and stored correctly.
        Assert.Equal("5\nx\n", output);
    }

    [Fact]
    public void GenericClass_ExplicitInitCtor_TwoInstantiations_PerConstructionWorks()
    {
        var source = """
            package Probe
            import System

            class Box[T] {
                let value T
                init(v T) {
                    value = v
                }
                func Get() T { return value }
            }

            let i = Box[int32](42)
            let s = Box[string]("hello")
            Console.WriteLine(i.Get())
            Console.WriteLine(s.Get())
            """;

        var output = CompileAndRun(source);

        // Two distinct closed constructions (Box[int32] and Box[string]) each
        // newobj the SAME erased .ctor through a per-construction TypeSpec
        // MemberRef; 42 and hello prove both arguments were passed and stored.
        Assert.Equal("42\nhello\n", output);
    }

    [Fact]
    public void GenericClass_ExplicitInitCtor_TypeParameterReturn_RoundTrip()
    {
        var source = """
            package Probe
            import System

            open class Mp4Operation[TOutput] {
                let label string
                init(name string) {
                    label = name
                }
                func Name() string { return label }
            }

            func Make() Mp4Operation[int32] {
                return Mp4Operation[int32]("clip")
            }

            let op = Make()
            Console.WriteLine(op.Name())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("clip\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1214_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
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
                compileExit = Program.Main(args);
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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }
}
