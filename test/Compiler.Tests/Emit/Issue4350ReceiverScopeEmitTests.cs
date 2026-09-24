// <copyright file="Issue4350ReceiverScopeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0187 / issue #4350: runtime coverage for the binder gaps the
/// <c>Gsharp.Runtime.Values</c> self-migration exposed — ref forwarding
/// through a struct field receiver (C#'s scoped-<c>this</c> rule), generic
/// operators declared on a nullable receiver, and construction syntax that
/// shares its name with an extension function. Each program is compiled,
/// IL-verified, and executed.
/// </summary>
public class Issue4350ReceiverScopeEmitTests
{
    [Fact]
    public void RefForwardThroughStructFieldReceiver_AliasesBackingStorage()
    {
        var source = """
            package P
            import System

            struct Inner {
                var items []int32
                init(items []int32) { this.items = items }
                prop this[i int32] ref int32 {
                    get { return ref items[i] }
                }
            }

            struct View {
                let inner Inner
                init(inner Inner) { this.inner = inner }
                prop this[i int32] ref readonly int32 -> inner[i]
                func At(i int32) ref int32 { return ref inner[i] }
            }

            let items = []int32{1, 2, 3}
            let view = View(Inner(items))
            Console.WriteLine(view[1])
            view.At(2) = 9
            Console.WriteLine(items[2])
            items[1] = 5
            Console.WriteLine(view[1])
            """;

        Assert.Equal(Lines("2", "9", "5"), CompileAndRun(source));
    }

    [Fact]
    public void NullableReceiverGenericOperators_EmitOnTheOwnerAndRun()
    {
        var source = """
            package P
            import System

            open class Box[T] {
                var V T
                init(v T) { V = v }
            }

            func (left Box[T]?) operator ==(right Box[T]?) bool -> object.ReferenceEquals(left, right) || (left != nil && right != nil && object.Equals(left.V, right.V))
            func (left Box[T]?) operator !=(right Box[T]?) bool -> !(left == right)

            let a = Box[string]("x")
            let b = Box[string]("x")
            let c Box[string]? = nil
            Console.WriteLine(a == b)
            Console.WriteLine(a != c)
            Console.WriteLine(typeof(Box[string]).GetMethod("op_Equality") != nil)
            """;

        Assert.Equal(Lines("True", "True", "True"), CompileAndRun(source));
    }

    [Fact]
    public void ConstructionSyntax_PrefersTypeOverSameNamedExtension()
    {
        var source = """
            package P
            import System

            struct Window[T] {
                let Owner []T
                let Lo int32
                let Hi int32
                init(owner []T, lo int32, hi int32, max int32) {
                    Owner = owner
                    Lo = lo
                    Hi = if hi < max { hi } else { max }
                }
                func Shift(n int32) Window[T] -> Window[T](Owner, Lo + n, Hi + n, Owner.Length)
            }

            func (w Window[T]) Window[T](lo int32, hi int32, max int32) Window[T] -> w.Shift(lo)

            let w = Window[int32]([]int32{1, 2, 3, 4}, 0, 2, 4)
            Console.WriteLine(w.Shift(1).Lo)
            Console.WriteLine(w.Window(2, 0, 0).Lo)
            """;

        Assert.Equal(Lines("1", "2"), CompileAndRun(source));
    }

    private static string Lines(params string[] lines)
        => string.Concat(Array.ConvertAll(lines, line => line + Environment.NewLine));

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue4350_receiver_").FullName;
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
