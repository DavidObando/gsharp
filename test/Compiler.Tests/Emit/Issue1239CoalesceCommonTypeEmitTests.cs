// <copyright file="Issue1239CoalesceCommonTypeEmitTests.cs" company="GSharp">
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
/// Issue #1239: the null-coalescing operator <c>a ?? b</c> must compute the
/// C# §12.15 best common type rather than requiring both operands to share an
/// exact type. When the right operand implicitly converts to the left's
/// non-null type the result is that type; otherwise, when the left's non-null
/// type implicitly converts to the right operand's type (a reference upcast /
/// interface implementation or a numeric widening), the result is the right
/// type. Both branches are emitted with the conversions required so the
/// produced value matches the operator's result type.
///
/// Each test compiles via <c>gsc</c>, IL-verifies the produced PE, then executes
/// it under <c>dotnet exec</c> and asserts on captured stdout.
/// </summary>
public class Issue1239CoalesceCommonTypeEmitTests
{
    [Fact]
    public void RightImplementsInterface_ResultIsInterface()
    {
        var source = """
            package P

            import System

            interface IFoo { func Bar() int32; }
            class Foo : IFoo { func Bar() int32 { return 1 } }
            class Baz : IFoo { func Bar() int32 { return 2 } }

            func Pick(f Foo?, g IFoo) IFoo {
                return f ?? g
            }

            let present Foo = Foo()
            let g IFoo = Baz()
            Console.WriteLine(Pick(present, g).Bar().ToString())
            Console.WriteLine(Pick(nil, g).Bar().ToString())
            """;

        var output = CompileAndRun(source);

        // Non-null left -> Foo.Bar() == 1; nil left -> Baz.Bar() == 2.
        Assert.Equal("1\n2\n", output);
    }

    [Fact]
    public void RightSubtypeAndDelegateFactory_ConvertToNullableLeftTypes()
    {
        var source = """
            package P

            import System

            interface ILogger { func Name() string; }
            class RealLogger : ILogger { func Name() string { return "real" } }
            class NullLogger : ILogger { func Name() string { return "null" } }

            func PickLogger(logger ILogger?) ILogger {
                return logger ?? NullLogger()
            }

            func PickFactory(factory (() -> ILogger)?) () -> ILogger {
                return factory ?? (() -> NullLogger())
            }

            var realFactory (() -> ILogger) = () -> RealLogger()
            Console.WriteLine(PickLogger(RealLogger()).Name())
            Console.WriteLine(PickLogger(nil).Name())
            Console.WriteLine(PickFactory(realFactory)().Name())
            Console.WriteLine(PickFactory(nil)().Name())
            """;

        var output = CompileAndRun(source);

        Assert.Equal("real\nnull\nreal\nnull\n", output);
    }

    [Fact]
    public void RightIsBaseClass_ResultIsBaseClass()
    {
        var source = """
            package P

            import System

            open class Animal { open func Speak() int32 { return 10 } }
            class Dog : Animal { override func Speak() int32 { return 20 } }

            func Pick(d Dog?, a Animal) Animal {
                return d ?? a
            }

            let dog Dog = Dog()
            let baseAnimal Animal = Animal()
            Console.WriteLine(Pick(dog, baseAnimal).Speak().ToString())
            Console.WriteLine(Pick(nil, baseAnimal).Speak().ToString())
            """;

        var output = CompileAndRun(source);

        // Non-null left -> Dog.Speak() == 20; nil left -> Animal.Speak() == 10.
        Assert.Equal("20\n10\n", output);
    }

    [Fact]
    public void NumericWidening_RightWidensToLeftUnderlying_ResultIsLeftType()
    {
        var source = """
            package P

            import System

            func Coalesce(a int32?, b uint16) int32 {
                return a ?? b
            }

            let seven uint16 = 7
            Console.WriteLine(Coalesce(100, seven).ToString())
            Console.WriteLine(Coalesce(nil, seven).ToString())
            """;

        var output = CompileAndRun(source);

        // Non-null left -> 100 (int32); nil left -> 7 widened from uint16.
        Assert.Equal("100\n7\n", output);
    }

    [Fact]
    public void NumericWidening_LeftWidensToRight_ResultIsRightType()
    {
        var source = """
            package P

            import System

            func Coalesce(a int32?, b int64) int64 {
                return a ?? b
            }

            let big int64 = 9000000000
            Console.WriteLine(Coalesce(100, big).ToString())
            Console.WriteLine(Coalesce(nil, big).ToString())
            """;

        var output = CompileAndRun(source);

        // Non-null left -> 100 widened to int64; nil left -> 9000000000.
        Assert.Equal("100\n9000000000\n", output);
    }

    [Fact]
    public void ExplicitTargetType_BindsThroughInterface()
    {
        var source = """
            package P

            import System

            interface IFoo { func Bar() int32; }
            class Foo : IFoo { func Bar() int32 { return 42 } }
            class Baz : IFoo { func Bar() int32 { return 7 } }

            func WithTarget(f Foo?, g IFoo) int32 {
                let r IFoo = f ?? g
                return r.Bar()
            }

            Console.WriteLine(WithTarget(Foo(), Baz()).ToString())
            Console.WriteLine(WithTarget(nil, Baz()).ToString())
            """;

        var output = CompileAndRun(source);

        Assert.Equal("42\n7\n", output);
    }

    [Fact]
    public void SameType_StillWorks()
    {
        var source = """
            package P

            import System

            class Foo { func Bar() int32 { return 5 } }

            func Same(f Foo?, g Foo) Foo {
                return f ?? g
            }

            Console.WriteLine(Same(Foo(), Foo()).Bar().ToString())
            Console.WriteLine(Same(nil, Foo()).Bar().ToString())
            """;

        var output = CompileAndRun(source);

        Assert.Equal("5\n5\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1239_").FullName;
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
                "/nowarn:GS9100",
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

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
            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
