// <copyright file="Issue3318MapForInEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3318: end-to-end emit + IL-verify coverage for range-<c>for</c>
/// over <c>map[K, V]</c>. The produced assemblies must be IL-verifiable
/// (the enumerator-based Dictionary lowering, including the #3313
/// symbolic-MemberRef path for open-generic maps, emits verifiable IL)
/// and run to the expected stdout. Assertions are order-independent
/// because map iteration order is unspecified.
/// </summary>
public class Issue3318MapForInEmitTests
{
    [Fact]
    public void ConcreteMap_TwoVar_Compiles_Verifies_And_Runs()
    {
        var source = """
            package P
            import System

            var m = map[int32, int32]{1: 10, 2: 20, 3: 30}
            var keySum = 0
            var valSum = 0
            for k, v in m {
                keySum = keySum + k
                valSum = valSum + v
            }
            Console.WriteLine(keySum)
            Console.WriteLine(valSum)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"6{Environment.NewLine}60{Environment.NewLine}", output);
    }

    [Fact]
    public void ConcreteMap_OneVar_KeyValuePair_Compiles_Verifies_And_Runs()
    {
        var source = """
            package P
            import System

            var m = map[string, int32]{"a": 1, "bb": 2}
            var n = 0
            for kv in m {
                n = n + kv.Key.Length * kv.Value
            }
            Console.WriteLine(n)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"5{Environment.NewLine}", output);
    }

    [Fact]
    public void OpenGenericMap_BothForms_Compile_Verify_And_Run()
    {
        var source = """
            package P
            import System

            func SumValues[K any](items map[K, int32]) int32 {
                var n = 0
                for k, v in items {
                    n = n + v
                }
                return n
            }

            func CountEntries[K any, V any](items map[K, V]) int32 {
                var n = 0
                for kv in items {
                    n = n + 1
                }
                return n
            }

            var m = map[string, int32]{"a": 1, "b": 2, "c": 4}
            Console.WriteLine(SumValues[string](m))
            Console.WriteLine(CountEntries[string, int32](m))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"7{Environment.NewLine}3{Environment.NewLine}", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue3318_emit_").FullName;
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

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

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

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
