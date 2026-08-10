// <copyright file="Issue2943LoopBackEdgeNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Compiler;
using GSharp.Core.CodeAnalysis.Binding;
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
    [InlineData("closure", "GS0159")]
    public void AssignmentReachingBackEdge_InvalidatesInheritedNarrowing(
        string shape,
        string expectedDiagnostic)
    {
        var compilation = Compile(BuildRejectedSource(shape));
        var errors = compilation.BoundProgram.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();

        Assert.Contains(errors, diagnostic => diagnostic.Id == expectedDiagnostic);
    }

    [Theory]
    [InlineData("function-literal")]
    [InlineData("arrow-lambda")]
    [InlineData("inline-argument")]
    public void ClosureWrite_InvalidatesNarrowingOutsideLoop(string shape)
    {
        var errors = Compile(BuildClosureWriteSource(shape))
            .BoundProgram.Diagnostics
            .Where(diagnostic => diagnostic.IsError)
            .ToArray();

        Assert.Contains(errors, diagnostic => diagnostic.Id == "GS0159");
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

    [Theory]
    [InlineData("constructor", "c = C(33)", "function")]
    [InlineData("local", "c = fresh", "function")]
    [InlineData("function", "c = Mk(33)", "function")]
    [InlineData("constructor", "c = C(33)", "top-level")]
    [InlineData("local", "c = fresh", "top-level")]
    [InlineData("function", "c = Mk(33)", "top-level")]
    public void NonNullAssignmentAfterUse_PreservesInheritedNarrowing(
        string shape,
        string secondIterationAssignment,
        string scope)
    {
        var declarations = """
            import System

            class C {
                let Value int32

                init(value int32) {
                    Value = value
                }

                func Print() {
                    Console.WriteLine(Value)
                }
            }

            func Mk(value int32) C {
                return C(value)
            }
            """;
        var body = $$"""
            var c C? = C(11)
            let fresh C = C(33)
            if c != nil {
                for var i = 0; i < 3; i++ {
                    c.Print()
                    if i == 0 {
                        c = C(22)
                    }
                    if i == 1 {
                        {{secondIterationAssignment}}
                    }
                }
            }
            """;
        var source = scope == "top-level"
            ? declarations + Environment.NewLine + body
            : declarations + Environment.NewLine + $$"""

            func Main() {
            {{Indent(body)}}
            }
            """;

        Assert.Equal($"11{Environment.NewLine}22{Environment.NewLine}33{Environment.NewLine}", CompileAndRun(source, $"non-null-after-use-{shape}-{scope}"));
    }

    [Theory]
    [InlineData("function")]
    [InlineData("top-level")]
    public void OriginalAssignmentAfterUse_RemainsRejected(string scope)
    {
        const string Declarations = """
            class C {
                func Print() { }
            }
            """;
        const string Body = """
            var c C? = C()
            if c != nil {
                for var i = 0; i < 2; i++ {
                    c.Print()
                    c = nil
                }
            }
            """;
        var source = scope == "top-level"
            ? Declarations + Environment.NewLine + Body
            : Declarations + Environment.NewLine + $$"""
                func Main() {
                {{Indent(Body)}}
                }
                """;

        var (exitCode, output) = CompileWithDriver(source, $"original-rejected-{scope}");

        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0159", output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("straight-line")]
    [InlineData("while")]
    public void TopLevelNullableReassignment_RemainsRejected(string shape)
    {
        var body = shape switch
        {
            "straight-line" => """
                var c C? = C()
                if c != nil {
                    c.Print()
                }
                c = nil
                c.Print()
                """,
            "while" => """
                var c C? = C()
                if c != nil {
                    var i = 0
                    while i < 2 {
                        c.Print()
                        c = nil
                        i++
                    }
                }
                """,
            _ => throw new ArgumentOutOfRangeException(nameof(shape), shape, null),
        };
        var source = """
            class C {
                func Print() { }
            }
            """ + Environment.NewLine + body;

        var (exitCode, output) = CompileWithDriver(source, $"top-level-rejected-{shape}");

        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0159", output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("field")]
    [InlineData("function")]
    [InlineData("shadowed-constructor")]
    [InlineData("out-alias")]
    [InlineData("imported")]
    [InlineData("parameter")]
    public void RuntimeNullableSource_DoesNotPreserveInheritedNarrowing(string shape)
    {
        var source = shape switch
        {
            "field" => """
                class C { func M() { } }
                class Box { var Value C }
                func Run() {
                    let box = Box{}
                    var c C? = C()
                    if c != nil {
                        for var i = 0; i < 2; i++ {
                            c.M()
                            c = box.Value
                        }
                    }
                }
                """,
            "function" => """
                class C { func M() { } }
                class Box { var Value C }
                func Bad() C { return Box{}.Value }
                func Run() {
                    var c C? = C()
                    if c != nil {
                        for var i = 0; i < 2; i++ {
                            c.M()
                            c = Bad()
                        }
                    }
                }
                """,
            "shadowed-constructor" => """
                class C { func M() { } }
                class Box { var Value C }
                func C() C { return Box{}.Value }
                func Mk() C { return C() }
                func Run() {
                    var c C? = C{}
                    if c != nil {
                        for var i = 0; i < 2; i++ {
                            c.M()
                            c = Mk()
                        }
                    }
                }
                """,
            "out-alias" => """
                class C { func M() { } }
                func Run(out c C?, ref alias C?) {
                    c = C()
                    if c != nil {
                        for var i = 0; i < 2; i++ {
                            c.M()
                            c = C()
                            alias = nil
                        }
                    }
                }
                var x C? = nil
                Run(out x, ref x)
                """,
            "imported" => """
                import System
                func Run() {
                    var value string? = "ok"
                    if value != nil {
                        for var i = 0; i < 2; i++ {
                            let length = value.Length
                            value = Console.ReadLine()
                        }
                    }
                }
                """,
            "parameter" => """
                class C { func M() { } }
                class Box { var Value C }
                func Run(value C) {
                    var c C? = C()
                    if c != nil {
                        for var i = 0; i < 2; i++ {
                            c.M()
                            c = value
                        }
                    }
                }
                Run(Box{}.Value)
                """,
            _ => throw new ArgumentOutOfRangeException(nameof(shape), shape, null),
        };

        Assert.Contains(
            Compile(source).BoundProgram.Diagnostics,
            diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void UnrelatedMemberInvalidation_DoesNotMaskNonNullLocalAssignment()
    {
        const string Source = """
            import System

            class C {
                let Value int32

                init(value int32) {
                    Value = value
                }

                func Print() {
                    Console.WriteLine(Value)
                }
            }

            class Box {
                var Value C?
            }

            func Main() {
                var c C? = C(11)
                let box = Box{}
                box.Value = C(99)
                if c != nil {
                    if box.Value != nil {
                        for var i = 0; i < 3; i++ {
                            c.Print()
                            if i == 0 {
                                c = C(22)
                            }
                            if i == 1 {
                                c = C(33)
                            }
                        }
                    }
                }
            }
            """;

        Assert.Equal($"11{Environment.NewLine}22{Environment.NewLine}33{Environment.NewLine}", CompileAndRun(Source, "non-null-with-member-invalidation"));
    }

    [Fact]
    public void NonNullAssignmentToDifferentSubtype_InvalidatesTypeNarrowing()
    {
        const string Source = """
            open class Base {
            }

            class A : Base {
                func OnlyA() {
                }
            }

            class B : Base {
            }

            func Run() {
                var value Base? = A()
                if value is A {
                    for var i = 0; i < 3; i++ {
                        value.OnlyA()
                        if i == 1 {
                            value = B()
                        }
                    }
                }
            }
            """;

        var errors = Compile(Source).BoundProgram.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();

        var error = Assert.Single(errors);
        Assert.Equal("GS0159", error.Id);
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
    public void SpeculativeRebind_DoesNotDuplicateLambdaReturnDiagnostic()
    {
        const string Source = """
            class C {
                func M() { }
            }

            func Run() {
                var c C? = C()
                if c != nil {
                    for var i = 0; i < 2; i++ {
                        let choose = func(flag bool) int32 {
                            if flag {
                                return 1
                            }
                        }
                        c.M()
                        c = nil
                    }
                }
            }
            """;

        var errors = Compile(Source).BoundProgram.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();

        Assert.Single(errors, diagnostic => diagnostic.Id == "GS0100");
        Assert.Single(errors, diagnostic => diagnostic.Id == "GS0159");
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
    public void SpeculativeRebind_RestoresSyntheticLambdaOrdinal()
    {
        const string Source = """
            import System

            class C {
                func M() { }
            }

            func Run() {
                var c C? = C()
                if c != nil {
                    for var i = 0; i < 2; i++ {
                        let print = func() { Console.WriteLine(i) }
                        print()
                        if c != nil {
                            c.M()
                        }
                        c = nil
                    }
                }
            }
            """;

        var program = Compile(Source).BoundProgram;
        var collector = new FunctionLiteralNameCollector();
        foreach (var body in program.Functions.Values)
        {
            collector.VisitStatement(body);
        }

        Assert.Contains("<lambda1>", collector.Names);
        Assert.DoesNotContain("<lambda2>", collector.Names);
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
                var c C? = C()
                if c != nil {
                    for var i = 0; i < 2; i++ {
                        if i == 0 {
                            goto handler
                        }
                        c.M()
                        c = nil
                        c.M()
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
        Assert.Equal(2, errors.Count(diagnostic => diagnostic.Id == "GS0159"));
    }

    private static GsCompilation Compile(string source)
        => new(GsSyntaxTree.Parse(SourceText.From(source)));

    private static string Indent(string source)
        => string.Join(
            Environment.NewLine,
            source.Split(Environment.NewLine).Select(line => "    " + line));

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
            "closure" => """
                for var i = 0; i < 2; i++ {
                    c.M()
                    let clear = func() { c = nil }
                    clear()
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

    private static string BuildClosureWriteSource(string shape)
    {
        var closure = shape switch
        {
            "function-literal" => """
                let clear = func() { c = nil }
                clear()
                """,
            "arrow-lambda" => """
                let clear Action = () -> c = nil
                clear()
                """,
            "inline-argument" => """
                Apply(func() { c = nil })
                """,
            _ => throw new ArgumentOutOfRangeException(nameof(shape), shape, null),
        };

        return $$"""
            import System

            class C {
                func M() { }
            }

            func Apply(action Action) {
                action()
            }

            func Run() {
                var c C? = C()
                if c != nil {
                    {{closure}}
                    c.M()
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

            var startInfo = new ProcessStartInfo("dotnet")
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
            };
            var (processExitCode, output, error) = IlVerifier.RunProcess(startInfo, assemblyPath, 30_000);
            Assert.True(processExitCode == 0, error);
            return output.ReplaceLineEndings(Environment.NewLine);
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

    private static (int ExitCode, string Output) CompileWithDriver(string source, string caseName)
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
                return (exitCode, stdout + Environment.NewLine + stderr);
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }
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

    private sealed class FunctionLiteralNameCollector : BoundTreeWalker
    {
        /// <summary>Gets function-literal symbol names found in visited bodies.</summary>
        public System.Collections.Generic.List<string> Names { get; } = [];

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundFunctionLiteralExpression literal)
            {
                Names.Add(literal.Function.Name);
                if (literal.Body != null)
                {
                    VisitStatement(literal.Body);
                }

                return;
            }

            base.VisitExpression(node);
        }
    }
}
