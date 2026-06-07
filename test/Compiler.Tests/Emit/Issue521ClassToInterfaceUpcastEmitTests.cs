// <copyright file="Issue521ClassToInterfaceUpcastEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #521: end-to-end emit + execute coverage for the general CLR
/// reference upcast — a concrete class is implicitly assignable to any
/// interface it implements (or any of its base classes). The binder fix
/// lives in <c>Conversion.Classify</c>; the emit side widens via a no-op
/// reference upcast (no <c>castclass</c>) since the runtime object already
/// satisfies the wider static type.
///
/// Each test compiles via <c>gsc</c>, ilverifies the produced PE, then
/// runs the assembly under <c>dotnet exec</c> and asserts on the captured
/// stdout. ilverify catches any spurious <c>castclass</c> / stack-type
/// mismatch we might have introduced.
/// </summary>
public class Issue521ClassToInterfaceUpcastEmitTests
{
    [Fact]
    public void GSharpClass_To_GSharpInterface_DispatchesImpl()
    {
        // User-defined class assigned to user-defined interface, then
        // method dispatched through the interface receiver — the runtime
        // type is HelloGreeter so the implementation runs.
        var source = """
            package P
            import System

            type IGreeter interface {
                func Greet(name string) string
            }

            type HelloGreeter class : IGreeter {
                func Greet(name string) string { return "Hello, " + name }
            }

            var g IGreeter = HelloGreeter{}
            Console.WriteLine(g.Greet("world"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Hello, world\n", output);
    }

    [Fact]
    public void GSharpClass_To_GSharpInterface_AsArgument_DispatchesImpl()
    {
        // Passing a concrete class where an interface parameter is
        // expected exercises the conversion at the call site rather than
        // at an assignment.
        var source = """
            package P
            import System

            type IGreeter interface {
                func Greet(name string) string
            }

            type HelloGreeter class : IGreeter {
                func Greet(name string) string { return "Hi, " + name }
            }

            func Run(g IGreeter, name string) {
                Console.WriteLine(g.Greet(name))
            }

            Run(HelloGreeter{}, "ada")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Hi, ada\n", output);
    }

    [Fact]
    public void GSharpClass_To_GSharpInterface_AsReturnType_DispatchesImpl()
    {
        // Returning a concrete class where the function declares an
        // interface return type — the return-value upcast lowers to the
        // same no-op widening as the assignment / argument shapes.
        var source = """
            package P
            import System

            type IGreeter interface {
                func Greet(name string) string
            }

            type HelloGreeter class : IGreeter {
                func Greet(name string) string { return "Hey, " + name }
            }

            func Make() IGreeter {
                return HelloGreeter{}
            }

            Console.WriteLine(Make().Greet("bob"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Hey, bob\n", output);
    }

    [Fact]
    public void GSharpClass_To_GSharpInterface_ExplicitCast_DispatchesImpl()
    {
        // Explicit-cast form `IGreeter(HelloGreeter{})` reaches
        // `BindConversion` with `allowExplicit: true` but the underlying
        // classification is the same implicit upcast — verify the cast
        // form emits the same widening.
        var source = """
            package P
            import System

            type IGreeter interface {
                func Greet(name string) string
            }

            type HelloGreeter class : IGreeter {
                func Greet(name string) string { return "Yo, " + name }
            }

            var g = IGreeter(HelloGreeter{})
            Console.WriteLine(g.Greet("sam"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Yo, sam\n", output);
    }

    [Fact]
    public void ClrList_To_IReadOnlyList_Indexer_ReturnsExpectedElement()
    {
        // The repro from the issue body: `List<string>` to
        // `IReadOnlyList<string>` was rejected with GS0155. With the fix
        // the assignment binds, the upcast emits as a no-op, and the
        // indexer call dispatches through the interface to the same
        // backing List.
        var source = """
            package P
            import System
            import System.Collections.Generic

            var mut = List[string]()
            mut.Add("first")
            mut.Add("second")
            var r IReadOnlyList[string] = mut
            Console.WriteLine(r[1])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("second\n", output);
    }

    [Fact]
    public void ClrList_To_IEnumerable_IterationViaForRange_VisitsEveryElement()
    {
        // Generic variance is *not* required here — `List<int32>` simply
        // implements `IEnumerable<int32>`. Asserting that `for x := range
        // iface` walks the upcast value end-to-end pins the no-op widening
        // through the iterator lowering path too.
        var source = """
            package P
            import System
            import System.Collections.Generic

            var mut = List[int32]()
            mut.Add(10)
            mut.Add(20)
            mut.Add(30)
            var e IEnumerable[int32] = mut
            for x := range e {
                Console.WriteLine(x)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n20\n30\n", output);
    }

    [Fact]
    public void ClrString_To_IComparable_Assignment_Roundtrips()
    {
        // BCL identity / reference-upcast for a plain string -> IComparable.
        // The CLR holds the same reference on the stack; the interface
        // method (CompareTo) dispatches to System.String's implementation.
        var source = """
            package P
            import System

            var s = "abc"
            var c IComparable = s
            Console.WriteLine(c.CompareTo("abc"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue521_").FullName;
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
            };
            args.Add(srcPath);

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
