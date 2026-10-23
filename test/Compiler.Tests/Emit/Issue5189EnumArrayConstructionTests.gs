// <copyright file="Issue5189EnumArrayConstructionTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import GSharp.Compiler
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #5189: `Span[E](array)` over a same-compilation enum `E` was rejected
/// with GS9002 (and `ReadOnlySpan[E](array, 0, n)` with GS0267). The closed
/// constructor type erases `E` to `object`, so its array parameter is `object[]`,
/// but an enum array argument rode through overload resolution as `int32[]`.
/// Each program here must compile with exit code 0, pass ILVerify and give the
/// right result when run.
open class Issue5189EnumArrayConstructionTests {
    private func SourceText() string {
        return `package P
import System
import System.Collections.Generic

enum Color { Red = 1, Green = 2, Blue = 4 }

func MakeColors() []Color -> []Color{Color.Red, Color.Green, Color.Blue}

func SpanSum() int32 {
    let items = MakeColors()
    let view Span[Color] = Span[Color](items)
    var s int32 = 0
    for c in view {
        s += int32(c)
    }
    return s
}
func ReadOnlyRangeSum() int32 {
    let items = MakeColors()
    let view = ReadOnlySpan[Color](items, 1, 2)
    var s int32 = 0
    for c in view {
        s += int32(c)
    }
    return s
}
func ReadOnlyWholeLength() int32 {
    let items = MakeColors()
    let view = ReadOnlySpan[Color](items)
    return view.Length
}
func SegmentCount() int32 {
    let items = MakeColors()
    let seg = ArraySegment[Color](items)
    return seg.Count
}
func ListCount() int32 {
    let items = MakeColors()
    let l = List[Color](items)
    return l.Count
}
func SpanWriteBack() int32 {
    let items = MakeColors()
    let view = Span[Color](items)
    view[0] = Color.Blue
    return int32(items[0])
}`
    }

    @Fact
    func EnumArrayConstructions_CompileAndVerify() {
        // CompileAndLoad asserts exit code 0 and runs ILVerify.
        Assert.NotNull(CompileAndLoad(SourceText()))
    }

    @Fact
    func EnumArrayConstructions_RunWithTheRightResults() {
        let assembly = CompileAndLoad(SourceText())
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(7, Invoke(program, "SpanSum"))
        Assert.Equal(6, Invoke(program, "ReadOnlyRangeSum"))
        Assert.Equal(3, Invoke(program, "ReadOnlyWholeLength"))
        Assert.Equal(3, Invoke(program, "SegmentCount"))
        Assert.Equal(3, Invoke(program, "ListCount"))
        Assert.Equal(4, Invoke(program, "SpanWriteBack"))
    }

    shared {
        private func Invoke(program Type, name string) object? {
            let method = program.GetMethod(
                name,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
            ) ??
                throw InvalidOperationException("Missing method ${program.FullName}.$name")
            return method.Invoke(nil, default([]?object))
        }

        private func CompileAndLoad(source string) Assembly {
            let tempDir = Path.Combine(AppContext.BaseDirectory, "Issue5189Emit", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(tempDir)
            try {
                let sourcePath = Path.Combine(tempDir, "test.gs")
                let outputPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/target:library", "/out:" + outputPath, "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
                Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outputPath)
                let assembly = EmittedFixture.Load(outputPath)
                let _ = assembly.GetTypes()
                return assembly
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
