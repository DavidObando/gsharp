// <copyright file="Issue1268StaticVirtualGenericInterfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0089 / issue #1268 — end-to-end emit + execution of static-virtual
/// interface members dispatched through a type parameter whose constraint is a
/// *constructed generic* interface (the self-referential
/// <c>T : IData[T]</c> shape used by generic-math-style code). Validates that:
/// <list type="bullet">
///   <item>the consumer's <c>constrained. !!T  call</c> targets a MemberRef
///   parented at the constructed interface's TypeSpec (issue #1268 emit fix);</item>
///   <item>the implementer's <c>MethodImpl</c> rows pair its static override
///   against the constructed-interface slot, so the runtime resolves the body
///   (no <c>TypeLoadException</c>);</item>
///   <item>both static-virtual methods and get-only / get-set properties work.</item>
/// </list>
/// Each test compiles a concrete implementer, IL-verifies, executes, and
/// asserts the runtime value produced by the implementer's body.
/// </summary>
public class Issue1268StaticVirtualGenericInterfaceEmitTests
{
    [Fact]
    public void StaticVirtualMethod_ThroughSelfReferentialGenericConstraint_RunsAndReturnsExpected()
    {
        var source = """
            package Probe
            import System

            interface IData[TData IData[TData]] {
                shared {
                    func Size() int32;
                }
            }

            struct TrackNumber : IData[TrackNumber] {
                shared {
                    func Size() int32 { return 11 }
                }
            }

            func Use[T IData[T]](w T) int32 {
                return T.Size()
            }

            func Main() {
                Console.WriteLine(Use(TrackNumber{}))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("11\n", output);
    }

    [Fact]
    public void StaticVirtualGetOnlyProperty_ThroughSelfReferentialGenericConstraint_RunsAndReturnsExpected()
    {
        var source = """
            package Probe
            import System

            interface IData[TData IData[TData]] {
                shared {
                    prop SizeInBytes int32 { get; }
                }
            }

            struct TrackNumber : IData[TrackNumber] {
                shared {
                    prop SizeInBytes int32 { get { return 7 } }
                }
            }

            func Use[T IData[T]](w T) int32 {
                return T.SizeInBytes
            }

            func Main() {
                Console.WriteLine(Use(TrackNumber{}))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void StaticVirtualGetSetProperty_ThroughSelfReferentialGenericConstraint_RunsAndReturnsExpected()
    {
        var source = """
            package Probe
            import System

            interface IData[TData IData[TData]] {
                shared {
                    prop Tag int32 { get; set }
                }
            }

            struct TrackNumber : IData[TrackNumber] {
                shared {
                    prop Tag int32 { get { return 42 } set { } }
                }
            }

            func Use[T IData[T]](w T) int32 {
                return T.Tag
            }

            func Main() {
                Console.WriteLine(Use(TrackNumber{}))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void StaticVirtualMember_ThroughNonSelfReferentialGenericConstraint_RunsAndReturnsExpected()
    {
        var source = """
            package Probe
            import System

            interface IData[X] {
                shared {
                    func Size() int32;
                }
            }

            struct TrackNumber : IData[int32] {
                shared {
                    func Size() int32 { return 99 }
                }
            }

            func Use[T IData[int32]](w T) int32 {
                return T.Size()
            }

            func Main() {
                Console.WriteLine(Use(TrackNumber{}))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1268_exe_").FullName;
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

            IlVerifier.Verify(dllPath, ignoredErrorCodes: IlVerifier.KnownIssues.StaticVirtualInterface);

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
