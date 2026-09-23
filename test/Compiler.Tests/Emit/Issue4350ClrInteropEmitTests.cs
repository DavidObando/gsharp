// <copyright file="Issue4350ClrInteropEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4350: CLR interop shapes found by the Gsharp.Runtime.Values
/// self-migration. A ref-returning static CLR method auto-dereferences at the
/// use site (ADR-0056 §1), and an imported implicit conversion declared on the
/// SOURCE generic (<c>Span[T] -&gt; ReadOnlySpan[T]</c>) is parented at the
/// symbolic TypeSpec rather than the erased <c>&lt;object&gt;</c> instance.
/// </summary>
public class Issue4350ClrInteropEmitTests
{
    [Fact]
    public void RefReturningStaticClrCalls_AutoDereference()
    {
        var source = """
            package P
            import System
            import System.Runtime.CompilerServices
            import System.Runtime.InteropServices

            class Box[T] {
                shared {
                    func IsString(memory ReadOnlyMemory[T]) bool {
                        var memory = memory
                        return MemoryMarshal.TryGetString(Unsafe.As[ReadOnlyMemory[T], ReadOnlyMemory[char]](&memory), out _, out _, out _)
                    }
                }
            }

            let arr = []int32{7, 8}
            let first = MemoryMarshal.GetArrayDataReference(arr)
            Console.WriteLine(first + 1)
            var memory = ReadOnlyMemory[int32](arr)
            let reinterpreted = Unsafe.As[ReadOnlyMemory[int32], ReadOnlyMemory[uint32]](&memory)
            Console.WriteLine(reinterpreted.Length)
            Console.WriteLine(Box[char].IsString("abc".AsMemory()))
            Console.WriteLine(Box[int32].IsString(memory))
            """;

        Assert.Equal(Lines("8", "2", "True", "False"), CompileAndRun(source));
    }

    [Fact]
    public void SourceDeclaredGenericImplicitConversions_UseSymbolicOwner()
    {
        var source = """
            package P
            import System

            class Box[T] {
                let items []T
                init(items []T) {
                    this.items = items
                }

                func AsMemory() Memory[T] -> items.AsMemory()
                func AsReadOnlyMemory() ReadOnlyMemory[T] -> AsMemory()
                func Count() int32 {
                    let span Span[T] = items.AsSpan()
                    let view ReadOnlySpan[T] = span
                    return view.Length
                }
            }

            let box = Box[string]([]string{"a", "b", "c"})
            Console.WriteLine(box.AsReadOnlyMemory().Length)
            Console.WriteLine(box.Count())
            """;

        Assert.Equal(Lines("3", "3"), CompileAndRun(source));
    }

    private static string Lines(params string[] lines)
        => string.Concat(Array.ConvertAll(lines, line => line + Environment.NewLine));

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue4350_interop_").FullName;
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
