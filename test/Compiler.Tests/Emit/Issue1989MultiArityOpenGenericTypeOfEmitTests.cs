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

    /// <summary>
    /// Issue #2012 (S3): hardens the existing emit coverage — which only
    /// asserted on <c>.Name</c> (a string that collapses closed and open
    /// generics to the same value, e.g. both <c>Func&lt;int&gt;</c> and open
    /// <c>Func`1</c> print "Func`1") — with an actual reflection <see
    /// cref="Type"/> equality check against <c>typeof(System.Func&lt;&gt;)</c>,
    /// proving <c>typeof(Func[_])</c> really is the same CLR open-generic
    /// type definition, not merely a type whose name happens to match.
    /// </summary>
    [Fact]
    public void EndToEnd_FuncArity1_TypeOf_ReflectionEquals_ClrOpenGenericFuncDefinition()
    {
        const string source = """
            package i2012s3func1
            import System

            func Main() { System.Console.WriteLine(typeof(Func[_]).AssemblyQualifiedName) }
            """;

        var output = CompileAndRun(source);
        var resolvedType = Type.GetType(output.Trim());
        Assert.Equal(typeof(Func<>), resolvedType);
    }

    /// <summary>
    /// Issue #2012 (N3): when the requested arity resolves to two or more
    /// DIFFERENT CLR types across the imports in scope, the previous
    /// behavior misreported "type doesn't exist" (GS0113). This is a genuine
    /// ambiguity, not an absence, and now reports GS0471 instead.
    /// </summary>
    [Fact]
    public void ExplicitArity_AmbiguousAcrossTwoImportedAssemblies_ReportsGS0471()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2012_amb_").FullName;
        try
        {
            var aDll = Path.Combine(tempDir, "a.dll");
            var bDll = Path.Combine(tempDir, "b.dll");
            CompileLibrary("package pkg.a\nclass Foo[T any] {\n}\n", aDll, tempDir);
            CompileLibrary("package pkg.b\nclass Foo[T any] {\n}\n", bDll, tempDir);

            const string source = """
                package pkg.c
                import pkg.a
                import pkg.b

                func Main() {
                    let t = typeof(Foo[_])
                }
                """;
            var srcPath = Path.Combine(tempDir, "c.gs");
            File.WriteAllText(srcPath, source);
            var dllPath = Path.Combine(tempDir, "c.dll");

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/r:" + aDll,
                "/r:" + bDll,
                "/nowarn:GS9100",
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

            Assert.NotEqual(0, compileExit);
            Assert.Contains("GS0471", stdoutWriter.ToString() + stderrWriter.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static void CompileLibrary(string source, string dllPath, string tempDir)
    {
        var srcPath = Path.Combine(tempDir, Path.GetFileNameWithoutExtension(dllPath) + ".gs");
        File.WriteAllText(srcPath, source);
        var args = new[]
        {
            "/out:" + dllPath,
            "/target:library",
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
            $"gsc failed compiling library {dllPath}:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");
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
