// <copyright file="Issue3333LoweringRewriterInterfaceStaticFieldTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3333 — three lowering rewriters override
/// <c>RewriteFieldAssignmentExpression</c> and re-introduced the #1644 defect
/// on their own paths: an interface static field write (ADR-0089 / #1030) is
/// built with the <c>(syntax, field, interfaceType, value)</c> constructor, and
/// rebuilding it through the variable-receiver constructor silently drops
/// <see cref="GSharp.Core.CodeAnalysis.Binding.BoundFieldAssignmentExpression.InterfaceType"/>.
/// The emitter then parents the field reference at the bare open-generic
/// TypeDef instead of a <c>TypeSpec</c>, and the interface's <c>.cctor</c> is
/// invoked on the uninstantiated type at runtime.
/// <list type="bullet">
///   <item><c>MoveNextBodyRewriter</c> — the write appears in an <c>async</c>
///     method and the right-hand side mentions a hoisted local, so the node is
///     cloned to carry the rewritten value.</item>
///   <item><c>SpillSequenceSpiller</c> — the right-hand side is itself an
///     <c>await</c>, so the assignment is rebuilt around the spilled value.</item>
///   <item><c>HoistedFieldRewriter</c> — the write appears in an iterator whose
///     locals are hoisted into state-machine fields.</item>
/// </list>
/// <para>Every case uses a <em>generic</em> interface, which is what makes the
/// dropped routing observable: a non-generic interface static field resolves
/// against the TypeDef either way, which is why the existing #1030 and #1644
/// coverage on these same paths does not catch it. Each test writes through two
/// distinct constructions so a regression that collapses them to shared storage
/// also fails.</para>
/// <para>Every interface is uniquely named so the process-wide symbol caches
/// cannot alias across tests.</para>
/// </summary>
public class Issue3333LoweringRewriterInterfaceStaticFieldTests
{
    [Fact]
    public void AsyncMethod_InterfaceStaticFieldWrite_KeepsPerConstructionStorage()
    {
        // MoveNextBodyRewriter: `n` is hoisted into a state-machine field, so
        // the assignment is cloned to carry the rewritten right-hand side.
        var source = """
            package Probe3333a
            import System
            import System.Threading.Tasks

            interface IBoxA3333[T] {
                shared {
                    var Count int32 = 0
                }
            }

            async func BumpAsync(n int32) {
                await Task.Delay(1)
                IBoxA3333[int32].Count = n
                IBoxA3333[string].Count = n + 100
            }

            func Main() {
                BumpAsync(5).Wait()
                Console.WriteLine(IBoxA3333[int32].Count)
                Console.WriteLine(IBoxA3333[string].Count)
            }
            """;

        Assert.Equal("5\n105\n", CompileAndRun(source));
    }

    [Fact]
    public void AwaitedRightHandSide_InterfaceStaticFieldWrite_KeepsPerConstructionStorage()
    {
        // SpillSequenceSpiller: the right-hand side contains an await, so
        // SpillFieldAssignment rebuilds the assignment around the spilled value.
        var source = """
            package Probe3333b
            import System
            import System.Threading.Tasks

            interface IBoxB3333[T] {
                shared {
                    var Count int32 = 0
                }
            }

            async func GetAsync(n int32) int32 {
                await Task.Delay(1)
                return n
            }

            async func BumpAsync(n int32) {
                IBoxB3333[int32].Count = await GetAsync(n)
                IBoxB3333[string].Count = await GetAsync(n + 100)
            }

            func Main() {
                BumpAsync(5).Wait()
                Console.WriteLine(IBoxB3333[int32].Count)
                Console.WriteLine(IBoxB3333[string].Count)
            }
            """;

        Assert.Equal("5\n105\n", CompileAndRun(source));
    }

    [Fact]
    public void Iterator_InterfaceStaticFieldWrite_KeepsPerConstructionStorage()
    {
        // HoistedFieldRewriter: the iterator's locals are hoisted into
        // state-machine fields, which clones the enclosing assignment.
        var source = """
            package Probe3333c
            import System
            import System.Collections.Generic

            interface IBoxC3333[T] {
                shared {
                    var Count int32 = 0
                }
            }

            func numbers(n int32) IEnumerable[int32] {
                IBoxC3333[int32].Count = n
                yield n
                IBoxC3333[string].Count = n + 100
                yield n + 1
            }

            func Main() {
                for v in numbers(5) {
                    Console.WriteLine(v)
                }

                Console.WriteLine(IBoxC3333[int32].Count)
                Console.WriteLine(IBoxC3333[string].Count)
            }
            """;

        Assert.Equal("5\n6\n5\n105\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3333_exe_").FullName;
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
