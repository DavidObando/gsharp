// <copyright file="Issue605AwaitUsingLetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #605: <c>await using let</c> support for types implementing
/// <c>IAsyncDisposable</c>. Tests cover user-defined G# classes, CLR types,
/// mixed IDisposable + IAsyncDisposable, exception safety, return semantics,
/// and negative diagnostics (outside async, async-only with sync using).
/// </summary>
public class Issue605AwaitUsingLetEmitTests
{
    [Fact]
    public void AwaitUsingLet_UserClassImplementsIAsyncDisposable_DisposeAsyncCalledAtScopeExit()
    {
        var source = """
            package Probe
            import System
            import System.Threading.Tasks

            class AsyncResource : IAsyncDisposable {
                func DisposeAsync() ValueTask {
                    Console.WriteLine("disposed-async")
                    return ValueTask.CompletedTask
                }
            }

            async func test() {
                await using let r = AsyncResource{}
                Console.WriteLine("inside")
            }
            test().GetAwaiter().GetResult()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("inside\ndisposed-async\n", output);
    }

    [Fact]
    public void AwaitUsingLet_ClrClassImplementsIAsyncDisposable_DisposeAsyncCalledAtScopeExit()
    {
        // We use a sibling C# assembly that prints on DisposeAsync to confirm it's called.
        var csHelper = """
            using System;
            using System.Threading.Tasks;

            namespace AsyncHelpers
            {
                public class ClrAsyncDisp : IAsyncDisposable
                {
                    public ValueTask DisposeAsync()
                    {
                        Console.WriteLine("clr-disposed-async");
                        return ValueTask.CompletedTask;
                    }
                }
            }
            """;

        var source = """
            package Probe
            import System
            import System.Threading.Tasks
            import AsyncHelpers

            async func test() {
                await using let r = ClrAsyncDisp()
                Console.WriteLine("inside-clr")
            }
            test().GetAwaiter().GetResult()
            """;

        var output = CompileAndRunWithSiblingCs(source, csHelper);
        Assert.Equal("inside-clr\nclr-disposed-async\n", output);
    }

    [Fact]
    public void AwaitUsingLet_TypeImplementsBothSyncAndAsync_PrefersDisposeAsync()
    {
        var source = """
            package Probe
            import System
            import System.Threading.Tasks

            class DualDisp : IDisposable, IAsyncDisposable {
                func Dispose() {
                    Console.WriteLine("sync-dispose")
                }
                func DisposeAsync() ValueTask {
                    Console.WriteLine("async-dispose")
                    return ValueTask.CompletedTask
                }
            }

            async func test() {
                await using let d = DualDisp{}
                Console.WriteLine("body")
            }
            test().GetAwaiter().GetResult()
            """;

        var output = CompileAndRun(source);
        // await using must call DisposeAsync, NOT Dispose.
        Assert.Equal("body\nasync-dispose\n", output);
    }

    [Fact]
    public void AwaitUsingLet_DisposeAsyncCalledEvenOnException()
    {
        var source = """
            package Probe
            import System
            import System.Threading.Tasks

            class SafeRes : IAsyncDisposable {
                func DisposeAsync() ValueTask {
                    Console.WriteLine("safe-dispose")
                    return ValueTask.CompletedTask
                }
            }

            async func test() {
                try {
                    await using let s = SafeRes{}
                    Console.WriteLine("before-throw")
                    throw Exception("boom")
                } catch (ex Exception) {
                    Console.WriteLine("caught")
                }
            }
            test().GetAwaiter().GetResult()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("before-throw\nsafe-dispose\ncaught\n", output);
    }

    [Fact]
    public void AwaitUsingLet_ReturnsValueFromScope_DisposesBeforeReturn()
    {
        // Tests that DisposeAsync runs when the scope completes normally
        // and a value is returned from the function.
        var source = """
            package Probe
            import System
            import System.Threading.Tasks

            class TrackRes : IAsyncDisposable {
                func DisposeAsync() ValueTask {
                    Console.WriteLine("track-dispose")
                    return ValueTask.CompletedTask
                }
            }

            async func compute() int32 {
                var result = 0
                {
                    await using let t = TrackRes{}
                    Console.WriteLine("computing")
                    result = 42
                }
                return result
            }

            let result = compute().GetAwaiter().GetResult()
            Console.WriteLine("result=" + result.ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("computing\ntrack-dispose\nresult=42\n", output);
    }

    [Fact]
    public void AwaitUsingLet_OutsideAsyncFunction_ErrorsWithPreciseGS()
    {
        var source = """
            package Probe
            import System
            import System.Threading.Tasks

            class Res : IAsyncDisposable {
                func DisposeAsync() ValueTask {
                    return ValueTask.CompletedTask
                }
            }

            func test() {
                await using let r = Res{}
                Console.WriteLine("nope")
            }
            test()
            """;

        var errors = CompileExpectingErrors(source);
        Assert.Contains(errors, e => e.Contains("GS0271"));
    }

    [Fact]
    public void UsingLet_OnIAsyncDisposableOnlyType_StillErrorsBecauseNoSyncDispose()
    {
        var source = """
            package Probe
            import System
            import System.Threading.Tasks

            class AsyncOnly : IAsyncDisposable {
                func DisposeAsync() ValueTask {
                    Console.WriteLine("async-only")
                    return ValueTask.CompletedTask
                }
            }

            func test() {
                using let r = AsyncOnly{}
                Console.WriteLine("nope")
            }
            test()
            """;

        var errors = CompileExpectingErrors(source);
        Assert.Contains(errors, e => e.Contains("GS0119"));
    }

    [Fact]
    public void UsingLet_OnSyncIDisposable_StillWorks()
    {
        // Regression: ensure the 6.4 using-let fix is unaffected.
        var source = """
            package Probe
            import System

            class SyncRes : IDisposable {
                func Dispose() {
                    Console.WriteLine("sync-disposed")
                }
            }

            func test() {
                using let s = SyncRes{}
                Console.WriteLine("sync-inside")
            }
            test()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("sync-inside\nsync-disposed\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue605_").FullName;
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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRunWithSiblingCs(string gsSource, string csHelper)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue605_sibling_").FullName;
        try
        {
            // Compile the C# helper into a sibling DLL.
            var csDir = Path.Combine(tempDir, "csref");
            Directory.CreateDirectory(csDir);
            File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csHelper);
            File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Library</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                    <Nullable>enable</Nullable>
                    <AssemblyName>Helper</AssemblyName>
                  </PropertyGroup>
                </Project>
                """);

            RunDotnet(csDir, "restore");
            RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");

            var csDll = Path.Combine(csDir, "bin", "Release", "net10.0", "Helper.dll");
            Assert.True(File.Exists(csDll), $"Helper.dll not found at {csDll}");

            // Now compile the G# source referencing the helper.
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, gsSource);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + csDll,
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add(srcPath);

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

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            File.Copy(csDll, Path.Combine(tempDir, "Helper.dll"), overwrite: true);

            IlVerifier.Verify(outPath, additionalReferences: new[] { csDll });

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

    private static void RunDotnet(string workingDir, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDir,
        };
        foreach (var a in args)
        {
            psi.ArgumentList.Add(a);
        }

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start dotnet");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(60_000), $"dotnet {args[0]} timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"dotnet {args[0]} failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }

    private static List<string> CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue605_err_").FullName;
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

            Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded");
            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
