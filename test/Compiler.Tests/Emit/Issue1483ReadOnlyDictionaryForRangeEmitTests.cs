// <copyright file="Issue1483ReadOnlyDictionaryForRangeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1483: end-to-end emit + IL-verify coverage for <c>for k, v in d</c>
/// over a receiver typed only as <c>IReadOnlyDictionary[K, V]</c>. Pre-fix the
/// binder failed to recognize the read-only mapping family and mis-lowered the
/// loop as <c>ForRangeKind.Enumerable</c> — binding <c>k</c> to an
/// <c>int32</c> running index and <c>v</c> to <c>KeyValuePair[K, V]</c>. These
/// tests prove the loop now key/value destructures: <c>k</c> is the string KEY
/// and <c>v</c> is the int32 VALUE, and the produced assembly IL-verifies.
/// </summary>
public class Issue1483ReadOnlyDictionaryForRangeEmitTests
{
    [Fact]
    public void ReadOnlyDictionary_Receiver_ForKV_Destructures_Key_And_Value()
    {
        // A single-entry dictionary keeps iteration deterministic. `firstKey`
        // returns `k` as a string (impossible under the enumerable
        // mis-binding, where `k` is an int32 index), and `sumValues` adds `v`
        // as an int32 (impossible if `v` were a KeyValuePair). The receivers
        // are typed as IReadOnlyDictionary[string, int32]; a Dictionary is
        // passed in via the read-only interface upcast.
        var source = """
            package P1483
            import System
            import System.Collections.Generic

            func Issue1483FirstKey(d IReadOnlyDictionary[string, int32]) string {
                for k, v in d {
                    return k
                }
                return "none"
            }

            func Issue1483SumValues(d IReadOnlyDictionary[string, int32]) int32 {
                var total = 0
                for k, v in d {
                    total = total + v
                }
                return total
            }

            var d = Dictionary[string, int32]()
            d["solo"] = 7
            Console.WriteLine(Issue1483FirstKey(d))
            Console.WriteLine(Issue1483SumValues(d))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("solo\n7\n", output);
    }

    [Fact]
    public void ReadOnlyDictionary_Receiver_ForKV_SumsValues_OrderIndependent()
    {
        // Multiple entries: summing values and key lengths is order-independent,
        // so the result is deterministic regardless of dictionary enumeration
        // order. Proves both K (string, via len) and V (int32) destructure.
        var source = """
            package P1483b
            import System
            import System.Collections.Generic
            import Gsharp.Extensions.Go

            func Issue1483Fold(d IReadOnlyDictionary[string, int32]) int32 {
                var acc = 0
                for k, v in d {
                    acc = acc + v + len(k)
                }
                return acc
            }

            var d = Dictionary[string, int32]()
            d["a"] = 10
            d["bb"] = 20
            Console.WriteLine(Issue1483Fold(d))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("33\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1483_emit_").FullName;
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

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
