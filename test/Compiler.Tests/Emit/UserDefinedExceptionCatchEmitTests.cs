// <copyright file="UserDefinedExceptionCatchEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #421 (P2-6): a <c>catch</c> clause whose exception type is a user-defined
/// G# class (i.e. <c>ExceptionType.ClrType</c> is <c>null</c> at emit time, because
/// the type is still being defined in the same assembly) used to NRE or build a
/// bogus token in <c>EmitCatchClauses</c>. The emitter now falls back to its
/// internal <c>structTypeDefs</c> registry via <c>GetElementTypeToken</c>, the same
/// pattern used everywhere else for user-defined types. These tests compile and
/// run small G# programs that catch a user-defined exception class to verify the
/// emitted IL is valid and the catch handler actually fires.
/// </summary>
public class UserDefinedExceptionCatchEmitTests
{
    [Fact]
    public void Catch_With_User_Defined_Exception_Class_Compiles_And_Runs()
    {
        var src = """
            package main
            import System

            type MyError class(Detail string) : Exception(Detail) {
            }

            func Main() int32 {
                var trace = ""
                try {
                    var n = Int32.Parse("not a number")
                } catch (e MyError) {
                    trace = "my:" + e.Message
                } catch (e Exception) {
                    trace = "generic:caught"
                }
                Console.WriteLine(trace)
                return 0
            }
            """;

        Assert.Equal("generic:caught\n", CompileAndRun(src));
    }

    [Fact]
    public void Catch_Specific_User_Defined_Exception_Before_Generic_Exception()
    {
        var src = """
            package main
            import System

            type MyError class(Detail string) : Exception(Detail) {
            }

            type AnotherError class(Detail string) : Exception(Detail) {
            }

            func Main() int32 {
                var trace = ""
                try {
                    var n = Int32.Parse("oops")
                } catch (e MyError) {
                    trace = "my"
                } catch (e AnotherError) {
                    trace = "another"
                } catch (e Exception) {
                    trace = "generic"
                }
                Console.WriteLine(trace)
                return 0
            }
            """;

        Assert.Equal("generic\n", CompileAndRun(src));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_p2_6_catch_").FullName;
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
            try { Directory.Delete(tempDir, recursive: true); }
            catch { }
        }
    }
}
