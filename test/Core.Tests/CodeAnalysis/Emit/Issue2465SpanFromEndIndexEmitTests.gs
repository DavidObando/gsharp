// <copyright file="Issue2465SpanFromEndIndexEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2465: System.Index-based access must preserve the ordinary
/// ref-returning Span indexer's value and storage semantics.
open class Issue2465SpanFromEndIndexEmitTests {
    @Fact
    func SpanAndReadOnlySpan_FromEndReads_AllElementKinds_Run() {
        const Source = `package Issue2465Reads
import System

data struct Pair { var Value int32 }
class Box { public var Value int32 = 0 }

func LastU(values Span[uint32]) uint32 -> values[^1]
func LastPair(values ReadOnlySpan[Pair]) Pair -> values[^1]
func LastBox(values Span[Box]) Box -> values[^1]
func ReadU(values []uint32) uint32 {
    var span Span[uint32] = values
    return LastU(span)
}
func ReadPair(values []Pair) Pair {
    var span = ReadOnlySpan[Pair](values)
    return LastPair(span)
}
func ReadBox(values []Box) Box {
    var span = Span[Box](values)
    return LastBox(span)
}

var us = []uint32{ 10, 20, 30 }
var ps = []Pair{ Pair{Value: 4}, Pair{Value: 9} }
var a = Box()
a.Value = 7
var b = Box()
b.Value = 13
var bs = []Box{ a, b }
Console.WriteLine(ReadU(us))
Console.WriteLine(ReadPair(ps).Value)
Console.WriteLine(ReadBox(bs).Value)`
        Assert.Equal("30${Environment.NewLine}9${Environment.NewLine}13${Environment.NewLine}", CompileAndRun(Source))
    }

    @Fact
    func Span_FromEndWritesCompoundAndIncrement_Run() {
        const Source = `package Issue2465Writes
import System

func Run(values []int32) int32 {
    var span Span[int32] = values
    span[^1] = 10
    span[^2] += 20
    span[^3]++
    span[^4]--
    return span[0] * 1000000 + span[1] * 10000 + span[2] * 100 + span[3]
}

Console.WriteLine(Run([]int32{ 1, 2, 3, 4 }))`
        Assert.Equal("32310${Environment.NewLine}", CompileAndRun(Source))
    }

    @Fact
    func Span_SystemIndexAndSideEffects_EvaluateOnce() {
        const Source = `package Issue2465Once
import System

func Pick(values Span[int32], calls []int32) Span[int32] {
    calls[0]++
    return values
}

func Next(calls []int32) int32 {
    calls[1]++
    return 1
}

func Run(values []int32, calls []int32) {
    var span Span[int32] = values
    Pick(span, calls)[^Next(calls)] += 4
    let last = Index(1, true)
    Console.WriteLine(span[last])
    span[last]--
    Console.WriteLine(span[^1])
}

var values = []int32{ 5, 6, 7 }
var calls = []int32{ 0, 0 }
Run(values, calls)
Console.WriteLine(calls[0])
Console.WriteLine(calls[1])`
        Assert.Equal(
            "11${Environment.NewLine}10${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}",
            CompileAndRun(Source)
        )
    }

    @Fact
    func ArraysListsStringsAndCustomIndexers_RemainValueReturning() {
        const Source = `package Issue2465Controls
import System
import System.Collections.Generic

class IntIndex {
    prop this[i int32] int32 -> i + 8
}

class EndIndex {
    prop this[i Index] int32 { get { return 42 } }
}

var a = []int32{ 1, 2, 3 }
var l = List[int32]()
l.Add(4)
l.Add(5)
let s = "abc"
let ii = IntIndex()
let ei = EndIndex()
Console.WriteLine(a[^1])
Console.WriteLine(l[^1])
Console.WriteLine(s[^1])
Console.WriteLine(ii[1])
Console.WriteLine(ei[^1])`
        Assert.Equal(
            "3${Environment.NewLine}5${Environment.NewLine}c${Environment.NewLine}9${Environment.NewLine}42${Environment.NewLine}",
            CompileAndRun(Source)
        )
    }

    @Fact
    func SpanFromEndRead_ReflectionReturnTypesAreElements() {
        const Source = `package Issue2465Metadata
import System

data struct Pair { var Value int32 }

func LastU(values Span[uint32]) uint32 -> values[^1]
func LastPair(values ReadOnlySpan[Pair]) Pair -> values[^1]`
        let assembly = Compile(Source, "SpanFromEndRead_ReflectionReturnTypesAreElements")
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(typeof(uint32), program.GetMethod("LastU")!!.ReturnType)
        Assert.Equal("Issue2465Metadata.Pair", program.GetMethod("LastPair")!!.ReturnType.FullName)
        Assert.False(program.GetMethod("LastU")!!.ReturnType.IsByRef)
        Assert.False(program.GetMethod("LastPair")!!.ReturnType.IsByRef)
    }

    @Fact
    func SpanFromEnd_AddressContextRetainsReference() {
        const Source = `package Issue2465Address
import System

unsafe func Update(values []int32) int32 {
    var span Span[int32] = values
    var pointer *int32 = &span[^1]
    *pointer = 19
    return span[^1]
}

Console.WriteLine(Update([]int32{ 1, 2, 3 }))`
        Assert.Equal("19${Environment.NewLine}", CompileAndRun(Source))
    }

    @Fact
    func ReadOnlySpan_FromEndWrite_RemainsRejected() {
        const Source = `package Issue2465ReadOnly
import System

func Update(values []int32) {
    var span ReadOnlySpan[int32] = values
    span[^1] = 9
}`
        using let peStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(Source)))
        let result = compilation.Emit(peStream)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0226")
    }

    @Fact
    func SpanFromEnd_ZeroPreservesBoundsException() {
        const Source = `package Issue2465Bounds
import System

func Read(values []int32) int32 {
    var span Span[int32] = values
    return span[^0]
}

Console.WriteLine(Read([]int32{ 1, 2, 3 }))`
        let exception = Assert.Throws[TargetInvocationException](
            func () object? {
                return CompileAndRun(Source)
            }
        )
        Assert.IsType[IndexOutOfRangeException](exception.InnerException)
    }

    shared {
        private func CompileAndRun(source string) string {
            let assembly = Compile(source, Guid.NewGuid().ToString("N"))
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(entry)
            let originalOut = Console.Out
            using let captured = StringWriter()
            Console.SetOut(captured)
            try {
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
            } finally {
                Console.SetOut(originalOut)
            }
            return captured.ToString().ReplaceLineEndings(Environment.NewLine)
        }

        private func Compile(source string, contextName string) Assembly {
            using let peStream = MemoryStream()
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> "${d.Id}: ${d.Message}")
                )
            )
            peStream.Position = 0
            let context = AssemblyLoadContext(contextName, isCollectible: true)
            return context.LoadFromStream(peStream)
        }
    }
}
