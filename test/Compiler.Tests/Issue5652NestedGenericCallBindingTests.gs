// <copyright file="Issue5652NestedGenericCallBindingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Diagnostics
import System.IO
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue5652NestedGenericCallBindingTests {
    @Theory
    @InlineData(24)
    @InlineData(32)
    func DeepInferredCalls_CompileAndExecuteWithinTheDriverBound(depth int32) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package Nested5652
import System
func Free[T](x T) T -> x
func Map[T](x T, f Func[T, int32]) int32 -> f(x)
func (self int32) Extension[T](x T) T -> x
class Instance {
    public func Id[T](x T) T -> x
    public func Id(x int32) int32 -> x
    public func Nested() string -> MEMBER
}
shared class Static {
    private var Calls int32 = 0
    public func Id[T](x T) T -> x
    func Id(x int32) int32 -> x
    func Pair[T](x T, unused int32) T -> x
    func Consume(x int32) int32 -> x
    func Apply[T](x T, f Func[string, string]) string -> f("a")
    func Next() string {
        Calls += 1
        return "a"
    }
    public func Run() {
        Console.WriteLine(STATIC)
        Console.WriteLine(PAIR)
        Console.WriteLine(Apply(STATIC, (x) -> x + "!"))
        Console.WriteLine(Calls)
        let value string? = "abc"
        if value != nil {
            let captured = Id(() -> value.Length)
            Console.WriteLine(captured())
            Console.WriteLine(Map(Id(value), (x) -> x.Length))
            Console.WriteLine(Consume(if true { 1 } else { 2 }))
        }
    }
}
func Main() {
    Console.WriteLine(FREE)
    Console.WriteLine(QUALIFIED)
    Console.WriteLine(Instance().Nested())
    Console.WriteLine(EXTENSION)
    Static.Run()
}`.Replace(
            "MEMBER",
            Nest("this.Id(", `"a"`, ")", depth),
            StringComparison.Ordinal
        ).Replace(
            "FREE",
            Nest("Free(", `"a"`, ")", depth),
            StringComparison.Ordinal
        ).Replace(
            "QUALIFIED",
            Nest("Static.Id(", `"a"`, ")", depth),
            StringComparison.Ordinal
        ).Replace(
            "EXTENSION",
            Nest("int32(1).Extension(", `"a"`, ")", depth),
            StringComparison.Ordinal
        ).Replace(
            "STATIC",
            Nest("Id(", "Next()", ")", depth),
            StringComparison.Ordinal
        ).Replace("PAIR", Nest("Pair(", "Next()", ", 1)", depth), StringComparison.Ordinal)
        let dll = Compile(fixture, source, "Nested5652")
        let image = File.ReadAllBytes(dll)
        Assert.Equal(image, File.ReadAllBytes(Compile(fixture, source, "Nested5652")))
        IlVerifier.Verify(dll)
        Assert.Equal(
            Encoding.UTF8.GetBytes("a\na\na\na\na\na\na!\n3\n3\n3\n1\n".Replace("\n", Environment.NewLine)),
            fixture.RunBytes(dll)
        )
    }

    @Fact
    func InvalidNestedArguments_ReportTheirDiagnosticOnce() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = "package Invalid5652\nshared class P {\n    func Id[T](x T) T -> x\n" +
            "    func Bad() string -> " +
            Nest("Id(", "missing", ")", 24) +
            "\n}"
        let result = CompileProcess(fixture, source, "Invalid5652")
        Assert.NotEqual(0, result.ExitCode)
        let diagnostics = result.Stdout + result.Stderr
        Assert.Contains("Invalid5652.gs(4,98,4,105): error GS0125:", diagnostics, StringComparison.Ordinal)
        Assert.Equal(1, Regex.Matches(diagnostics, "error GS0125:").Count)
        Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Invalid5652.dll")))
    }

    private func Compile(fixture NativeSliceLanguageTests.Fixture, source string, name string) string {
        let result = CompileProcess(fixture, source, name)
        Assert.True(result.ExitCode == 0, result.Stdout + result.Stderr)
        return Path.Combine(fixture.Directory, name + ".dll")
    }

    private func CompileProcess(fixture NativeSliceLanguageTests.Fixture, source string, name string)(
        ExitCode int32,
        Stdout string,
        Stderr string
    ) {
        let sourcePath = Path.Combine(fixture.Directory, name + ".gs")
        File.WriteAllText(sourcePath, source)
        let start = ProcessStartInfo("dotnet"){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        start.ArgumentList.Add(typeof(Program).Assembly.Location)
        start.ArgumentList.Add("/target:exe")
        start.ArgumentList.Add("/targetframework:net10.0")
        start.ArgumentList.Add("/deterministic+")
        start.ArgumentList.Add("/out:" + Path.Combine(fixture.Directory, name + ".dll"))
        start.ArgumentList.Add(sourcePath)
        // A reverted binder must fail promptly instead of blocking the test process on exponential work.
        return IlVerifier.RunProcess(start, name, 10_000)
    }

    private func Nest(prefix string, leaf string, suffix string, depth int32) string {
        var expression = leaf
        for var i = 0; i < depth; i++ {
            expression = prefix + expression + suffix
        }
        return expression
    }
}
