// <copyright file="Issue5151SpanForInTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import GSharp.Compiler
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #5151: `for x in view` over a `Span[T]`, `ReadOnlySpan[T]` or
/// `ArraySegment[T]` whose element type is declared in the same compilation
/// typed the enumerator from the erased CLR type (`Span<object>.Enumerator`),
/// so the emitted assembly failed IL verification. The enumerator is now typed
/// from the receiver's own type arguments, like the collections of #4907.
open class Issue5151SpanForInTests {
    private func SourceText() string {
        return `package P
import System
import System.Collections.Generic
import System.Runtime.InteropServices

struct Pt { var X int32 }
class Node { var N int32 }
enum Color { Red = 1, Green = 2, Blue = 4 }

func MakePts() []Pt -> []Pt{Pt{X: 3}, Pt{X: 4}}
func MakeNodes() []Node -> []Node{Node{N: 5}, Node{N: 6}}
func MakeNullable() List[Node?] {
    var l = List[Node?]()
    l.Add(Node{N: 7})
    l.Add(nil)
    return l
}
func MakeColors() List[Color] {
    var l = List[Color]()
    l.Add(Color.Red)
    l.Add(Color.Blue)
    return l
}
func MakeTuples() List[(A int64, B object?)] {
    var l = List[(A int64, B object?)]()
    l.Add((A: 1, B: nil))
    l.Add((A: 2, B: "x"))
    return l
}

func SpanPts(items []Pt) int32 {
    var s int32 = 0
    let view Span[Pt] = Span[Pt](items)
    for p in view {
        s += p.X
    }
    return s
}
func SpanNodes(items []Node) int32 {
    var s int32 = 0
    let view Span[Node] = Span[Node](items)
    for n in view {
        s += n.N
    }
    return s
}
func SpanNullable(items List[Node?]) int32 {
    var s int32 = 0
    let view Span[Node?] = CollectionsMarshal.AsSpan(items)
    for n in view {
        if n == nil {
            s += 100
        } else {
            s += n.N
        }
    }
    return s
}
func SpanColors(items List[Color]) int32 {
    var s int32 = 0
    let view Span[Color] = CollectionsMarshal.AsSpan(items)
    for c in view {
        s += int32(c)
    }
    return s
}
func SpanTuples(items List[(A int64, B object?)]) int64 {
    var s int64 = 0
    let view Span[(A int64, B object)] = CollectionsMarshal.AsSpan(items)
    for t in view {
        s += t.A
        if t.B == nil {
            s += 100
        }
    }
    return s
}
func SpanGeneric[T](items []T) int32 {
    var c int32 = 0
    let view Span[T] = Span[T](items)
    for x in view {
        c += 1
    }
    return c
}
func ReadOnlyPts(items []Pt) int32 {
    var s int32 = 0
    let view ReadOnlySpan[Pt] = ReadOnlySpan[Pt](items)
    for p in view {
        s += p.X
    }
    return s
}
func ReadOnlyNodes(items []Node) int32 {
    var s int32 = 0
    let view ReadOnlySpan[Node] = ReadOnlySpan[Node](items)
    for n in view {
        s += n.N
    }
    return s
}
func ReadOnlyColors(items List[Color]) int32 {
    var s int32 = 0
    let view ReadOnlySpan[Color] = CollectionsMarshal.AsSpan(items)
    for c in view {
        s += int32(c)
    }
    return s
}
func ReadOnlyTuples(items List[(A int64, B object?)]) int64 {
    var s int64 = 0
    let view ReadOnlySpan[(A int64, B object)] = ReadOnlySpan[(A int64, B object)](items.ToArray())
    for t in view {
        s += t.A
    }
    return s
}
func ReadOnlyGeneric[T](items []T) int32 {
    var c int32 = 0
    let view ReadOnlySpan[T] = ReadOnlySpan[T](items)
    for x in view {
        c += 1
    }
    return c
}
func SegmentNodes(items []Node) int32 {
    var s int32 = 0
    let view ArraySegment[Node] = ArraySegment[Node](items)
    for n in view {
        s += n.N
    }
    return s
}
func SegmentPts(items []Pt) int32 {
    var s int32 = 0
    let view ArraySegment[Pt] = ArraySegment[Pt](items)
    for p in view {
        s += p.X
    }
    return s
}
func SliceNodes(items []Node) int32 {
    var s int32 = 0
    for n in items {
        s += n.N
    }
    return s
}
func SpanNodesEarlyReturn(items []Node) int32 {
    let view Span[Node] = Span[Node](items)
    for n in view {
        return n.N
    }
    return -1
}`
    }

    @Fact
    func SpanLoops_EmitVerifiableIL() {
        // CompileAndLoad runs ILVerify over the emitted assembly.
        let assembly = CompileAndLoad(SourceText())
        Assert.NotNull(assembly)
    }

    @Fact
    func SpanLoops_KeepTheirResults() {
        let assembly = CompileAndLoad(SourceText())
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(7, Invoke(program, "SpanPts", Invoke(program, "MakePts")))
        Assert.Equal(11, Invoke(program, "SpanNodes", Invoke(program, "MakeNodes")))
        Assert.Equal(107, Invoke(program, "SpanNullable", Invoke(program, "MakeNullable")))
        Assert.Equal(5, Invoke(program, "SpanColors", Invoke(program, "MakeColors")))
        Assert.Equal(int64(103), Invoke(program, "SpanTuples", Invoke(program, "MakeTuples")))
        Assert.Equal(7, Invoke(program, "ReadOnlyPts", Invoke(program, "MakePts")))
        Assert.Equal(11, Invoke(program, "ReadOnlyNodes", Invoke(program, "MakeNodes")))
        Assert.Equal(5, Invoke(program, "ReadOnlyColors", Invoke(program, "MakeColors")))
        Assert.Equal(int64(3), Invoke(program, "ReadOnlyTuples", Invoke(program, "MakeTuples")))
        Assert.Equal(11, Invoke(program, "SegmentNodes", Invoke(program, "MakeNodes")))
        Assert.Equal(7, Invoke(program, "SegmentPts", Invoke(program, "MakePts")))
        Assert.Equal(11, Invoke(program, "SliceNodes", Invoke(program, "MakeNodes")))
        Assert.Equal(5, Invoke(program, "SpanNodesEarlyReturn", Invoke(program, "MakeNodes")))
        Assert.Equal(
            3,
            GetMethod(program, "SpanGeneric").MakeGenericMethod(typeof(string)).Invoke(
                nil,
                []object{[]string{"a", "b", "c"}}
            )
        )
        Assert.Equal(
            2,
            GetMethod(program, "ReadOnlyGeneric").MakeGenericMethod(typeof(string)).Invoke(
                nil,
                []object{[]string{"a", "b"}}
            )
        )
    }

    @Fact
    func SpanLoops_CallTheViewsOwnEnumerator() {
        let assembly = CompileAndLoad(SourceText())
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        for name in[]string{"SpanNodes", "SpanPts", "ReadOnlyNodes"} {
            let calls = ReadCalls(GetMethod(program, name))
            Assert.Contains(calls, (c MethodBase) -> c.Name == "GetEnumerator" && !c.DeclaringType!!.IsInterface)
            Assert.DoesNotContain(ReadOpCodes(GetMethod(program, name)), (o OpCode) -> o == OpCodes.Box)
        }
    }

    shared {
        private func Invoke(program Type, name string, argument object? = nil) object? {
            let method = GetMethod(program, name)
            return method.Invoke(
                nil,
                if method.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{argument!!}
                }
            )
        }

        private func GetMethod(type Type, name string) MethodInfo -> type.GetMethod(
            name,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
        ) ??
            throw InvalidOperationException("Missing method ${type.FullName}.$name")

        private func ReadOpCodes(method MethodInfo)[]OpCode {
            let il = method.GetMethodBody()!!.GetILAsByteArray()
            return IlInstructionReader.Read(il).Select((i IlInstruction) -> i.OpCode).ToArray()
        }

        private func ReadCalls(method MethodInfo)[]MethodBase {
            let il = method.GetMethodBody()!!.GetILAsByteArray()
            let methodArguments = if method.IsGenericMethodDefinition {
                method.GetGenericArguments()
            } else {
                default([]Type?)
            }
            let calls = List[MethodBase]()
            for instruction in IlInstructionReader.Read(il) {
                if instruction.MetadataToken != nil &&
                    (instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt) {
                    calls.Add(method.Module.ResolveMethod(instruction.MetadataToken, nil, methodArguments))
                }
            }
            return calls.ToArray()
        }

        private func CompileAndLoad(source string) Assembly {
            let tempDir = Path.Combine(AppContext.BaseDirectory, "Issue5151Emit", Guid.NewGuid().ToString("N"))
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
