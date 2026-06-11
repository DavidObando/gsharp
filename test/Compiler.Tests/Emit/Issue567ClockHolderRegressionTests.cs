// <copyright file="Issue567ClockHolderRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Regression coverage for issue #567: capturing a reference-type local in a
/// closure inside a class method, then reading or writing a field on that
/// local, must compile correctly and emit valid IL. The underlying bug was a
/// stale <c>program.Functions[lambdaSymbol]</c> entry after the outer
/// function's body was rewritten by <c>CaptureBoxingRewriter</c>, combined
/// with a missing <c>BoundFieldAssignmentExpression</c> rewrite for boxed
/// receivers. Each test compiles end-to-end, verifies with <c>ilverify</c>,
/// and asserts on runtime stdout.
/// </summary>
public class Issue567ClockHolderRegressionTests
{
    /// <summary>
    /// The exact repro from issue #567: capture a reference-type local in a
    /// class method, set a field on it, then read that field from a closure.
    /// </summary>
    [Fact]
    public void ClockHolder_FieldRead_FromClosureInClassMethod()
    {
        var source = """
            package Probe
            import System

            type ClockHolder class {
                var Value int32
                init() {}
            }

            type GS9998_Probe class {
                init() {}
                func Run() int32 {
                    var clock = ClockHolder()
                    clock.Value = 42
                    var getter = func() int32 { return clock.Value }
                    let v = getter()
                    return v
                }
            }

            var p = GS9998_Probe()
            Console.WriteLine(p.Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    /// <summary>
    /// Closure mutates a field on the captured reference-type local; the
    /// outer scope observes the mutation.
    /// </summary>
    [Fact]
    public void ClockHolder_FieldWrite_FromClosureInClassMethod()
    {
        var source = """
            package Probe
            import System

            type ClockHolder class {
                var Value int32
                init() {}
            }

            type Probe2 class {
                init() {}
                func Run() int32 {
                    var clock = ClockHolder()
                    clock.Value = 10
                    var setter = func(x int32) { clock.Value = x }
                    setter(99)
                    return clock.Value
                }
            }

            var p = Probe2()
            Console.WriteLine(p.Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    /// <summary>
    /// Closure adds to a captured list; outer scope observes the addition.
    /// </summary>
    [Fact]
    public void ListMutation_FromClosureInClassMethod()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            type ListProbe class {
                init() {}
                func Run() int32 {
                    var items = List[int32]()
                    var adder = func(x int32) { items.Add(x) }
                    adder(1)
                    adder(2)
                    adder(3)
                    return items.Count
                }
            }

            var p = ListProbe()
            Console.WriteLine(p.Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    /// <summary>
    /// Closure adds to a captured dictionary; outer scope reads the count.
    /// </summary>
    [Fact]
    public void DictionaryMutation_FromClosureInClassMethod()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            type DictProbe class {
                init() {}
                func Run() int32 {
                    var d = Dictionary[string, int32]()
                    var put = func(k string, v int32) { d.Add(k, v) }
                    put("a", 1)
                    put("b", 2)
                    return d.Count
                }
            }

            var p = DictProbe()
            Console.WriteLine(p.Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    /// <summary>
    /// Two lambdas in the same scope both capture the same reference-type
    /// local and observe each other's field writes through the shared box.
    /// </summary>
    [Fact]
    public void MultipleClosures_ShareCapturedReferenceLocal()
    {
        var source = """
            package Probe
            import System

            type Counter class {
                var N int32
                init() {}
            }

            type MultiProbe class {
                init() {}
                func Run() int32 {
                    var c = Counter()
                    var inc = func() { c.N = c.N + 1 }
                    var read = func() int32 { return c.N }
                    inc()
                    inc()
                    inc()
                    return read()
                }
            }

            var p = MultiProbe()
            Console.WriteLine(p.Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    /// <summary>
    /// Nested closure: outer lambda captures a reference-type local; inner
    /// lambda (declared inside outer's body) also reads a field on it.
    /// </summary>
    [Fact]
    public void NestedClosure_CapturesCapturedReferenceLocal()
    {
        var source = """
            package Probe
            import System

            type Holder class {
                var Val int32
                init() {}
            }

            type NestProbe class {
                init() {}
                func Run() int32 {
                    var h = Holder()
                    h.Val = 7
                    var outer = func() func() int32 {
                        var inner = func() int32 { return h.Val }
                        return inner
                    }
                    var f = outer()
                    return f()
                }
            }

            var p = NestProbe()
            Console.WriteLine(p.Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    /// <summary>
    /// Top-level function variant: closure captures a reference-type local
    /// in a package-level function (not inside a class), confirming the fix
    /// doesn't regress the simpler non-class-method path.
    /// </summary>
    [Fact]
    public void ClosureInsideClassMethod_OnStatic()
    {
        var source = """
            package Probe
            import System

            type Box class {
                var X int32
                init() {}
            }

            func Go() int32 {
                var b = Box()
                b.X = 55
                var read = func() int32 { return b.X }
                return read()
            }

            Console.WriteLine(Go())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("55\n", output);
    }

    /// <summary>
    /// Oahu-inspired shape: a class with a mutable state field, a method
    /// that captures it in a closure and mutates through the closure, then
    /// observes the mutation from the outer scope.
    /// </summary>
    [Fact]
    public void OahuRepro_CtrlCStateShape()
    {
        var source = """
            package Probe
            import System

            type State class {
                var Running bool
                init() {}
            }

            type Controller class {
                init() {}
                func Execute() string {
                    var state = State()
                    state.Running = true
                    var stop = func() { state.Running = false }
                    stop()
                    if state.Running {
                        return "still running"
                    }
                    return "stopped"
                }
            }

            var c = Controller()
            Console.WriteLine(c.Execute())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("stopped\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_567_").FullName;
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
