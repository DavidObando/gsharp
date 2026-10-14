// <copyright file="Issue2907IteratorLoopCaptureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Threading.Tasks
import GSharp.Compiler
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests
import System.Collections

/// Issue #2907: captures created inside iterator loops compile and match
/// equivalent non-iterator capture semantics. Asserts the emitted program
/// only; the interpreter parity arm was retired with the evaluator in
/// ADR-0156 Phase 3c (#3176).
open class Issue2907IteratorLoopCaptureTests {
    @Theory
    @MemberData("CaptureCases")
    func IteratorAndNonIteratorCaptureSemanticsAgree(name string, source string, expected string) {
        let assemblyPath = Compile(source, name)
        IlVerifier.Verify(assemblyPath)
        let assembly = EmittedFixture.Load(assemblyPath)
        Assert.NotEmpty(assembly.GetTypes())
        let output = RunBounded(assemblyPath, name)
        Assert.Equal("$expected${Environment.NewLine}$expected${Environment.NewLine}", output)
    }

    @Fact
    func AsyncIteratorLoopCaptureAgreesWithNonIterator() {
        const Source = `package Issue2907Async
import System
import System.Threading.Tasks

async func values() async sequence[int32] {
    for i in 0 ... 3 {
        var read = () -> { return i }
        yield read()
        await Task.Delay(1)
    }
}

func direct() string {
    var result = ""
    for i in 0 ... 3 {
        var read = () -> { return i }
        result = result + read().ToString() + ","
    }

    return result
}

public var iteratorResult = ""

async func collect() {
    await for value in values() {
        iteratorResult = iteratorResult + value.ToString() + ","
    }
}

collect().Wait()
let directResult = direct()
Console.WriteLine(iteratorResult)
Console.WriteLine(directResult)
iteratorResult == directResult`
        AssertParity(Source, "0,1,2,", "AsyncIteratorLoopCaptureAgreesWithNonIterator")
    }

    @Fact
    async func LibraryIteratorLoopCaptureLoadsAndInvokes() {
        const Source = `package Issue2907Library

public func values() sequence[int32] {
    for i in 0 ... 2 {
        var read = () -> { return i }
        yield read()
    }
}`
        let assemblyPath = Compile(Source, "LibraryIteratorLoopCaptureLoadsAndInvokes", target: "library")
        IlVerifier.Verify(assemblyPath)
        let assembly = EmittedFixture.Load(assemblyPath)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let method MethodInfo? = program.GetMethod("values", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(method)
        let values = await Task.Run(
            () -> (cast[IEnumerable](method!!.Invoke(nil, nil))).Cast[object]().Select(Convert.ToInt32).ToArray()
        )
            .WaitAsync(TimeSpan.FromSeconds(30))
        Assert.Equal([]int32{0, 1}, values)
    }

    @Fact
    func NonIteratorLoopCaptureGuard() {
        const Source = `package Issue2907NonIteratorGuard
import System

func direct() string {
    var first = () -> { return -1 }
    var second = () -> { return -1 }
    for i in 0 ... 2 {
        if i == 0 { first = () -> { return i } }
        if i == 1 { second = () -> { return i } }
    }

    return first().ToString() + "," + second().ToString() + ","
}

Console.WriteLine(direct())`
        let assemblyPath = Compile(Source, "NonIteratorLoopCaptureGuard")
        IlVerifier.Verify(assemblyPath)
        let assembly = EmittedFixture.Load(assemblyPath)
        Assert.NotEmpty(assembly.GetTypes())
        Assert.Equal("0,1,${Environment.NewLine}", RunBounded(assemblyPath, "NonIteratorLoopCaptureGuard"))
    }

    shared {
        func CaptureCases() sequence[[]object] {
            yield BuildCase("EllipsisLoopVariable", `func values() sequence[int32] {
    for i in 0 ... 3 {
        var read = () -> { return i }
        yield read()
    }
}

func direct() string {
    var result = ""
    for i in 0 ... 3 {
        var read = () -> { return i }
        result = result + read().ToString() + ","
    }

    return result
}`, "values()", "direct()", "0,1,2,")
            yield BuildCase("CollectionLoopVariable", `func values() sequence[int32] {
    for value in []int32{4, 5, 6} {
        var read = () -> { return value }
        yield read()
    }
}

func direct() string {
    var result = ""
    for value in []int32{4, 5, 6} {
        var read = () -> { return value }
        result = result + read().ToString() + ","
    }

    return result
}`, "values()", "direct()", "4,5,6,")
            yield BuildCase("ThreePartLoopVariable", `func values() sequence[int32] {
    for var i = 0; i < 3; i++ {
        var read = () -> { return i }
        yield read()
    }
}

func direct() string {
    var result = ""
    for var i = 0; i < 3; i++ {
        var read = () -> { return i }
        result = result + read().ToString() + ","
    }

    return result
}`, "values()", "direct()", "0,1,2,")
            yield BuildCase("LoopBodyLocalNestedAndAfterLoopYield", `func values() sequence[int32] {
    var read = () -> { return -1 }
    for i in 0 ... 3 {
        {
            var local = i + 10
            read = () -> { return local }
            if i < 2 {
                yield read()
            }
        }
    }

    yield read()
}

func direct() string {
    var result = ""
    var read = () -> { return -1 }
    for i in 0 ... 3 {
        {
            var local = i + 10
            read = () -> { return local }
            if i < 2 {
                result = result + read().ToString() + ","
            }
        }
    }

    return result + read().ToString() + ","
}`, "values()", "direct()", "10,11,12,")
            yield BuildCase("NestedLoopsCaptureOuterInnerAndBoth", `func values() sequence[int32] {
    for outer in 1 ... 3 {
        for inner in []int32{3, 4} {
            var readOuter = () -> { return outer }
            var readInner = () -> { return inner }
            var readBoth = () -> { return outer + inner }
            yield readOuter() * 100 + readInner() * 10 + readBoth()
        }
    }
}

func direct() string {
    var result = ""
    for outer in 1 ... 3 {
        for inner in []int32{3, 4} {
            var readOuter = () -> { return outer }
            var readInner = () -> { return inner }
            var readBoth = () -> { return outer + inner }
            let value = readOuter() * 100 + readInner() * 10 + readBoth()
            result = result + value.ToString() + ","
        }
    }

    return result
}`, "values()", "direct()", "134,145,235,246,")
            yield BuildCase("CapturedLoopVariableMutation", `func values() sequence[int32] {
    for i in 0 ... 6 {
        var bump = () -> { i = i + 1 }
        bump()
        yield i
    }
}

func direct() string {
    var result = ""
    for i in 0 ... 6 {
        var bump = () -> { i = i + 1 }
        bump()
        result = result + i.ToString() + ","
    }

    return result
}`, "values()", "direct()", "1,3,5,")
            yield BuildCase("CapturedParameterAndLoopVariable", `func values(offset int32) sequence[int32] {
    for i in 0 ... 3 {
        var read = () -> { return offset + i }
        yield read()
    }
}

func direct(offset int32) string {
    var result = ""
    for i in 0 ... 3 {
        var read = () -> { return offset + i }
        result = result + read().ToString() + ","
    }

    return result
}`, "values(10)", "direct(10)", "10,11,12,")
            yield BuildCase("CapturedParameterWithUncapturedLoop", `func values(n int32) sequence[int32] {
    var read = () -> { return n }
    for i in 0 ... 2 {
        yield i
    }

    yield read()
}

func direct(n int32) string {
    var read = () -> { return n }
    var result = ""
    for i in 0 ... 2 {
        result = result + i.ToString() + ","
    }

    return result + read().ToString() + ","
}`, "values(7)", "direct(7)", "0,1,7,")
            yield BuildCase("StoredEllipsisCallbacksAfterLoop", `func values() sequence[int32] {
    var first = () -> { return -1 }
    var second = () -> { return -1 }
    var third = () -> { return -1 }
    for i in 0 ... 3 {
        if i == 0 { first = () -> { return i } }
        if i == 1 { second = () -> { return i } }
        if i == 2 { third = () -> { return i } }
    }

    yield first()
    yield second()
    yield third()
}

func direct() string {
    var first = () -> { return -1 }
    var second = () -> { return -1 }
    var third = () -> { return -1 }
    for i in 0 ... 3 {
        if i == 0 { first = () -> { return i } }
        if i == 1 { second = () -> { return i } }
        if i == 2 { third = () -> { return i } }
    }

    return first().ToString() + "," + second().ToString() + "," + third().ToString() + ","
}`, "values()", "direct()", "0,1,2,")
            yield BuildCase("StoredCollectionCallbacksAfterLoop", `func values() sequence[int32] {
    var first = () -> { return -1 }
    var second = () -> { return -1 }
    var third = () -> { return -1 }
    for value in []int32{4, 5, 6} {
        if value == 4 { first = () -> { return value } }
        if value == 5 { second = () -> { return value } }
        if value == 6 { third = () -> { return value } }
    }

    yield first()
    yield second()
    yield third()
}

func direct() string {
    var first = () -> { return -1 }
    var second = () -> { return -1 }
    var third = () -> { return -1 }
    for value in []int32{4, 5, 6} {
        if value == 4 { first = () -> { return value } }
        if value == 5 { second = () -> { return value } }
        if value == 6 { third = () -> { return value } }
    }

    return first().ToString() + "," + second().ToString() + "," + third().ToString() + ","
}`, "values()", "direct()", "4,5,6,")
            yield BuildCase("StoredThreePartCallbacksAfterLoop", `func values() sequence[int32] {
    var first = () -> { return -1 }
    var second = () -> { return -1 }
    var third = () -> { return -1 }
    for var i = 0; i < 3; i++ {
        if i == 0 { first = () -> { return i } }
        if i == 1 { second = () -> { return i } }
        if i == 2 { third = () -> { return i } }
    }

    yield first()
    yield second()
    yield third()
}

func direct() string {
    var first = () -> { return -1 }
    var second = () -> { return -1 }
    var third = () -> { return -1 }
    for var i = 0; i < 3; i++ {
        if i == 0 { first = () -> { return i } }
        if i == 1 { second = () -> { return i } }
        if i == 2 { third = () -> { return i } }
    }

    return first().ToString() + "," + second().ToString() + "," + third().ToString() + ","
}`, "values()", "direct()", "3,3,3,")
            yield BuildCase("GenericFunctionValueAndReferenceTypes", `func values[T any](items []T) sequence[T] {
    for value in items {
        var read = () -> { return value }
        yield read()
    }
}

func direct[T any](items []T) string {
    var result = ""
    for value in items {
        var read = () -> { return value }
        result = result + read().ToString() + ","
    }

    return result
}

func allValues() sequence[string] {
    for value in values[int32]([]int32{1, 2}) {
        yield value.ToString()
    }

    for value in values[string]([]string{"a", "b"}) {
        yield value
    }
}

func allDirect() string {
    return direct[int32]([]int32{1, 2}) + direct[string]([]string{"a", "b"})
}`, "allValues()", "allDirect()", "1,2,a,b,")
            yield BuildCase("GenericTypeIterator", `class Bucket[T any] {
    func values(items []T) sequence[T] {
        for value in items {
            var read = () -> { return value }
            yield read()
        }
    }

    func direct(items []T) string {
        var result = ""
        for value in items {
            var read = () -> { return value }
            result = result + read().ToString() + ","
        }

        return result
    }
}

func allValues() sequence[string] {
    let bucket = Bucket[string]()
    for value in bucket.values([]string{"x", "y"}) {
        yield value
    }
}

func allDirect() string {
    let bucket = Bucket[string]()
    return bucket.direct([]string{"x", "y"})
}`, "allValues()", "allDirect()", "x,y,")
            yield BuildCase("WhileLoopBodyLocal", `func values() sequence[int32] {
    var i = 0
    while i < 3 {
        var local = i
        var read = () -> { return local }
        yield read()
        i++
    }
}

func direct() string {
    var result = ""
    var i = 0
    while i < 3 {
        var local = i
        var read = () -> { return local }
        result = result + read().ToString() + ","
        i++
    }

    return result
}`, "values()", "direct()", "0,1,2,")
            yield BuildCase("DoLoopBodyLocal", `func values() sequence[int32] {
    var i = 0
    do {
        var local = i
        var read = () -> { return local }
        yield read()
        i++
    } while i < 3
}

func direct() string {
    var result = ""
    var i = 0
    do {
        var local = i
        var read = () -> { return local }
        result = result + read().ToString() + ","
        i++
    } while i < 3

    return result
}`, "values()", "direct()", "0,1,2,")
            yield BuildCase("IteratorLoopWithoutCaptureGuard", `func values() sequence[int32] {
    for i in 0 ... 3 {
        yield i
    }
}

func direct() string {
    return "0,1,2,"
}`, "values()", "direct()", "0,1,2,")
            yield BuildCase("IteratorWithoutLoopGuard", `func values() sequence[int32] {
    yield 1
    yield 2
}

func direct() string {
    return "1,2,"
}`, "values()", "direct()", "1,2,")
        }

        private func BuildCase(
            name string,
            declarations string,
            iteratorCall string,
            directCall string,
            expected string
        )[]object {
            let source = (`package Issue2907` + "$name" + `
import System

` + "$declarations" + `

var iteratorResult = ""
for value in ` + "$iteratorCall" + ` {
    iteratorResult = iteratorResult + value.ToString() + ","
}

let directResult = ` + "$directCall" + `
Console.WriteLine(iteratorResult)
Console.WriteLine(directResult)
iteratorResult == directResult`)
            return []object{name, source, expected}
        }

        private func AssertParity(source string, expected string, name string) {
            let assemblyPath = Compile(source, name)
            IlVerifier.Verify(assemblyPath)
            let assembly = EmittedFixture.Load(assemblyPath)
            Assert.NotEmpty(assembly.GetTypes())
            Assert.Equal(
                "$expected${Environment.NewLine}$expected${Environment.NewLine}",
                RunBounded(assemblyPath, name)
            )
        }

        private func Compile(source string, name string, target string = "exe") string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2907IteratorLoopCaptureTests", name)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:" + target, "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            Assert.True(exitCode == 0, ("$name" + `: gsc failed:
` + "$stdout" + `
` + "$stderr"))
            return assemblyPath
        }

        private func RunBounded(assemblyPath string, name string) string {
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            Assert.NotNull(process)
            let outputTask = process!!.StandardOutput.ReadToEndAsync()
            let errorTask = process!!.StandardError.ReadToEndAsync()
            let exited = process!!.WaitForExit(30_000)
            if !exited {
                process!!.Kill(entireProcessTree: true)
                process!!.WaitForExit()
            }
            Assert.True(exited, "$name: emitted program timed out")
            let output = outputTask.GetAwaiter().GetResult()
            let error = errorTask.GetAwaiter().GetResult()
            Assert.True(process!!.ExitCode == 0, ("$name" + `: emitted program failed:
` + "$error"))
            return output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
