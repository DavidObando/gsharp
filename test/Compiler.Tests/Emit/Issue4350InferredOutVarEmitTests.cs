// <copyright file="Issue4350InferredOutVarEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4350: an inline <c>out var</c> passed to an imported generic method
/// whose type argument is inferred from an in-scope G# type parameter keeps
/// the symbolic pointee (<c>ArraySegment[T]</c>) instead of the erased
/// <c>ArraySegment[object]</c>. Found by the Gsharp.Runtime.Values
/// self-migration (<c>MemoryMarshal.TryGetArray(memory, out var segment)</c>).
/// </summary>
public class Issue4350InferredOutVarEmitTests
{
    [Fact]
    public void InferredGenericOutVar_KeepsSymbolicTypeParameter()
    {
        var source = """
            package P
            import System
            import System.Runtime.InteropServices

            class Box[T] {
                shared {
                    func Owner(memory ReadOnlyMemory[T]) []?T {
                        if MemoryMarshal.TryGetArray(memory, out var segment) && segment.Array is {} array {
                            let typed []T = array
                            return typed
                        }
                        return nil
                    }

                    func Count(memory ReadOnlyMemory[T]) int32 {
                        if MemoryMarshal.TryGetArray(memory, out var segment) {
                            let copy ArraySegment[T] = segment
                            return copy.Count
                        }
                        return -1
                    }
                }
            }

            let xs = []string{"a", "b", "c"}
            let owner = Box[string].Owner(ReadOnlyMemory[string](xs, 1, 2))
            Console.WriteLine(object.ReferenceEquals(owner, xs))
            Console.WriteLine(Box[string].Count(ReadOnlyMemory[string](xs, 1, 2)))
            """;

        Assert.Equal(Lines("True", "2"), CompileAndRun(source));
    }

    private static string Lines(params string[] lines)
        => string.Concat(Array.ConvertAll(lines, line => line + Environment.NewLine));

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue4350_outvar_").FullName;
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

            using var proc = Process.Start(psi)!;
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
