// <copyright file="Issue2951NestedGenericStructIteratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.Diagnostics
import System.IO
import System.Reflection
import Xunit

/// Issue #2951 and #1537 residual: nested generic state machines and method
/// references retain every enclosing and receiver type-parameter ordinal.
open class Issue2951NestedGenericStructIteratorTests {
    @Fact
    func NestedNonGenericStructUsesEnclosingTypeParameter() {
        const Source = `package Issue2951Enclosing
import System

class Wrap[T] {
    struct Cell {
        var A T
        func vals() sequence[T] { yield A }
    }
}

for value in Wrap[int32].Cell{A: 42}.vals() {
    Console.WriteLine(value)
}`
        AssertLoadsAndRuns(Source, "NestedNonGenericStructUsesEnclosingTypeParameter", "42\n")
    }

    @Fact
    func NestedGenericStructUsesOwnTypeParameterDirectlyAndInLoop() {
        const Source = `package Issue2951Own
import System

class Wrap[T] {
    struct Cell[U] {
        var A U
        func vals() sequence[U] { yield A }
    }
}

var cell = Wrap[int32].Cell[string]{A: "x"}
let iterator = cell.vals().GetEnumerator()
if iterator.MoveNext() {
    Console.WriteLine(iterator.Current)
}

for value in cell.vals() {
    Console.WriteLine(value)
}`
        AssertLoadsAndRuns(Source, "NestedGenericStructUsesOwnTypeParameterDirectlyAndInLoop", `x
x
`)
    }

    @Fact
    func NestedGenericStructUsesBothParametersAtTwoInstantiations() {
        const Source = `package Issue2951Both
import System

class Outer[T] {
    struct Cell[U] {
        var A T
        var B U
        func vals() sequence[string] { yield A.ToString() + B.ToString() }
    }
}

var first = Outer[int32].Cell[string]{A: 42, B: "x"}
for value in first.vals() {
    Console.WriteLine(value)
}

var second = Outer[string].Cell[int32]{A: "y", B: 7}
for value in second.vals() {
    Console.WriteLine(value)
}`
        AssertLoadsAndRuns(Source, "NestedGenericStructUsesBothParametersAtTwoInstantiations", `42x
y7
`)
    }

    @Fact
    func TwoNestedGenericLevelsUseAllParameters() {
        const Source = `package Issue2951TwoLevels
import System

class Outer[T] {
    struct Middle[U] {
        struct Inner[V] {
            var A T
            var B U
            var C V
            func vals() sequence[string] {
                yield A.ToString() + B.ToString() + C.ToString()
            }
        }
    }
}

var value = Outer[int32].Middle[string].Inner[bool]{
    A: 4,
    B: "z",
    C: true
}
for item in value.vals() {
    Console.WriteLine(item)
}`
        AssertLoadsAndRuns(Source, "TwoNestedGenericLevelsUseAllParameters", "4zTrue\n")
    }

    @Fact
    func NonGenericOuterLevelDoesNotShiftGenericMiddleParameter() {
        const Source = `package Issue2951AsymmetricOuter
import System

class Outer {
    struct Mid[U] {
        struct Inner {
            var Value U
            func vals() sequence[U] { yield Value }
        }
    }
}

var value = Outer.Mid[string].Inner{Value: "q"}
for item in value.vals() {
    Console.WriteLine(item)
}`
        AssertLoadsAndRuns(Source, "NonGenericOuterLevelDoesNotShiftGenericMiddleParameter", "q\n")
    }

    @Fact
    func NonGenericClassMiddleDoesNotShiftOuterAndInnerParameters() {
        const Source = `package Issue2951AsymmetricClassMiddle
import System

class Outer[T] {
    class Mid {
        struct Inner[V] {
            var A T
            var B V
            func vals() sequence[string] {
                yield A.ToString() + "|" + B.ToString()
            }
        }
    }
}

var value = Outer[int32].Mid.Inner[string]{A: 7, B: "z"}
for item in value.vals() {
    Console.WriteLine(item)
}`
        AssertLoadsAndRuns(Source, "NonGenericClassMiddleDoesNotShiftOuterAndInnerParameters", "7|z\n")
    }

    @Fact
    func NonGenericStructMiddleDoesNotShiftOuterAndInnerParameters() {
        const Source = `package Issue2951AsymmetricStructMiddle
import System

class Outer[T] {
    struct Mid {
        struct Inner[V] {
            var A T
            var B V
            func vals() sequence[string] {
                yield A.ToString() + "|" + B.ToString()
            }
        }
    }
}

var value = Outer[bool].Mid.Inner[int32]{A: true, B: 5}
for item in value.vals() {
    Console.WriteLine(item)
}`
        AssertLoadsAndRuns(Source, "NonGenericStructMiddleDoesNotShiftOuterAndInnerParameters", "True|5\n")
    }

    @Fact
    func NonGenericOuterDoesNotShiftTwoNestedOwnParameters() {
        const Source = `package Issue2951AsymmetricOwnParameters
import System

class Outer {
    class Mid[U] {
        struct Inner[V] {
            var A U
            var B V
            func vals() sequence[string] {
                yield A.ToString() + "|" + B.ToString()
            }
        }
    }
}

var value = Outer.Mid[string].Inner[int32]{A: "k", B: 9}
for item in value.vals() {
    Console.WriteLine(item)
}`
        AssertLoadsAndRuns(Source, "NonGenericOuterDoesNotShiftTwoNestedOwnParameters", "k|9\n")
    }

    @Fact
    func AsyncNonGenericMiddleDoesNotShiftOuterAndInnerParameters() {
        const Source = `package Issue2951AsymmetricAsync
import System
import System.Threading.Tasks

class Outer[T] {
    class Mid {
        struct Inner[V] {
            var A T
            var B V
            async func vals() async sequence[string] {
                yield A.ToString() + "|" + B.ToString()
                await Task.Delay(1)
            }
        }
    }
}

var value = Outer[int32].Mid.Inner[string]{A: 3, B: "w"}
let iterator = value.vals().GetAsyncEnumerator()
for iterator.MoveNextAsync().AsTask().Result {
    Console.WriteLine(iterator.Current)
}`
        AssertLoadsAndRuns(Source, "AsyncNonGenericMiddleDoesNotShiftOuterAndInnerParameters", "3|w\n")
    }

    @Fact
    func NestedClassIteratorUsesEnclosingTypeParameter() {
        const Source = `package Issue2951Class
import System

class Outer[T](Seed T) {
    class Cell(Value T) {
        func vals() sequence[T] { yield Value }
    }

    func print() {
        for value in Cell(Seed).vals() {
            Console.WriteLine(value)
        }
    }
}

Outer[int32](43).print()`
        AssertLoadsAndRuns(Source, "NestedClassIteratorUsesEnclosingTypeParameter", "43\n")
    }

    @Fact
    func AsyncNestedGenericStructIteratorUsesBothParameters() {
        const Source = `package Issue2951Async
import System
import System.Threading.Tasks

class Outer[T] {
    struct Cell[U] {
        var A T
        var B U
        async func vals() async sequence[string] {
            yield A.ToString() + B.ToString()
            await Task.Delay(1)
        }
    }
}

var cell = Outer[int32].Cell[string]{A: 44, B: "a"}
let iterator = cell.vals().GetAsyncEnumerator()
for iterator.MoveNextAsync().AsTask().Result {
    Console.WriteLine(iterator.Current)
}`
        AssertLoadsAndRuns(Source, "AsyncNestedGenericStructIteratorUsesBothParameters", "44a\n")
    }

    @Fact
    func NestedIteratorComposesWithNullableGenericSpecialization() {
        const Source = `package Issue2951Nullable
import System

class Outer[T] {
    struct Cell {
        var Marker T
        func vals[U](value U) sequence[U?] {
            Console.WriteLine(Marker)
            yield value
            yield nil
        }
    }
}

var cell = Outer[int32].Cell{Marker: 45}
for value in cell.vals[int32](46) {
    Console.WriteLine(value == nil ? "int:nil" : value.ToString())
}
for value in cell.vals[string]("s") {
    Console.WriteLine(value == nil ? "string:nil" : value)
}`
        AssertLoadsAndRuns(Source, "NestedIteratorComposesWithNullableGenericSpecialization", `45
46
int:nil
45
s
string:nil
`)
    }

    @Fact
    func SharedNestedGenericStructIteratorUsesOwnTypeParameter() {
        const Source = `package Issue2951Shared
import System

class Outer[T] {
    struct Cell[U] {
        shared {
            func vals(value U) sequence[U] { yield value }
        }
    }
}

for value in Outer[int32].Cell[string].vals("shared") {
    Console.WriteLine(value)
}`
        AssertLoadsAndRuns(Source, "SharedNestedGenericStructIteratorUsesOwnTypeParameter", "shared\n")
    }

    @Fact
    func NestedGenericNonIteratorMethodUsesDistinctParameterOrdinals() {
        const Source = `package Issue2951MethodMemberRef
import System

class Outer[T] {
    struct Cell[U] {
        var A T
        var B U
        func echo(u U, t T) string {
            return u.ToString() + "/" + t.ToString()
        }
    }
}

var value = Outer[int32].Cell[string]{A: 1, B: "b"}
Console.WriteLine(value.echo("z", 9))`
        AssertLoadsAndRuns(Source, "NestedGenericNonIteratorMethodUsesDistinctParameterOrdinals", "z/9\n")
    }

    @Fact
    func NestedEnumIteratorRemainsValid() {
        const Source = `package Issue2951EnumGuard
import System

class Outer[T] {
    enum Kind { A }
    func vals() sequence[Kind] { yield Kind.A }
}

var outer = Outer[int32]()
for value in outer.vals() {
    Console.WriteLine(value)
}`
        AssertLoadsAndRuns(Source, "NestedEnumIteratorRemainsValid", "0\n")
    }

    @Fact
    func TopLevelGenericStructIteratorRemainsValid() {
        const Source = `package Issue2951TopLevelGuard
import System

struct Cell[T] {
    var A T
    func vals() sequence[T] { yield A }
}

var cell = Cell[int32]{A: 45}
for value in cell.vals() {
    Console.WriteLine(value)
}`
        AssertLoadsAndRuns(Source, "TopLevelGenericStructIteratorRemainsValid", "45\n")
    }

    @Fact
    func NonGenericNestedStructIteratorRemainsValid() {
        const Source = `package Issue2951NonGenericGuard
import System

class Outer {
    struct Cell {
        var A int32
        func vals() sequence[int32] { yield A }
    }
}

for value in Outer.Cell{A: 46}.vals() {
    Console.WriteLine(value)
}`
        AssertLoadsAndRuns(Source, "NonGenericNestedStructIteratorRemainsValid", "46\n")
    }

    @Fact
    func TopLevelFunctionIteratorRemainsValid() {
        const Source = `package Issue2951FunctionGuard
import System

func vals() sequence[int32] { yield 47 }

for value in vals() {
    Console.WriteLine(value)
}`
        AssertLoadsAndRuns(Source, "TopLevelFunctionIteratorRemainsValid", "47\n")
    }

    shared {
        private func AssertLoadsAndRuns(source string, name string, expected string) {
            let assemblyPath = Compile(source, name)
            let assembly = EmittedFixture.Load(assemblyPath)
            Assert.NotEmpty(assembly.GetTypes())
            Assert.Equal(expected, RunBounded(assemblyPath, name))
        }

        private func Compile(source string, name string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2951NestedGenericStructIteratorTests", name)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
            File.Delete(assemblyPath)
            File.Delete(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
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
