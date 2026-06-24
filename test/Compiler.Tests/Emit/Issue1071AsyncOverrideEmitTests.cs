// <copyright file="Issue1071AsyncOverrideEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1071: an <c>async func</c> validly overrides a base method declared
/// <c>func M() Task</c> / <c>func M() Task[T]</c>, and validly implements an
/// interface method declared the same way. This emit test compiles and runs a
/// program that dispatches through a <em>base reference</em> to an async
/// override and through an <em>interface reference</em> to an async
/// implementation, awaiting both and asserting the observable effects/values —
/// confirming the overriding/implementing async methods occupy proper
/// override / interface-impl slots and the produced assembly IL-verifies and
/// runs.
/// </summary>
public class Issue1071AsyncOverrideEmitTests
{
    [Fact]
    public void AsyncOverrideAndInterfaceImpl_DispatchThroughBaseAndInterface_RunsCorrectly()
    {
        var source = """
            package p

            import System
            import System.Threading.Tasks

            open class Base {
                public open func DoAsync() Task;
            }

            open class Derived : Base {
                public override async func DoAsync() {
                    await Task.CompletedTask
                    Console.WriteLine("override-ran")
                }
            }

            interface I { func GetAsync() Task[int32]; }

            class C : I {
                public async func GetAsync() int32 {
                    await Task.CompletedTask
                    return 42
                }
            }

            let b Base = Derived()
            b.DoAsync().GetAwaiter().GetResult()
            let i I = C()
            let v = i.GetAsync().GetAwaiter().GetResult()
            Console.WriteLine(v)
            """;

        var output = CompileAndRunThroughMetadataLoadContext(source);

        Assert.Equal("override-ran\n42\n", output);
    }

    private static string CompileAndRunThroughMetadataLoadContext(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1071_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
            var references = Directory
                .EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
                .Where(p => Path.GetFileName(p).StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                            || string.Equals(Path.GetFileName(p), "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                            || string.Equals(Path.GetFileName(p), "netstandard.dll", StringComparison.OrdinalIgnoreCase))
                .ToArray();

            Assert.NotEmpty(references);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                var args = new List<string>
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                };
                args.AddRange(references.Select(r => "/reference:" + r));
                args.Add(srcPath);
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
            IlVerifier.Verify(outPath);
            Assert.True(File.Exists(outPath), $"expected emitted assembly at {outPath}");

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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
