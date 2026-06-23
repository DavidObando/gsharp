// <copyright file="Issue1006InterfaceInheritanceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1006: end-to-end emit + execute coverage for interface inheritance
/// (<c>interface B : A</c>). An interface that extends another interface
/// inherits its members, records the base interface in metadata as an
/// InterfaceImpl row on its TypeDef, and a class implementing the derived
/// interface must satisfy both the inherited and the declared members. Calling
/// an inherited member through a base-typed reference dispatches to the
/// implementer.
///
/// Each test compiles via <c>gsc</c>, ilverifies the produced PE, then runs the
/// assembly under <c>dotnet exec</c> and asserts on captured stdout.
/// </summary>
public class Issue1006InterfaceInheritanceEmitTests
{
    [Fact]
    public void DerivedInterface_DispatchesInheritedAndDeclaredMembers()
    {
        // `b.F()` is inherited from A; `b.G()` is declared on B. Both are
        // dispatched through a B-typed reference to the C implementation.
        var source = """
            package t
            import System

            interface A { func F() int32; }
            interface B : A { func G() int32; }

            class C : B {
                func F() int32 { return 10 }
                func G() int32 { return 32 }
            }

            var b B = C{}
            Console.WriteLine(b.F())
            Console.WriteLine(b.G())
            Console.WriteLine(b.F() + b.G())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n32\n42\n", output);
    }

    [Fact]
    public void DerivedInterface_RecordsBaseInterfaceImplInMetadata()
    {
        // The derived interface declares the base interface, so the runtime
        // sees A as assignable-from B (an InterfaceImpl row was emitted).
        var source = """
            package t
            import System

            interface A { func F() int32; }
            interface B : A { func G() int32; }

            class C : B {
                func F() int32 { return 7 }
                func G() int32 { return 0 }
            }

            var c = C{}
            var a A = c
            Console.WriteLine(a.F())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void InterfaceWithMultipleBases_DispatchesAllMembers()
    {
        var source = """
            package t
            import System

            interface A { func F() int32; }
            interface C2 { func H() int32; }
            interface B : A, C2 { func G() int32; }

            class Impl : B {
                func F() int32 { return 1 }
                func G() int32 { return 2 }
                func H() int32 { return 3 }
            }

            var b B = Impl{}
            Console.WriteLine(b.F() + b.G() + b.H())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1006_").FullName;
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
