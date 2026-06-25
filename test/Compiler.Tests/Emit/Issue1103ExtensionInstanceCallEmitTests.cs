// <copyright file="Issue1103ExtensionInstanceCallEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1103: a receiver-clause extension function (ADR-0019) whose receiver
/// type is an imported/BCL or primitive CLR type must be invokable with
/// instance/member syntax (<c>receiver.Ext(args)</c>), not only as a free
/// function (<c>Ext(receiver, args)</c>).
/// <para>
/// The defect had two causes. (1) Extension functions are flattened into
/// <c>BoundGlobalScope.Functions</c> so free-call syntax resolves them, but the
/// follow-up body-binding pass rebuilt its lookup scope without re-registering
/// them as extensions, so <c>BoundScope.TryLookupExtensionFunction</c> found
/// nothing inside function/method bodies. (2) Even when present, the receiver
/// match used reference equality on the receiver type symbol, which fails for
/// imported CLR types because the declaration-site and call-site symbols are
/// distinct <c>ImportedTypeSymbol</c> instances wrapping the same CLR type. Both
/// made member-syntax calls report <c>GS0159 Cannot find function</c> while the
/// equivalent free-call form bound fine.
/// </para>
/// These tests prove that instance-syntax extension calls on a BCL type
/// (<c>System.Text.StringBuilder</c>) and on a primitive (<c>int32</c>) compile,
/// IL-verify, and produce the correct runtime results from inside class methods,
/// free functions, and top-level statements.
/// </summary>
public class Issue1103ExtensionInstanceCallEmitTests
{
    [Fact]
    public void Int32Extension_InstanceSyntax_InsideClassMethod()
    {
        var source = """
            package P
            import System

            func (n int32) Doubled() int32 {
                return n * 2
            }

            class Calc {
                func Run(x int32) int32 {
                    return x.Doubled()
                }
            }

            let c = Calc()
            Console.WriteLine(c.Run(21))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void BclExtension_InstanceSyntax_InsideFreeFunction()
    {
        // StringBuilder is an imported BCL type: the declaration-site and
        // call-site receiver symbols are distinct ImportedTypeSymbol instances,
        // so the receiver match must be structural (CLR-type identity).
        var source = """
            package P
            import System
            import System.Text

            func (sb StringBuilder) AppendBang() StringBuilder {
                return sb.Append("!")
            }

            func buildShout(word string) string {
                let sb = StringBuilder()
                sb.Append(word)
                sb.AppendBang()
                sb.AppendBang()
                return sb.ToString()
            }

            Console.WriteLine(buildShout("hi"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi!!\n", output);
    }

    [Fact]
    public void Int32Extension_InstanceSyntax_AtTopLevel()
    {
        var source = """
            package P
            import System

            func (n int32) Tripled() int32 {
                return n * 3
            }

            let x int32 = 14
            Console.WriteLine(x.Tripled())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Extension_FreeCallForm_Control_StillCompiles()
    {
        // Control: the same extension invoked as a free function must keep
        // working (this path always bound; it must not regress).
        var source = """
            package P
            import System

            func (n int32) Doubled() int32 {
                return n * 2
            }

            func compute(x int32) int32 {
                return Doubled(x)
            }

            Console.WriteLine(compute(21))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void BclAndPrimitiveExtensions_InstanceSyntax_InOneProgram()
    {
        // Instance-call forms of imported and primitive receiver extensions all
        // bind and run within the same compilation, from class-method bodies.
        var source = """
            package P
            import System
            import System.Text

            func (sb StringBuilder) AppendBang() StringBuilder {
                return sb.Append("!")
            }

            func (n int32) Doubled() int32 {
                return n * 2
            }

            class Worker {
                func Shout(word string) string {
                    let sb = StringBuilder()
                    sb.Append(word)
                    return sb.AppendBang().ToString()
                }

                func Twice(n int32) int32 {
                    return n.Doubled()
                }
            }

            let w = Worker()
            Console.WriteLine(w.Shout("go"))
            Console.WriteLine(w.Twice(50))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("go!\n100\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1103_emit_").FullName;
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
