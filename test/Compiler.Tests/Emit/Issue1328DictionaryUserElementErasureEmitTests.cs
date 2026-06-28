// <copyright file="Issue1328DictionaryUserElementErasureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1328: enumerating a <c>Dictionary[K, V]</c> whose VALUE type
/// <c>V</c> is a same-compilation user type erased the element to
/// <c>System.Object</c> whenever the element type had to be INFERRED (foreach /
/// LINQ), so member access failed with GS0158 and assignment with GS0155. This
/// is the <c>Dictionary</c>/<c>ValueCollection</c> sibling of #1320. These
/// end-to-end tests pin the fix at runtime: each builds a
/// <c>Dictionary[uint32, E]</c>, enumerates it through the four formerly-broken
/// inference forms (<c>for x in d.Values</c>, <c>for kv in d</c>,
/// <c>d.Values.Single()</c>, <c>d.Values.ToList()[i]</c>), accesses the user
/// member, executes, and asserts the values. A primitive-value control guards
/// the path that always worked.
/// </summary>
public class Issue1328DictionaryUserElementErasureEmitTests
{
    [Fact]
    public void ViaValues_ForIn_YieldsUserValues()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            data class E(Value uint32) {}

            func ViaValues(d Dictionary[uint32, E]) uint32 {
                var sum uint32 = 0
                for x in d.Values { sum = sum + x.Value }
                return sum
            }

            let d = Dictionary[uint32, E]()
            let k1 uint32 = 1
            let k2 uint32 = 2
            d.Add(k1, E(10))
            d.Add(k2, E(20))
            Console.WriteLine(ViaValues(d))
            """;

        Assert.Equal("30\n", CompileAndRun(source));
    }

    [Fact]
    public void ViaPair_ForIn_KeyValuePair_YieldsUserMembers()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            data class E(Value uint32) {}

            func ViaPair(d Dictionary[uint32, E]) uint32 {
                var sum uint32 = 0
                for kv in d { sum = sum + kv.Key + kv.Value.Value }
                return sum
            }

            let d = Dictionary[uint32, E]()
            let k1 uint32 = 1
            d.Add(k1, E(10))
            Console.WriteLine(ViaPair(d))
            """;

        // key 1 + value 10 = 11
        Assert.Equal("11\n", CompileAndRun(source));
    }

    [Fact]
    public void TwoVar_ForIn_Destructures_YieldsUserValue()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            data class E(Value uint32) {}

            func TwoVar(d Dictionary[uint32, E]) uint32 {
                var sum uint32 = 0
                for k, v in d { sum = sum + k + v.Value }
                return sum
            }

            let d = Dictionary[uint32, E]()
            let k1 uint32 = 1
            d.Add(k1, E(10))
            Console.WriteLine(TwoVar(d))
            """;

        Assert.Equal("11\n", CompileAndRun(source));
    }

    [Fact]
    public void ViaSingle_LinqTerminal_YieldsUserValue()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            data class E(Value uint32) {}

            func ViaSingle(d Dictionary[uint32, E]) uint32 -> d.Values.Single().Value

            let d = Dictionary[uint32, E]()
            let k1 uint32 = 1
            d.Add(k1, E(42))
            Console.WriteLine(ViaSingle(d))
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void ViaToList_Indexer_YieldsUserValue()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            data class E(Value uint32) {}

            func ViaToList(d Dictionary[uint32, E]) uint32 -> d.Values.ToList()[0].Value

            let d = Dictionary[uint32, E]()
            let k1 uint32 = 1
            d.Add(k1, E(7))
            Console.WriteLine(ViaToList(d))
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void PrimitiveValues_ForIn_Control_StillWorks()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            func PrimValues(d Dictionary[uint32, int32]) int32 {
                var sum int32 = 0
                for x in d.Values { sum = sum + x }
                return sum
            }

            let d = Dictionary[uint32, int32]()
            let k1 uint32 = 1
            let k2 uint32 = 2
            d.Add(k1, 5)
            d.Add(k2, 9)
            Console.WriteLine(PrimValues(d))
            """;

        Assert.Equal("14\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source, string[] ignoredIlErrorCodes = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1328_").FullName;
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

            IlVerifier.Verify(outPath, ignoredErrorCodes: ignoredIlErrorCodes);

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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
