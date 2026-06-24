// <copyright file="Issue1068InterfacePropertyAccessEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1068: end-to-end emit + execute coverage for reading and writing a
/// property through an interface-typed reference. Interface methods already
/// dispatched correctly; property access on an interface receiver previously
/// failed to bind (GS0158). The fix routes interface property reads/writes
/// through the canonical member-resolution layer and emits a verifiable
/// <c>callvirt get_X</c> / <c>callvirt set_X</c> against the abstract interface
/// accessor.
///
/// Each test compiles via <c>gsc</c>, ilverifies the produced PE, then runs the
/// assembly under <c>dotnet exec</c> and asserts on captured stdout.
/// </summary>
public class Issue1068InterfacePropertyAccessEmitTests
{
    [Fact]
    public void GetOnlyProperty_ReadThroughInterfaceReference_DispatchesToImplementer()
    {
        var source = """
            package t
            import System

            interface IBase { prop H int32 { get; } }

            class C : IBase {
                prop H int32 { get; init; }
                init(h int32) { H = h }
            }

            func read(b IBase) int32 { return b.H }

            var c = C(42)
            Console.WriteLine(read(c))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void InheritedAndDeclaredProperties_ReadAndWriteThroughInterfaceReference()
    {
        // H is inherited from IBase; W is declared on IDerived with a setter.
        // All access goes through interface-typed references.
        var source = """
            package t
            import System

            interface IBase { prop H int32 { get; } }
            interface IDerived : IBase { prop W int32 { get; set; } }

            class C : IDerived {
                prop H int32 { get; init; }
                prop W int32 { get; set; }
                init(h int32) { H = h }
            }

            func readH(b IBase) int32 { return b.H }
            func writeW(d IDerived, v int32) { d.W = v }

            var c = C(40)
            writeW(c, 2)
            var d IDerived = c
            Console.WriteLine(readH(c))
            Console.WriteLine(d.W)
            Console.WriteLine(d.H)
            Console.WriteLine(readH(c) + d.W + d.H)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("40\n2\n40\n82\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1068_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
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
}
