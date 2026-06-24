// <copyright file="Issue1070FieldInitializerStaticEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1070 end-to-end coverage. A static member of a type (a <c>const</c>,
/// or a <c>shared</c> field) must be visible from a field-initializer expression
/// in the same type. These tests round-trip the scenario through compile →
/// IL-verify → run so we confirm both that binding succeeds (no GS0125 / GS0159)
/// and that the emitted code loads the static member correctly at runtime:
/// <list type="bullet">
/// <item>an instance field initializer that sizes an array from a class
/// <c>const</c> (the const is inlined as the array length);</item>
/// <item>a <c>shared</c> field initializer that references an earlier
/// <c>shared</c> field (a <c>ldsfld</c> of the sibling static field).</item>
/// </list>
/// </summary>
public class Issue1070FieldInitializerStaticEmitTests
{
    [Fact]
    public void InstanceFieldInit_FromConst_And_SharedFieldInit_FromSharedField_Roundtrips()
    {
        var source = """
            package P
            import System

            class Buffer {
                const BlockSize int32 = 16
                public let data []uint8 = System.GC.AllocateArray[uint8](BlockSize)
            }

            class Stats {
                shared {
                    let Rates []int32 = []int32{10, 20, 30}
                    let First int32 = Rates[0]
                    let Total int32 = Rates[0] + Rates[1] + Rates[2]

                    public func Combined() int32 {
                        return First + Total
                    }
                }
            }

            let b = Buffer()
            Console.WriteLine(b.data.Length)
            Console.WriteLine(Stats.Combined())
            """;

        var output = CompileAndRun(source);

        // 16 = const BlockSize used as the instance array length.
        // 70 = First(10) + Total(10+20+30=60); First and Total are shared
        // field initializers that read the sibling shared `Rates` field.
        Assert.Equal("16\n70\n", output);
    }

    [Fact]
    public void InstanceFieldInit_FromConst_OrderIndependent_Roundtrips()
    {
        // The const is declared AFTER the field initializer that uses it.
        var source = """
            package P
            import System

            class Buffer {
                public let data []uint8 = System.GC.AllocateArray[uint8](BlockSize)
                const BlockSize int32 = 24
            }

            let b = Buffer()
            Console.WriteLine(b.data.Length)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("24\n", output);
    }

    [Fact]
    public void ConstBearingType_FollowedBySharedFields_HasCorrectFieldRows()
    {
        // Regression for the FieldDef-row planner: a `const` field is emitted as a
        // CLR literal field row, so it must be counted when reserving FieldDef
        // rows. Previously the planner omitted const fields, which shifted every
        // following type's fieldList pointer and leaked the last `shared` field of
        // the following type onto the synthesized <Program> type — producing
        // invalid IL (a `.cctor` storing another type's initonly field). IL-verify
        // would catch the regression; the runtime values confirm correct binding.
        var source = """
            package P
            import System

            class Limits {
                const Cap int32 = 8
            }

            class Stats {
                shared {
                    let A int32 = 1
                    let B int32 = 2
                    let C int32 = 3
                }
            }

            Console.WriteLine(Stats.A + Stats.B + Stats.C)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("6\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1070_emit_").FullName;
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

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
