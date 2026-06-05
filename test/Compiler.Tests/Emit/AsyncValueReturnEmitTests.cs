// <copyright file="AsyncValueReturnEmitTests.cs" company="GSharp">
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
/// Regression tests for issue #290: an <c>async func</c> that returns a value
/// type (so the kickoff returns <c>Task&lt;T&gt;</c> for a value <c>T</c>)
/// crashed <c>gsc</c> under the SDK build path. That path supplies reference
/// assemblies through a <see cref="System.Reflection.MetadataLoadContext"/>, and
/// constructing <c>Task&lt;T&gt;</c> with a host-runtime type argument threw
/// <see cref="ArgumentException"/> ("was not loaded by the MetadataLoadContext
/// that loaded the generic type or method"). These tests reproduce the SDK path
/// by compiling with explicit <c>/reference</c> arguments, which forces the
/// binder onto the MetadataLoadContext-backed resolver.
/// </summary>
public class AsyncValueReturnEmitTests
{
    [Fact]
    public void Async_Func_Returning_Value_Types_Compiles_And_Runs_Through_MetadataLoadContext()
    {
        // Each async func below forces WrapAsTask / ResolveAsyncReturnClrType to
        // build Task<T> for a value (or reference) T while the binder is on the
        // MetadataLoadContext-backed resolver — the exact path that crashed in
        // #290. The runtime portion only needs to confirm the emitted assembly
        // loads and runs without the MetadataLoadContext mismatch.
        var source = """
            package P

            import System
            import System.Threading.Tasks

            async func asyncInt() int32 {
                await Task.Delay(1)
                return 21 * 2
            }

            async func asyncBool() bool {
                await Task.Delay(1)
                return true
            }

            async func asyncFloat() float64 {
                await Task.Delay(1)
                return 3.5 + 1.0
            }

            async func asyncString() string {
                await Task.Delay(1)
                return "hi"
            }

            let ti = asyncInt()
            let tb = asyncBool()
            let tf = asyncFloat()
            let ts = asyncString()
            Console.WriteLine("done")
            """;

        var output = CompileAndRunThroughMetadataLoadContext(source);

        Assert.Equal("done\n", output);
    }

    private static string CompileAndRunThroughMetadataLoadContext(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_async_mlc_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            // Passing /reference paths makes ReferenceResolver load them into an
            // isolated MetadataLoadContext, exactly as the SDK build does. Using
            // the host runtime's assemblies keeps the test self-contained.
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
            IlVerifier.Verify(outPath, ignoredErrorCodes: IlVerifier.KnownIssues.AsyncStateMachine);
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
