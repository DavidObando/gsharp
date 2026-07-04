// <copyright file="Issue1989MultiArityOpenGenericTypeOfEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1989: same-base-name multi-arity BCL generic families (<c>Func</c>,
/// <c>Action</c>, …) broke the #1915 bare-name open-generic <c>typeof(...)</c>
/// fallback — <c>typeof(Func)</c> stayed GS0113 (every arity 1..16 matches
/// "Func", so the fallback correctly bails as ambiguous), and <c>typeof(Action)</c>
/// SILENTLY resolved to the non-generic <c>System.Action</c> instead of ever
/// reaching a generic <c>Action`N</c>.
/// <para>
/// G# has no <c>Name&lt;&gt;</c>/<c>Name&lt;,&gt;</c> unbound-generic spelling
/// (generics use <c>Name[T1, T2]</c> brackets), so the fix carries the
/// explicit requested arity the same way C# derives it from comma count —
/// via <c>_</c> placeholder type arguments: <c>typeof(Func[_])</c> is arity 1,
/// <c>typeof(Func[_, _])</c> is arity 2, etc. This always requires the
/// arity-suffixed generic and never falls back to a same-named non-generic
/// type, fixing the <c>Action</c> silent-wrong-type case for good.
/// </para>
/// </summary>
public class Issue1989MultiArityOpenGenericTypeOfEmitTests
{
    [Fact]
    public void EndToEnd_FuncArity1_TypeOf_ResolvesGenericOneArity()
    {
        const string source = """
            package i1989func1
            import System

            func Main() { System.Console.WriteLine(typeof(Func[_]).Name) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Func`1\n", output);
    }

    [Fact]
    public void EndToEnd_FuncArity2_TypeOf_ResolvesGenericTwoArity()
    {
        const string source = """
            package i1989func2
            import System

            func Main() { System.Console.WriteLine(typeof(Func[_, _]).Name) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Func`2\n", output);
    }

    [Fact]
    public void EndToEnd_ActionArity1_TypeOf_ResolvesGenericOneArity_NotNonGenericAction()
    {
        const string source = """
            package i1989action1
            import System

            func Main() { System.Console.WriteLine(typeof(Action[_]).Name) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Action`1\n", output);
    }

    [Fact]
    public void EndToEnd_ActionArity2_TypeOf_ResolvesGenericTwoArity()
    {
        const string source = """
            package i1989action2
            import System

            func Main() { System.Console.WriteLine(typeof(Action[_, _]).Name) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Action`2\n", output);
    }

    [Fact]
    public void EndToEnd_BareAction_TypeOf_StillResolvesNonGenericAction()
    {
        const string source = """
            package i1989actionbare
            import System

            func Main() { System.Console.WriteLine(typeof(Action).Name) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Action\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1989_exe_").FullName;
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
