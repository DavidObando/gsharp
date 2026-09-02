// <copyright file="Issue2924TupleElementDelegateCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2924: numeric tuple-element values must survive parsing and invoke
/// through the same delegate/function paths as ItemN element access.
/// </summary>
public class Issue2924TupleElementDelegateCallTests
{
    [Fact]
    public void TupleElementCallShapes_EmitVerifyLoadAndRun()
    {
        const string Source = """
            package Issue2924Runtime
            import System

            data struct Holder(Value (System.Action[int32], int32))

            class Factory {
                func Make() (int32) -> int32 {
                    return (value int32) -> value + 2
                }
            }

            func MakeTuple(handler System.Action[int32]) (System.Action[int32], int32) {
                return (handler, 0)
            }

            func Call(handler System.Action[int32], value int32) {
                handler(value)
            }

            let handler System.Action[int32] = (value int32) -> Console.WriteLine("call:{0}", value)
            let t = (handler, 0)
            let copied System.Action[int32] = t.0
            copied(1)
            t.0(2)
            Call(t.0, 9)

            let higher = (0, handler)
            higher.1(3)

            let increment (int32) -> int32 = (value int32) -> value + 1
            let functions = (increment, 0)
            let answer = functions.0(41)
            Console.WriteLine(answer)

            let nested = ((0, increment), 0)
            Console.WriteLine(nested.0.1(40))

            let wide = (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
            Console.WriteLine(wide.10)

            MakeTuple(handler).0(4)
            let holder = Holder((handler, 0))
            holder.Value.0(5)
            t.0.Invoke(6)

            t.Item1(7)
            let itemName System.Action[int32] = t.Item1
            itemName(8)

            let factory = Factory()
            Console.WriteLine(factory.Make()(40))
            Console.WriteLine(.5 + .25)
            """;

        var output = CompileVerifyLoadAndRun(Source);

        Assert.Equal(
            $"call:1{Environment.NewLine}call:2{Environment.NewLine}call:9{Environment.NewLine}call:3{Environment.NewLine}42{Environment.NewLine}41{Environment.NewLine}10{Environment.NewLine}call:4{Environment.NewLine}call:5{Environment.NewLine}call:6{Environment.NewLine}call:7{Environment.NewLine}call:8{Environment.NewLine}42{Environment.NewLine}0.75{Environment.NewLine}",
            output);
    }

    [Fact]
    public void ExistingItemNameIndirectCallAndFloatSyntax_RemainSupported()
    {
        const string Source = """
            package Issue2924Guards
            import System

            let handler System.Action[int32] = (value int32) -> Console.WriteLine("call:{0}", value)
            let t = (handler, 0)
            t.Item1(1)

            let increment (int32) -> int32 = (value int32) -> value + 1
            Console.WriteLine((increment)(41))
            Console.WriteLine(.5 + .25)
            """;

        var output = CompileVerifyLoadAndRun(Source);

        Assert.Equal($"call:1{Environment.NewLine}42{Environment.NewLine}0.75{Environment.NewLine}", output);
    }

    [Fact]
    public void NullConditionalLiftedCalls_ShortCircuitAndInvoke()
    {
        const string Source = """
            package Issue2924NullConditional
            import System

            delegate Mapper(value int32) int32;

            class Guard {
                func Plain(value int32) {
                    Console.WriteLine("plain:{0}", value)
                }

                func Make(seed int32) (int32) -> int32 {
                    return (value int32) -> seed + value
                }

                func MakeNamed(seed int32) Mapper {
                    return (value int32) -> seed + value
                }

                func Get() (System.Action[int32], int32) {
                    let handler System.Action[int32] = (value int32) -> Console.WriteLine("tuple:{0}", value)
                    return (handler, 0)
                }

                func Arr() []int32 {
                    return []int32{41}
                }
            }

            var receiverEvaluations int32

            func Next(value Guard) Guard {
                receiverEvaluations += 1
                return value
            }

            let live = Guard()
            Console.WriteLine(live?.Make(40)(2))
            Console.WriteLine(live?.MakeNamed(40)(2))
            Console.WriteLine(live?.Make(40)!!(2))
            Console.WriteLine(live?.Make(40)!!!!(2))
            Console.WriteLine(Next(live)?.Make(40)(2))
            Console.WriteLine(receiverEvaluations)

            let g Guard = nil
            g?.Plain(1)
            Console.WriteLine("A ok")
            g?.Make(40)(2)
            Console.WriteLine("B ok")
            g?.MakeNamed(40)(2)
            Console.WriteLine("B named ok")
            g?.Make(40)!!(2)
            Console.WriteLine("B asserted ok")
            g?.Make(40)!!!!(2)
            Console.WriteLine("B repeated assertion ok")
            g?.Get().0(1)
            Console.WriteLine("C ok")
            Next(g)?.Get().0(1)
            Console.WriteLine(receiverEvaluations)

            let t (System.Action[int32], int32)? = nil
            t?.0(1)
            Console.WriteLine("D ok")

            let ignored = g?.Arr()[0]
            Console.WriteLine("E ok")
            """;

        var output = CompileVerifyLoadAndRun(Source);

        Assert.Equal($"42{Environment.NewLine}42{Environment.NewLine}42{Environment.NewLine}42{Environment.NewLine}42{Environment.NewLine}1{Environment.NewLine}A ok{Environment.NewLine}B ok{Environment.NewLine}B named ok{Environment.NewLine}B asserted ok{Environment.NewLine}B repeated assertion ok{Environment.NewLine}C ok{Environment.NewLine}2{Environment.NewLine}D ok{Environment.NewLine}E ok{Environment.NewLine}", output);
    }

    [Fact]
    public void NumericSelectorAssignments_WriteTupleElement()
    {
        const string Source = """
            package Issue2924Assignments
            import System

            var assigned = (1, 2)
            assigned.0 = 5
            Console.WriteLine(assigned.0)

            var compounded = (1, 2)
            compounded.0 += 6
            Console.WriteLine(compounded.0)
            """;

        var output = CompileVerifyLoadAndRun(Source);

        Assert.Equal($"5{Environment.NewLine}7{Environment.NewLine}", output);
    }

    [Fact]
    public void NonCallableTupleElement_ReportsNotAFunction()
    {
        var result = Compile("""
            package Issue2924NotCallable
            let t = (41, 0)
            t.0(1)
            """);

        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains("GS0131", result.Diagnostics);
    }

    [Fact]
    public void OutOfRangeNumericSelector_ReportsMissingMember()
    {
        var result = Compile("""
            package Issue2924OutOfRange
            let t = (41, 0)
            let value = t.2
            """);

        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains("GS0158", result.Diagnostics);
    }

    [Fact]
    public void NilTupleElementDelegate_ThrowsWhenInvoked()
    {
        const string Source = """
            package Issue2924Nil
            import System

            let handler System.Action[int32] = default(System.Action[int32])
            let t = (handler, 0)
            t.0(1)
            """;

        var assembly = CompileAndLoad(Source, out var outputPath);
        try
        {
            var entry = GetEntryPoint(assembly);
            var exception = Assert.Throws<TargetInvocationException>(() => InvokeEntryPoint(entry));
            Assert.IsType<NullReferenceException>(exception.InnerException);
        }
        finally
        {
            DeleteOutputDirectory(outputPath);
        }
    }

    private static string CompileVerifyLoadAndRun(string source)
    {
        var assembly = CompileAndLoad(source, out var outputPath);
        try
        {
            var entry = GetEntryPoint(assembly);
            var previousOut = Console.Out;
            using var output = new StringWriter();
            Console.SetOut(output);
            try
            {
                InvokeEntryPoint(entry);
            }
            finally
            {
                Console.SetOut(previousOut);
            }

            return output.ToString().ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            DeleteOutputDirectory(outputPath);
        }
    }

    private static Assembly CompileAndLoad(string source, out string outputPath)
    {
        var outputDirectory = Directory.CreateTempSubdirectory("gsharp_issue2924_").FullName;
        var sourcePath = Path.Combine(outputDirectory, "Program.gs");
        outputPath = Path.Combine(outputDirectory, $"Issue2924_{Guid.NewGuid():N}.dll");
        File.WriteAllText(sourcePath, source);

        using var standardOut = new StringWriter();
        using var standardError = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(standardOut);
        Console.SetError(standardError);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(
            exitCode == 0,
            $"gsc failed:\nstdout:\n{standardOut}\nstderr:\n{standardError}");
        IlVerifier.Verify(outputPath);
        var assembly = EmittedFixture.Load(outputPath);
        _ = assembly.GetTypes();
        return assembly;
    }

    private static MethodInfo GetEntryPoint(Assembly assembly)
    {
        var programType = assembly.GetTypes().Single(type => type.Name == "<Program>");
        return Assert.IsAssignableFrom<MethodInfo>(programType.GetMethod(
            "<Main>$",
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic));
    }

    private static void InvokeEntryPoint(MethodInfo entryPoint)
    {
        entryPoint.Invoke(
            null,
            entryPoint.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
    }

    private static (int ExitCode, string Diagnostics) Compile(string source)
    {
        var outputDirectory = Directory.CreateTempSubdirectory("gsharp_issue2924_diag_").FullName;
        try
        {
            var sourcePath = Path.Combine(outputDirectory, "Program.gs");
            var outputPath = Path.Combine(outputDirectory, "Program.dll");
            File.WriteAllText(sourcePath, source);

            using var standardOut = new StringWriter();
            using var standardError = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(standardOut);
            Console.SetError(standardError);
            try
            {
                var exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
                return (exitCode, standardOut.ToString() + standardError.ToString());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }
        }
        finally
        {
            try
            {
                Directory.Delete(outputDirectory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static void DeleteOutputDirectory(string outputPath)
    {
        try
        {
            Directory.Delete(Path.GetDirectoryName(outputPath)!, recursive: true);
        }
        catch
        {
        }
    }
}
