// <copyright file="Issue1291StaticFieldIndexEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1291: element access on a qualified static (shared) array field
/// receiver — <c>Type.staticField[i]</c> — bound the indexed value to the error
/// type <c>?</c> instead of the array's element type, surfacing GS0129
/// (<c>+=</c> not defined for <c>int32</c> and <c>?</c>) or GS9998 (cannot encode
/// signature for type <c>?</c>). The defect was a missing
/// <c>IndexExpressionSyntax</c> case in the user-type static accessor binding
/// path: the trailing <c>[...]</c> folded into the right-hand side of the
/// qualifier fell through to the error-producing <c>default</c>. Unqualified
/// access (<c>T[i]</c>) and qualified instance access (<c>recv.T[i]</c>) were
/// always correct. These tests compile and run real programs end-to-end,
/// asserting the correct runtime values read through the static-field indexer.
/// </summary>
public class Issue1291StaticFieldIndexEmitTests
{
    [Fact]
    public void QualifiedStaticArrayField_CompoundAssignFromIndex_ReadsElement()
    {
        var source = """
            package P
            import System

            class C {
                shared {
                    private let T []uint8 = []uint8{uint8(2), uint8(5)}
                    func F() int32 {
                        var c = 0
                        c += int32(C.T[0])
                        c += int32(C.T[1])
                        return c
                    }
                }
            }

            Console.WriteLine(C.F())
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void QualifiedStaticArrayField_DirectIndex_ReadsElement()
    {
        var source = """
            package P
            import System

            class C {
                shared {
                    private let T []uint8 = []uint8{uint8(9), uint8(3)}
                    func F() int32 {
                        let x = int32(C.T[1])
                        return x
                    }
                }
            }

            Console.WriteLine(C.F())
            """;

        Assert.Equal("3\n", CompileAndRun(source));
    }

    [Fact]
    public void QualifiedStaticArrayField_IndexedFromTopLevelMethod_ReadsElement()
    {
        var source = """
            package P
            import System

            struct S {
                prop A uint8 { get; init; }
            }

            class C {
                shared {
                    let T []uint8 = []uint8{uint8(2), uint8(1)}
                }
            }

            func (s S) F() int32 {
                let x = int32(C.T[uint8(s.A)])
                return x
            }

            var s = S{A: uint8(1)}
            Console.WriteLine(s.F())
            """;

        Assert.Equal("1\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1291_").FullName;
        try
        {
            return CompileAndRunImpl(source, tempDir);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRunImpl(string source, string tempDir)
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

        using var proc = Process.Start(psi);
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

        return stdout.Replace("\r\n", "\n");
    }
}
