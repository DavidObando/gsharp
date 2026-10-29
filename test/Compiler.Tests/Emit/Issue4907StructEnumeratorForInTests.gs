// <copyright file="Issue4907StructEnumeratorForInTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Threading.Tasks
import GSharp.Compiler
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #4907: `for x in coll` over an imported generic collection whose type
/// arguments are symbolic (a same-compilation type, an in-scope type
/// parameter, a named tuple) used to call `IEnumerable<T>.GetEnumerator()`,
/// which boxes the collection's struct enumerator on every loop. The loop now
/// calls the collection's own `GetEnumerator()` and drives the struct
/// enumerator through managed pointers, as C# does.
open class Issue4907StructEnumeratorForInTests {
    private func SourceText() string {
        return `package P
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Threading.Tasks

struct Pt { var X int32 }
class Node { var N int32 }

func MakePts() List[Pt] {
    var l = List[Pt]()
    l.Add(Pt{X: 3})
    l.Add(Pt{X: 4})
    return l
}
func MakeNodes() List[Node] {
    var l = List[Node]()
    l.Add(Node{N: 5})
    l.Add(Node{N: 6})
    return l
}
func MakeNullableNodes() List[Node?] {
    var l = List[Node?]()
    l.Add(Node{N: 7})
    l.Add(nil)
    return l
}
func MakeImm() ImmutableArray[Node] -> ImmutableArray.Create[Node](Node{N: 8}, Node{N: 9})
func MakeDict() Dictionary[string, Node] {
    var d = Dictionary[string, Node]()
    d["ab"] = Node{N: 10}
    d["c"] = Node{N: 20}
    return d
}
func MakeSet() HashSet[Node] {
    var h = HashSet[Node]()
    h.Add(Node{N: 11})
    return h
}
func MakeTuples() List[(A int64, B object?)] {
    var l = List[(A int64, B object?)]()
    l.Add((A: 1, B: nil))
    l.Add((A: 2, B: "x"))
    return l
}

func SumPts(l List[Pt]) int32 {
    var s int32 = 0
    for p in l {
        s += p.X
    }
    return s
}
func SumNodes(l List[Node]) int32 {
    var s int32 = 0
    for p in l {
        s += p.N
    }
    return s
}
func CountNils(l List[Node?]) int32 {
    var s int32 = 0
    for p in l {
        if p == nil {
            s += 100
        } else {
            s += p.N
        }
    }
    return s
}
func SumImm(l ImmutableArray[Node]) int32 {
    var s int32 = 0
    for p in l {
        s += p.N
    }
    return s
}
func SumDictPairs(d Dictionary[string, Node]) int32 {
    var s int32 = 0
    for k, v in d {
        s += v.N + int32(k.Length)
    }
    return s
}
func SumDictEntries(d Dictionary[string, Node]) int32 {
    var s int32 = 0
    for kv in d {
        s += kv.Value.N
    }
    return s
}
func SumSet(h HashSet[Node]) int32 {
    var s int32 = 0
    for n in h {
        s += n.N
    }
    return s
}
func CountGeneric[T](l List[T]) int32 {
    var c int32 = 0
    for x in l {
        c += 1
    }
    return c
}
func SumTuples(l List[(A int64, B object?)]) int64 {
    var c int64 = 0
    for x in l {
        c += x.A
        if x.B == nil {
            c += 100
        }
    }
    return c
}
func AddWhileIterating(l List[Node]) {
    for n in l {
        l.Add(Node{N: 1})
    }
}
func ReturnFromLoop(l List[Node]) int32 {
    for n in l {
        return n.N
    }
    return -1
}
func LoopMany(l List[Node], times int32) int32 {
    var s int32 = 0
    var i int32 = 0
    while i < times {
        for n in l {
            s += n.N
        }
        i += 1
    }
    return s
}
func SpanLoop(items []int32) int32 {
    var s int32 = 0
    let view Span[int32] = Span[int32](items)
    for n in view {
        s += n
    }
    return s
}
func IterNodes(l List[Node]) sequence[int32] {
    for n in l {
        yield n.N
    }
}
func IterGeneric[T](l List[T]) sequence[T] {
    for x in l {
        yield x
    }
}
async func AwaitSum(l List[Node]) Task[int32] {
    var s int32 = 0
    for n in l {
        await Task.Yield()
        s += n.N
    }
    return s
}
async func AwaitSumDict(d Dictionary[string, Node]) Task[int32] {
    var s int32 = 0
    for k, v in d {
        await Task.Yield()
        s += v.N
    }
    return s
}
func SequenceLoop(items sequence[Node]) int32 {
    var s int32 = 0
    for n in items {
        s += n.N
    }
    return s
}`
    }

    @Fact
    func Loops_UseTheStructEnumerator_WithoutBoxingOrInterfaceDispatch() {
        let assembly = CompileAndLoad(SourceText())
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        for name in[]string{
            "SumPts",
            "SumNodes",
            "CountNils",
            "SumImm",
            "SumDictPairs",
            "SumDictEntries",
            "SumSet",
            "CountGeneric",
            "SumTuples",
            "LoopMany"
        } {
            let calls = ReadCalls(GetMethod(program, name))
            Assert.True(
                calls.Any((c MethodBase) -> c.Name == "GetEnumerator" && !c.DeclaringType!!.IsInterface),
                "$name: expected a direct GetEnumerator() on the collection"
            )
            let moveNext = calls.Where((c MethodBase) -> c.Name == "MoveNext").ToArray()
            Assert.NotEmpty(moveNext)
            Assert.True(
                moveNext.All((c MethodBase) -> c.DeclaringType!!.IsValueType),
                "$name: MoveNext must be called on the struct enumerator, not an interface"
            )
            Assert.DoesNotContain(
                calls,
                (c MethodBase) -> c.DeclaringType!!.IsInterface && c.DeclaringType!!.Name.StartsWith("IEnumer")
            )
            Assert.DoesNotContain(ReadOpCodes(GetMethod(program, name)), (o OpCode) -> o == OpCodes.Box)
        }
    }

    @Fact
    func ListLoop_DisposesTheStructEnumeratorWithoutBoxing() {
        let assembly = CompileAndLoad(SourceText())
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let calls = ReadCalls(GetMethod(program, "SumNodes"))
        let dispose = Assert.Single(calls, (c MethodBase) -> c.Name == "Dispose")
        Assert.True(dispose.DeclaringType!!.IsValueType)
    }

    @Fact
    func Loops_KeepTheirResults() {
        let assembly = CompileAndLoad(SourceText())
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(7, Invoke(program, "SumPts", Invoke(program, "MakePts")))
        Assert.Equal(11, Invoke(program, "SumNodes", Invoke(program, "MakeNodes")))
        Assert.Equal(107, Invoke(program, "CountNils", Invoke(program, "MakeNullableNodes")))
        Assert.Equal(17, Invoke(program, "SumImm", Invoke(program, "MakeImm")))
        Assert.Equal(33, Invoke(program, "SumDictPairs", Invoke(program, "MakeDict")))
        Assert.Equal(30, Invoke(program, "SumDictEntries", Invoke(program, "MakeDict")))
        Assert.Equal(11, Invoke(program, "SumSet", Invoke(program, "MakeSet")))
        Assert.Equal(
            2,
            GetMethod(program, "CountGeneric").MakeGenericMethod(typeof(string)).Invoke(
                nil,
                []object{List[string](){"a", "b"}}
            )
        )
        Assert.Equal(int64(103), Invoke(program, "SumTuples", Invoke(program, "MakeTuples")))
        Assert.Equal(5, Invoke(program, "ReturnFromLoop", Invoke(program, "MakeNodes")))
    }

    @Fact
    func MutatingTheListWhileIterating_StillThrows() {
        let assembly = CompileAndLoad(SourceText())
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let failure = Assert.Throws[TargetInvocationException](
            () -> Invoke(program, "AddWhileIterating", Invoke(program, "MakeNodes"))
        )
        Assert.IsType[InvalidOperationException](failure.InnerException)
    }

    @Fact
    func LoopsInsideIteratorsAndAsyncMethods_KeepWorking() {
        let assembly = CompileAndLoad(SourceText())
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let iterated = Assert.IsAssignableFrom[IEnumerable[int32]](
            Invoke(program, "IterNodes", Invoke(program, "MakeNodes"))
        )
        Assert.Equal([]int32{5, 6}, iterated.ToArray())
        let generic = GetMethod(program, "IterGeneric").MakeGenericMethod(typeof(string))
        let letters = Assert.IsAssignableFrom[IEnumerable[string]](
            generic.Invoke(nil, []object{List[string](){"a", "b"}})
        )
        Assert.Equal([]string{"a", "b"}, letters.ToArray())
        let awaited = Assert.IsAssignableFrom[Task[int32]](Invoke(program, "AwaitSum", Invoke(program, "MakeNodes")))
        Assert.Equal(11, awaited.GetAwaiter().GetResult())
        let awaitedDict = Assert.IsAssignableFrom[Task[int32]](
            Invoke(program, "AwaitSumDict", Invoke(program, "MakeDict"))
        )
        Assert.Equal(30, awaitedDict.GetAwaiter().GetResult())
    }

    @Fact
    func SpanAndSequenceLoops_KeepTheirPaths() {
        let assembly = CompileAndLoad(SourceText())
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(6, Invoke(program, "SpanLoop", []int32{1, 2, 3}))
        // `sequence[T]` keeps the interface route: it has no struct enumerator.
        let calls = ReadCalls(GetMethod(program, "SequenceLoop"))
        Assert.Contains(calls, (c MethodBase) -> c.Name == "GetEnumerator" && c.DeclaringType!!.IsInterface)
    }

    @Fact
    func RepeatedLoops_DoNotAllocateAnEnumeratorPerLoop() {
        let assembly = CompileAndLoad(SourceText())
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let list = Invoke(program, "MakeNodes")
        let loopMany = GetMethod(program, "LoopMany")
        let arguments = []object{list, 20_000}
        loopMany.Invoke(nil, arguments)
        let before = GC.GetAllocatedBytesForCurrentThread()
        loopMany.Invoke(nil, arguments)
        let allocated = GC.GetAllocatedBytesForCurrentThread() - before
        // A boxed List<T>.Enumerator is 48 bytes per loop: 960,000 bytes here.
        Assert.True(allocated < 20_000, "allocated $allocated bytes over 20000 loops")
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
            let tempDir = Path.Combine(AppContext.BaseDirectory, "Issue4907Emit", Guid.NewGuid().ToString("N"))
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
