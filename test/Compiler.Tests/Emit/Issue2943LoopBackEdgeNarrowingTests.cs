// <copyright file="Issue2943LoopBackEdgeNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Compiler;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2943: writes that can reach a loop back-edge must invalidate
/// narrowing inherited from outside that loop.
/// </summary>
public class Issue2943LoopBackEdgeNarrowingTests
{
    [Theory]
    [InlineData("initializer", "GS0159")]
    [InlineData("for-clause", "GS0159")]
    [InlineData("while", "GS0503")]
    [InlineData("infinite", "GS0159")]
    [InlineData("ellipsis", "GS0159")]
    [InlineData("range", "GS0159")]
    [InlineData("await-range", "GS0159")]
    [InlineData("do-while", "GS0159")]
    [InlineData("nested-loop", "GS0159")]
    [InlineData("nested-if", "GS0159")]
    [InlineData("continue", "GS0159")]
    [InlineData("labeled-continue", "GS0159")]
    [InlineData("post", "GS0159")]
    [InlineData("before-use", "GS0159")]
    [InlineData("member-call", "GS0159")]
    [InlineData("implicit-field", "GS0159")]
    public void AssignmentReachingBackEdge_InvalidatesInheritedNarrowing(
        string shape,
        string expectedDiagnostic)
    {
        var compilation = Compile(BuildRejectedSource(shape));
        var errors = compilation.BoundProgram.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();

        Assert.Contains(errors, diagnostic => diagnostic.Id == expectedDiagnostic);
    }

    [Theory]
    [InlineData("unchanged", "ok\nok\n")]
    [InlineData("condition-renarrow", "ok\n")]
    [InlineData("inner-renarrow", "ok\n")]
    [InlineData("assignment-renarrow", "ok\nok\n")]
    [InlineData("initializer-renarrow", "ok\n")]
    [InlineData("break-only", "ok\n")]
    [InlineData("literal-false-do-while", "ok\n")]
    [InlineData("literal-false-while", "")]
    [InlineData("shadowed-assignment", "ok\nok\n")]
    [InlineData("labeled-break", "ok\n")]
    [InlineData("post-condition-renarrow", "ok\n")]
    [InlineData("type-test-condition", "5\n")]
    [InlineData("other-instance-field", "ok\nok\n")]
    public void SafeNarrowing_RemainsAcceptedAndRuns(string shape, string expectedOutput)
    {
        Assert.Equal(expectedOutput, CompileAndRun(BuildAcceptedSource(shape), shape));
    }

    [Fact]
    public void SpeculativeRebind_RollsBackDiagnosticsAndLabelState()
    {
        const string Source = """
            class C {
                func M() { }
            }

            func Run() {
                var c C? = C()
                if c != nil {
                    for var i = 0; i < 2; i++ {
                        mutation: c = nil
                        c.M()
                    }
                }
            }
            """;

        var errors = Compile(Source).BoundProgram.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();

        var diagnostic = Assert.Single(errors);
        Assert.Equal("GS0159", diagnostic.Id);
    }

    [Fact]
    public void SpeculativeRebind_RestoresLoopStack()
    {
        const string Source = """
            class C {
                func M() { }
            }

            func Run() {
                var c C? = C()
                if c != nil {
                    for var i = 0; i < 2; i++ {
                        c.M()
                        c = nil
                    }
                }
                break
            }
            """;

        var errors = Compile(Source).BoundProgram.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();

        Assert.Contains(errors, diagnostic => diagnostic.Id == "GS0120");
    }

    [Fact]
    public void SpeculativeRebind_DoesNotDuplicateGotoHandlerDiagnostics()
    {
        const string Source = """
            import System

            class C {
                func M() { }
            }

            func Run() {
                goto handler
                var c C? = C()
                if c != nil {
                    for var i = 0; i < 2; i++ {
                        c.M()
                        c = nil
                    }
                }
                try {
                    throw Exception("boom")
                } catch (ex Exception) {
                    handler:
                    {
                    }
                }
            }
            """;

        var errors = Compile(Source).BoundProgram.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();

        Assert.Single(errors, diagnostic => diagnostic.Id == "GS0498");
    }

    private static GsCompilation Compile(string source)
        => new(GsSyntaxTree.Parse(SourceText.From(source)));

    private static string BuildRejectedSource(string shape)
    {
        if (shape == "implicit-field")
        {
            return """
                import System.Diagnostics.CodeAnalysis

                class C {
                    func M() { }
                }

                class Box {
                    var _c C?

                    @MemberNotNull("_c")
                    func EnsureInit() {
                        _c = C()
                    }

                    func Run() {
                        this.EnsureInit()
                        for var i = 0; i < 2; i++ {
                            _c.M()
                            _c = nil
                        }
                    }
                }
                """;
        }

        if (shape == "member-call")
        {
            return """
                open class Animal { }
                class Dog : Animal {
                    func Bark() { }
                }
                class Box {
                    let Pet Animal
                }

                func Run(box Box) {
                    if box.Pet is Dog {
                        for var i = 0; i < 2; i++ {
                            box.Pet.Bark()
                        }
                    }
                }
                """;
        }

        var loop = shape switch
        {
            "initializer" => """
                for c = nil; true; {
                    c.M()
                    break
                }
                """,
            "for-clause" => """
                for var i = 0; i < 2; i++ {
                    c.M()
                    c = nil
                }
                """,
            "infinite" => """
                for {
                    c.M()
                    c = nil
                    continue
                }
                """,
            "ellipsis" => """
                for i in 0 ... 2 {
                    c.M()
                    c = nil
                }
                """,
            "range" => """
                for i in []int32{1, 2} {
                    c.M()
                    c = nil
                }
                """,
            "await-range" => """
                await for i in Numbers() {
                    c.M()
                    c = nil
                }
                """,
            "do-while" => """
                do {
                    c.M()
                    c = nil
                } while true
                """,
            "nested-loop" => """
                for var i = 0; i < 2; i++ {
                    c.M()
                    for var j = 0; j < 1; j++ {
                        c = nil
                    }
                }
                """,
            "nested-if" => """
                for var i = 0; i < 2; i++ {
                    c.M()
                    if i == 0 {
                        c = nil
                    }
                }
                """,
            "continue" => """
                for var i = 0; i < 2; i++ {
                    c.M()
                    c = nil
                    continue
                }
                """,
            "labeled-continue" => """
                outer: for var i = 0; i < 2; i++ {
                    c.M()
                    for var j = 0; j < 1; j++ {
                        c = nil
                        continue outer
                    }
                }
                """,
            "post" => """
                for var i = 0; i < 2; c = nil {
                    c.M()
                    i++
                }
                """,
            "before-use" => """
                for var i = 0; i < 2; i++ {
                    c = nil
                    c.M()
                }
                """,
            "while" => """
                var i = 0
                while i < 2 {
                    d(i)
                    d = nil
                    i++
                }
                """,
            _ => throw new ArgumentOutOfRangeException(nameof(shape), shape, null),
        };

        if (shape == "while")
        {
            return $$"""
                import System

                func Run() {
                    var d System.Action[int32]? = (value int32) -> Console.WriteLine(value)
                    if d != nil {
                        {{loop}}
                    }
                }
                """;
        }

        var asyncPrefix = shape == "await-range"
            ? """
                import System.Collections.Generic

                async func Numbers() IAsyncEnumerable[int32] {
                    yield 1
                    yield 2
                }

                """
            : string.Empty;
        var functionKeyword = shape == "await-range" ? "async func" : "func";
        return $$"""
            {{asyncPrefix}}class C {
                func M() { }
            }

            {{functionKeyword}} Run() {
                var c C? = C()
                if c != nil {
                    {{loop}}
                }
            }
            """;
    }

    private static string BuildAcceptedSource(string shape)
    {
        if (shape == "other-instance-field")
        {
            return """
                import System
                import System.Diagnostics.CodeAnalysis

                class C {
                    func M() {
                        Console.WriteLine("ok")
                    }
                }

                class Box {
                    var _c C?

                    @MemberNotNull("_c")
                    func EnsureInit() {
                        _c = C()
                    }

                    func Run(other Box) {
                        this.EnsureInit()
                        for var i = 0; i < 2; i++ {
                            other._c = nil
                            _c.M()
                        }
                    }
                }

                func Main() {
                    Box{}.Run(Box{})
                }
                """;
        }

        var loop = shape switch
        {
            "unchanged" => """
                for var i = 0; i < 2; i++ {
                    c.M()
                }
                """,
            "condition-renarrow" => """
                while c != nil {
                    c.M()
                    c = nil
                }
                """,
            "inner-renarrow" => """
                for var i = 0; i < 2; i++ {
                    if c != nil {
                        c.M()
                    }
                    c = nil
                }
                """,
            "assignment-renarrow" => """
                for var i = 0; i < 2; i++ {
                    c = C()
                    c.M()
                }
                """,
            "initializer-renarrow" => """
                for c = C(); true; {
                    c.M()
                    break
                }
                """,
            "break-only" => """
                for var i = 0; i < 2; i++ {
                    c.M()
                    c = nil
                    break
                }
                """,
            "literal-false-do-while" => """
                do {
                    c.M()
                    c = nil
                } while false
                """,
            "literal-false-while" => """
                while false {
                    c.M()
                    c = nil
                }
                """,
            "shadowed-assignment" => """
                for var i = 0; i < 2; i++ {
                    {
                        var c C? = nil
                        c = nil
                    }
                    c.M()
                }
                """,
            "labeled-break" => """
                outer: for var i = 0; i < 2; i++ {
                    c.M()
                    for var j = 0; j < 1; j++ {
                        c = nil
                        break outer
                    }
                }
                """,
            "post-condition-renarrow" => """
                for ; c != nil; c = nil {
                    c.M()
                }
                """,
            "type-test-condition" => """
                while o is string {
                    Console.WriteLine(o.Length)
                    break
                }
                """,
            _ => throw new ArgumentOutOfRangeException(nameof(shape), shape, null),
        };

        if (shape == "type-test-condition")
        {
            return $$"""
                import System

                func Main() {
                    let o object = "hello"
                    {{loop}}
                }
                """;
        }

        return $$"""
            import System

            class C {
                func M() {
                    Console.WriteLine("ok")
                }
            }

            func Main() {
                var c C? = C()
                if c != nil {
                    {{loop}}
                }
            }
            """;
    }

    private static string CompileAndRun(string source, string caseName)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2943-artifacts",
            caseName + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var assemblyPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            try
            {
                var exitCode = Program.Main(
                [
                    "/out:" + assemblyPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                ]);
                Assert.True(exitCode == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
            _ = assembly.GetTypes();

            using var process = Process.Start(new ProcessStartInfo("dotnet")
            {
                ArgumentList =
                {
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                    assemblyPath,
                },
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            Assert.NotNull(process);
            var outputTask = process.StandardOutput.ReadToEndAsync();
            var errorTask = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(30_000))
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit();
                Assert.Fail("dotnet exec timed out");
            }

            var output = outputTask.GetAwaiter().GetResult();
            var error = errorTask.GetAwaiter().GetResult();
            Assert.True(process.ExitCode == 0, error);
            return output.Replace("\r\n", "\n", StringComparison.Ordinal);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }
}
