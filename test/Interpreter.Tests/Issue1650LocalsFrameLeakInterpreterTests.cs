// <copyright file="Issue1650LocalsFrameLeakInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #1650 — the tree-walking evaluator used to leave a callee's locals
/// frame on <c>Evaluator.locals</c> when the callee threw and a caller-level
/// try/catch handled the exception (every call path pushed the frame without
/// a try/finally guard). The dangling frame then shadowed the caller's real
/// frame for every subsequent local-variable read/write, corrupting
/// evaluator state for the rest of the run. These tests exercise every call
/// path that pushes a locals frame — plain call, property getter/setter,
/// instance call, closure/indirect call, and nested calls — to confirm the
/// frame is always popped, even on exception unwind.
/// </summary>
public class Issue1650LocalsFrameLeakInterpreterTests
{
    [Fact]
    public void PlainCall_CaughtException_CallerLocalStillResolves()
    {
        // Exact repro from issue #1650.
        var source = """
            func boom() {
                throw Exception("boom")
            }
            func run() string {
                let name = "orig"
                try {
                    boom()
                } catch (e Exception) {
                }
                return name
            }
            Console.WriteLine(run())
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("orig", output);
    }

    [Fact]
    public void NoThrow_PlainCall_StillWorks()
    {
        // Normal (no-exception) path must behave identically to before.
        var source = """
            func helper(x int32) int32 {
                return x + 1
            }
            func run() int32 {
                let a = 10
                let b = helper(a)
                return a + b
            }
            Console.WriteLine(run())
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("21", output);
    }

    [Fact]
    public void PropertyGetter_CaughtException_CallerLocalStillResolves()
    {
        var source = """
            class Boom {
                prop Value int32 {
                    get {
                        throw Exception("getter-boom")
                    }
                }
            }
            func run() string {
                let name = "orig"
                let b = Boom{}
                try {
                    var x = b.Value
                } catch (e Exception) {
                }
                return name
            }
            Console.WriteLine(run())
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("orig", output);
    }

    [Fact]
    public void PropertySetter_CaughtException_CallerLocalStillResolves()
    {
        var source = """
            class Boom {
                prop raw int32
                prop Value int32 {
                    get {
                        return this.raw
                    }
                    set(v) {
                        throw Exception("setter-boom")
                    }
                }
            }
            func run() string {
                let name = "orig"
                let b = Boom{}
                try {
                    b.Value = 5
                } catch (e Exception) {
                }
                return name
            }
            Console.WriteLine(run())
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("orig", output);
    }

    [Fact]
    public void InstanceCall_CaughtException_CallerLocalStillResolves()
    {
        var source = """
            class Boom {
                func Detonate() {
                    throw Exception("instance-boom")
                }
            }
            func run() string {
                let name = "orig"
                let b = Boom{}
                try {
                    b.Detonate()
                } catch (e Exception) {
                }
                return name
            }
            Console.WriteLine(run())
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("orig", output);
    }

    [Fact]
    public void ClosureCall_CaughtException_CallerLocalStillResolves()
    {
        var source = """
            func run() string {
                let name = "orig"
                let boom = func() {
                    throw Exception("closure-boom")
                }
                try {
                    boom()
                } catch (e Exception) {
                }
                return name
            }
            Console.WriteLine(run())
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("orig", output);
    }

    [Fact]
    public void NestedCalls_ThrowCaughtTwoFramesUp_StackDepthRestored()
    {
        // The inner-most call throws; the exception is caught two call
        // frames up. Once caught, both the inner and middle frames must be
        // gone — a leaked frame at either depth would shadow the caller's
        // "name" local with a dead frame's dictionary, and any read through
        // it would either return a stale/wrong value or throw the
        // 'key was not present' error the bug report describes.
        var source = """
            func innermost() {
                throw Exception("nested-boom")
            }
            func middle() {
                innermost()
            }
            func run() string {
                let name = "orig"
                try {
                    middle()
                } catch (e Exception) {
                }
                let after = "after"
                return name + "-" + after
            }
            Console.WriteLine(run())
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("orig-after", output);
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString();
    }
}
