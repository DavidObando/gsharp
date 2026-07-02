// <copyright file="Issue1610InterfaceByRefParamEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1610: interface methods with <c>ref</c>/<c>out</c>/<c>in</c>
/// parameters emitted by-value signatures on the abstract interface slot, so
/// implementing classes never matched the slot and the CLR threw
/// <c>TypeLoadException</c> ("does not have an implementation") at type load.
/// These tests compile through the real gsc driver, gate the output on
/// ilverify (which reported the missing implementation before the fix), and
/// execute the program out-of-process to prove interface dispatch works for
/// every ref kind.
/// </summary>
public class Issue1610InterfaceByRefParamEmitTests
{
    [Fact]
    public void InterfaceWithOutParam_ImplementedByClass_VerifiesAndRuns()
    {
        // Exact repro from issue #1610.
        var source = """
            package Repro
            import System

            interface Parser {
                func TryParse(s string, out result int32) bool;
            }

            class IntParser : Parser {
                func TryParse(s string, out result int32) bool {
                    result = 42
                    return true
                }
            }

            var p Parser = IntParser()
            var r = 0
            if p.TryParse("x", &r) {
                Console.WriteLine(r)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void InterfaceWithRefOutInParams_DispatchThroughInterface_VerifiesAndRuns()
    {
        var source = """
            package Mixed
            import System

            interface Mutator {
                func TryParse(s string, out result int32) bool;
                func Bump(ref counter int32, by int32);
                func Scale(in factor int32) int32;
            }

            class Impl : Mutator {
                func TryParse(s string, out result int32) bool {
                    result = 42
                    return true
                }

                func Bump(ref counter int32, by int32) {
                    counter = counter + by
                }

                func Scale(in factor int32) int32 {
                    return factor * 3
                }
            }

            var m Mutator = Impl()
            var r = 0
            if m.TryParse("x", &r) {
                Console.WriteLine(r)
            }
            var n = 5
            m.Bump(&n, 10)
            Console.WriteLine(n)
            Console.WriteLine(m.Scale(&n))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n15\n45\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1610_emit_").FullName;
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

            // (a) Static verification: the emitted IL must be valid — before
            // the fix ilverify reported the unimplemented interface method.
            IlVerifier.Verify(outPath);

            // (b) Dynamic verification: the emitted code must execute — before
            // the fix the program died at type load with TypeLoadException.
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
