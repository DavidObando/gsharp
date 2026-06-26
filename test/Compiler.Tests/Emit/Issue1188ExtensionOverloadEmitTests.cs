// <copyright file="Issue1188ExtensionOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1188: extension functions (ADR-0019) support overloading exactly like
/// ordinary class methods and free functions. Two extension functions that share
/// a (receiver type, name) pair but differ in parameter signature — by arity, by
/// parameter type, or by generic arity — must coexist and dispatch to the correct
/// overload through the standard overload-resolution machinery. Extensions whose
/// receiver types differ stay independent.
/// <para>
/// The defect was that the extension-function declaration table was keyed by
/// <c>(receiver type, name)</c> and rejected any second extension with the same
/// name and receiver, reporting <c>GS0102 '&lt;name&gt;' is already declared</c>.
/// </para>
/// These tests prove that overloaded extension calls compile, IL-verify, and
/// produce the correct runtime results.
/// </summary>
public class Issue1188ExtensionOverloadEmitTests
{
    [Fact]
    public void Extension_Overload_ByArity_ResolvesCorrectOverload()
    {
        var source = """
            package P
            import System

            func (s string) Do(x int32) string {
                return "one"
            }

            func (s string) Do(x int32, y int32) string {
                return "two"
            }

            Console.WriteLine("hi".Do(1))
            Console.WriteLine("hi".Do(1, 2))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("one\ntwo\n", output);
    }

    [Fact]
    public void Extension_Overload_ByParameterType_ResolvesCorrectOverload()
    {
        var source = """
            package P
            import System

            func (s string) Tag(x int32) string {
                return "int"
            }

            func (s string) Tag(x string) string {
                return "str"
            }

            Console.WriteLine("hi".Tag(1))
            Console.WriteLine("hi".Tag("x"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("int\nstr\n", output);
    }

    [Fact]
    public void Extension_Overload_GenericArityVariant_ResolvesCorrectOverload()
    {
        var source = """
            package P
            import System

            func (s string) Pick(x int32) string {
                return "concrete"
            }

            func (s string) Pick[T](item T) string {
                return "generic"
            }

            Console.WriteLine("hi".Pick(1))
            Console.WriteLine("hi".Pick[string]("x"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("concrete\ngeneric\n", output);
    }

    [Fact]
    public void Extension_Overload_DifferentReceiverTypes_StayIndependent()
    {
        var source = """
            package P
            import System

            func (s string) Kind(x int32) string {
                return "string-recv"
            }

            func (n int32) Kind(x int32) string {
                return "int-recv"
            }

            Console.WriteLine("hi".Kind(1))
            Console.WriteLine((5).Kind(1))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("string-recv\nint-recv\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1188_emit_").FullName;
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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
