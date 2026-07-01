// <copyright file="Issue1538ImportedOutVarEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1538 — an inline <c>out var</c>/<c>out let</c>/<c>out _</c> argument
/// passed to an IMPORTED/overloaded method (BCL or referenced assembly), e.g.
/// <c>int32.TryParse(s, out var n)</c>, failed to resolve with
/// <c>GS0159: Cannot find function TryParse</c> and then POISONED the enclosing
/// method body (subsequent statements cascaded into spurious GS0159/GS0125).
/// Inline <c>out var</c> already worked for user-declared methods and for
/// imported methods when the out arg was pre-declared.
/// <para>
/// The fix feeds the <c>InlineOutVarArgumentType</c> sentinel through the
/// imported static-overload resolver (ImportedClassSymbol.TryLookupFunction) so
/// a type-open <c>out var</c> matches any by-ref parameter, then re-binds the
/// placeholder to the chosen overload's (substituted) out-parameter pointee type
/// via RebindInlineOutVarArguments so the synthesized local leaks into the
/// enclosing block scope with the correct type. This mirrors the imported
/// instance path.
/// </para>
/// Each test uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </summary>
public class Issue1538ImportedOutVarEmitTests
{
    [Fact]
    public void EndToEnd_ImportedStaticOverload_InlineOutVar_Runs()
    {
        // int32.TryParse is an overloaded imported STATIC method; the out arg is
        // an inline `out var`. `n` must be in scope AND correctly typed for the
        // rest of the body (no cascade on the following WriteLine statements).
        const string source = """
            package i1538staticoverload
            import System

            func Main() {
                let ok = int32.TryParse("42", out var n)
                Console.WriteLine(ok)
                Console.WriteLine(n)
                Console.WriteLine(n + 1)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n42\n43\n", output);
    }

    [Fact]
    public void EndToEnd_ImportedInstance_DictionaryTryGetValue_PresentKey_Runs()
    {
        // Dictionary[string,int32].TryGetValue is an imported INSTANCE method
        // whose out-parameter type is the receiver's value type argument.
        const string source = """
            package i1538dictpresent
            import System
            import System.Collections.Generic

            func Main() {
                var d = Dictionary[string, int32]()
                d["a"] = 7
                let has = d.TryGetValue("a", out var v)
                Console.WriteLine(has)
                Console.WriteLine(v)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n7\n", output);
    }

    [Fact]
    public void EndToEnd_ImportedInstance_DictionaryTryGetValue_AbsentKey_Runs()
    {
        const string source = """
            package i1538dictabsent
            import System
            import System.Collections.Generic

            func Main() {
                var d = Dictionary[string, int32]()
                d["a"] = 7
                let miss = d.TryGetValue("z", out var w)
                Console.WriteLine(miss)
                Console.WriteLine(w)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\n0\n", output);
    }

    [Fact]
    public void EndToEnd_GenericMethod_OutTypeIsTypeParameter_Runs()
    {
        // Inside a generic method, `Dictionary[K,V].TryGetValue(k, out var found)`
        // must bind `found : V` (the receiver's value type parameter), not the
        // erased `object`, so `return found` (typed V) type-checks and emits
        // verifiable IL.
        const string source = """
            package i1538generictp
            import System
            import System.Collections.Generic

            class Helper {
                shared {
                    func Lookup[K, V](d Dictionary[K, V], key K) V {
                        if d.TryGetValue(key, out var found) {
                            return found
                        }
                        return default
                    }
                }
            }

            func Main() {
                var d = Dictionary[string, int32]()
                d["x"] = 99
                Console.WriteLine(Helper.Lookup[string, int32](d, "x"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void EndToEnd_Control_ImportedStatic_PreDeclaredOut_Runs()
    {
        // Control: imported overloaded static method with a PRE-DECLARED out arg
        // still works (unchanged by the fix).
        const string source = """
            package i1538predeclared
            import System

            func Main() {
                var n int32 = 0
                let ok = int32.TryParse("13", out n)
                Console.WriteLine(ok)
                Console.WriteLine(n)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n13\n", output);
    }

    [Fact]
    public void EndToEnd_Control_UserMethod_InlineOutVar_Runs()
    {
        // Control: a USER single-overload method with an inline `out var` still
        // works (the pre-existing user-method path is not regressed).
        const string source = """
            package i1538usermethod
            import System

            class Ext {
                shared {
                    func Try(s string, out n int32) bool {
                        n = 42
                        return true
                    }
                }
            }

            func Main() {
                let ok = Ext.Try("x", out var n)
                Console.WriteLine(ok)
                Console.WriteLine(n)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n42\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1538_exe_").FullName;
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
