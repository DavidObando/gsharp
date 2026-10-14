// <copyright file="Issue2243AnonymousClassEmitTests.cs" company="GSharp">
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

/// ADR-0146 (issue #2243): end-to-end emission of the richer anonymous-object
/// literal. A `data object { ... }` reuses the value-type
/// data-struct pipeline (Equals/GetHashCode/ToString/with). A plain
/// `object : Interface { ... }` / `object : Base(args) { ... }` with
/// methods or events is desugared to a synthesized reference-type class routed
/// through the ordinary named-class binder/emitter (interface-implementation
/// verification, virtual/override checking, TypeDef/MethodDef emission) — no
/// bespoke emission code. These tests exercise that the emitted IL actually
/// runs.
open class Issue2243AnonymousClassEmitTests {
    @Fact
    func ImplementsInterface_MethodCallableThroughInterfaceReference_EmitsAndRuns() {
        const source = `package Corpus.Issue2243

import System

interface MouseListener {
    func onClick() string;
    func onHover() string;
}

let listener = object : MouseListener {
    func onClick() string -> "Button clicked!"
    func onHover() string -> "Button hovered!"
}
Console.WriteLine(listener.onClick())
Console.WriteLine(listener.onHover())
let asIface MouseListener = listener
Console.WriteLine(asIface.onClick())`
        let output = CompileAndRun("Issue2243Interface", source)
        let lines = output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal("Button clicked!", lines[0])
        Assert.Equal("Button hovered!", lines[1])
        Assert.Equal("Button clicked!", lines[2])
    }

    @Fact
    func ExtendsBaseClass_OverriddenMethodRuns_EmitsAndRuns() {
        const source = `package Corpus.Issue2243

import System

open class Animal(Name string) {
    open func SaySomething() string -> "generic"
}

let dog = object : Animal("Fluffy") {
    override func SaySomething() string -> "woof!"
}
Console.WriteLine(dog.SaySomething())`
        let output = CompileAndRun("Issue2243Base", source)
        Assert.Equal("woof!", output.Trim())
    }

    @Fact
    func DataObject_With_ProducesIndependentCopy_EmitsAndRuns() {
        const source = `package Corpus.Issue2243

import System

let mydata = data object { let Name = "David"; let Language = "GSharp" }
let other = mydata with { Name = "Amelia" }
Console.WriteLine(mydata.Name)
Console.WriteLine(other.Name)
Console.WriteLine(other.Language)`
        let output = CompileAndRun("Issue2243With", source)
        let lines = output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal("David", lines[0])
        Assert.Equal("Amelia", lines[1])
        Assert.Equal("GSharp", lines[2])
    }

    @Fact
    func RichObject_InferredFieldAndLexicalCapture_EmitsAndRuns() {
        const source = `package Corpus.Issue4329

import System

interface Reader { func Read() int32; }
let value = 40
let reader = object : Reader {
    let Snapshot = value + 1
    func Read() int32 -> value + Snapshot
}
Console.WriteLine(reader.Snapshot)
Console.WriteLine(reader.Read())`
        let output = CompileAndRun("Issue4329Capture", source)
        let lines = output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal("41", lines[0])
        Assert.Equal("81", lines[1])
    }

    @Fact
    func RichObject_BaseArgumentsAndFields_AreEvaluatedAtLiteralSite() {
        const source = `package Corpus.Issue4329

import System

open class Base(Value int32) {
    open func Read() int32 -> Value
}

let seed = 20
let reader = object : Base(seed + 1) {
    let Extra = seed + 2
    override func Read() int32 -> base.Read() + Extra
}
Console.WriteLine(reader.Read())`
        let output = CompileAndRun("Issue4329Base", source)
        Assert.Equal("43", output.Trim())
    }

    @Fact
    func RichObject_BaseVirtualCallSeesSnapshotAndCaptureEnvironment() {
        const source = `package Corpus.Issue4329

import System

open class Base {
    var Observed int32
    init() { Observed = Read() }
    open func Read() int32 -> -1
}

var value = 40
let reader = object : Base() {
    let Snapshot = value + 2
    override func Read() int32 -> value + Snapshot
}
Console.WriteLine(reader.Observed)
value = 41
Console.WriteLine(reader.Read())`
        let output = CompileAndRun("Issue4329BaseVirtual", source)
        Assert.Equal(`82
83
`.Replace("\n", Environment.NewLine), output)
    }

    @Fact
    func RichObject_CaptureRetentionPreservesConstructionOrderAndExceptions() {
        const source = `package Corpus.Issue4512

import System

var Trace = ""

func Mark(name string, value int32, fail string) int32 {
    Trace += name
    if name == fail { throw InvalidOperationException(name) }
    return value
}

open class Base {
    var Value int32
    var Observed int32
    init(value int32, fail string) {
        Value = value
        Mark("B", 0, fail)
        Observed = Read()
    }
    open func Read() int32 -> Value
}

func Make(fail string) Base {
    var captured = 40
    return object : Base(Mark("A", 1, fail), fail) {
        let Snapshot = Mark("S", 2, fail)
        override func Read() int32 {
            Trace += "V"
            return captured + Snapshot
        }
    }
}

let value = Make("")
Console.WriteLine(Trace + ":" + value.Observed.ToString())
Trace = ""
try {
    Make("A")
} catch (InvalidOperationException) {
    Console.WriteLine(Trace)
}
Trace = ""
try {
    Make("S")
} catch (InvalidOperationException) {
    Console.WriteLine(Trace)
}
Trace = ""
try {
    Make("B")
} catch (InvalidOperationException) {
    Console.WriteLine(Trace)
}`
        let output = CompileAndRun("Issue4512Order", source)
        Assert.Equal(`ASBV:42
A
AS
ASB
`.Replace("\n", Environment.NewLine), output)
    }

    @Fact
    func StructuralAdaptation_ForwardsAndAllocatesFreshWrapper() {
        const source = `package Corpus.Issue4329

import System

interface Reader { func Read() int32; }
class Source(Value int32) { func Read() int32 -> Value }

let source = Source(42)
let first = adapt[Reader](source)
let second = adapt[Reader](source)
Console.WriteLine(first.Read())
Console.WriteLine(Object.ReferenceEquals(first, source))
Console.WriteLine(Object.ReferenceEquals(first, second))
Console.WriteLine(first.GetType() == source.GetType())`
        let output = CompileAndRun("Issue4329Adapt", source)
        Assert.Equal(
            "42" +
                Environment.NewLine +
                "False" +
                Environment.NewLine +
                "False" +
                Environment.NewLine +
                "False" +
                Environment.NewLine,
            output
        )
    }

    @Fact
    func StructuralAdaptation_ForwardsPropertyAccessors() {
        const source = `package Corpus.Issue4329

import System

interface Box { prop Value int32 { get; set; } }
class Source {
    var storage int32
    prop Value int32 { get -> storage; set { storage = value } }
}

let adapted = adapt[Box](Source())
adapted.Value = 17
Console.WriteLine(adapted.Value)`
        let output = CompileAndRun("Issue4329AdaptProperty", source)
        Assert.Equal("17", output.Trim())
    }

    @Fact
    func StructuralAdaptation_MutableStructOwnsOnePersistentCopy() {
        const source = `package Corpus.Issue4329

import System

interface Counter { func Increment(); func Read() int32; }
struct Source {
    var Value int32
    func Increment() { Value += 1 }
    func Read() int32 -> Value
}

var original = Source{Value: 1}
let adapted = adapt[Counter](original)
adapted.Increment()
adapted.Increment()
Console.WriteLine(adapted.Read())
Console.WriteLine(original.Value)`
        let output = CompileAndRun("Issue4329AdaptStruct", source)
        Assert.Equal("3" + Environment.NewLine + "1" + Environment.NewLine, output)
    }

    @Fact
    func StructuralAdaptation_ForwardsEventAddAndRemove() {
        const source = `package Corpus.Issue4329

import System

interface Changes { event Changed (int32) -> void }
class Source {
    event Changed (int32) -> void
    func Raise(value int32) { Changed(value) }
}

var observed = 0
let source = Source()
let adapted = adapt[Changes](source)
let removed = (value int32) -> { observed = value }
let retained = (value int32) -> { observed = value + 100 }
adapted.Changed += removed
adapted.Changed += retained
adapted.Changed -= removed
source.Raise(10)
Console.WriteLine(observed)`
        let output = CompileAndRun("Issue4329AdaptEvent", source)
        Assert.Equal("110", output.Trim())
    }

    @Fact
    func StructuralAdaptation_ForwardsGenericInheritedAndDefaultMethods() {
        const source = `package Corpus.Issue4329

import System

interface BaseReader { func Read() int32; }
interface Reader : BaseReader {
    func Identity[T](value T) T;
    func Label() string { return "default" }
}
class Source {
    func Read() int32 -> 42
    func Identity[T](value T) T -> value
}

let adapted = adapt[Reader](Source())
Console.WriteLine(adapted.Read())
Console.WriteLine(adapted.Identity[string]("generic"))
Console.WriteLine(adapted.Label())`
        let output = CompileAndRun("Issue4329AdaptGeneric", source)
        Assert.Equal(
            "42" + Environment.NewLine + "generic" + Environment.NewLine + "default" + Environment.NewLine,
            output
        )
    }

    @Fact
    func StructuralAdaptation_RefResultRemainsLiveAlias() {
        const source = `package Corpus.Issue4329

import System

interface Slots { func Slot() ref int32; }
class Source {
    var Value int32
    func Slot() ref int32 { return ref Value }
}

func Run() {
    let source = Source()
    let adapted = adapt[Slots](source)
    let ref alias = adapted.Slot()
    alias = 23
    Console.WriteLine(source.Value)
}
Run()`
        let output = CompileAndRun("Issue4329AdaptRef", source)
        Assert.Equal("23", output.Trim())
    }

    @Fact
    func StructuralAdaptation_ForwardsIndexerAccessors() {
        const source = `package Corpus.Issue4329

import System

interface Values { prop this[index int32] int32 { get; set; } }
class Source {
    var items []int32 = []int32{1, 2, 3}
    prop this[index int32] int32 {
        get -> items[index]
        set { items[index] = value }
    }
}

let adapted = adapt[Values](Source())
adapted[1] = 17
Console.WriteLine(adapted[1])`
        let output = CompileAndRun("Issue4329AdaptIndexer", source)
        Assert.Equal("17", output.Trim())
    }

    @Fact
    func StructuralAdaptation_EvaluatesSourceOnceAndDoesNotRetarget() {
        const source = `package Corpus.Issue4329

import System

interface Reader { func Read() int32; }
class Source(Value int32) { func Read() int32 -> Value }

var evaluations = 0
func Make() Source {
    evaluations += 1
    return Source(evaluations)
}

var current = Source(5)
let retained = adapt[Reader](current)
current = Source(9)
let evaluated = adapt[Reader](Make())
Console.WriteLine(retained.Read())
Console.WriteLine(evaluations)
Console.WriteLine(evaluated.Read())`
        let output = CompileAndRun("Issue4329AdaptEvaluation", source)
        Assert.Equal(`5
1
1
`.Replace("\n", Environment.NewLine), output)
    }

    @Fact
    func CapturingRichObjectsAndAdaptersSupportRepeatedCompilationEmit() {
        const source = `package Corpus.Issue4329
interface Reader { func Read() int32; }
class Source(Value int32) { func Read() int32 -> Value }
func Build(value int32) Reader {
    let rich = object : Reader {
        let Snapshot = value
        func Read() int32 -> value + Snapshot
    }
    let adapted = adapt[Reader](Source(rich.Read()))
    return adapted
}`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        using let first = MemoryStream()
        using let second = MemoryStream()
        let firstResult = compilation.Emit(first)
        let secondResult = compilation.Emit(second)
        Assert.True(firstResult.Success, string.Join("; ", firstResult.Diagnostics.Select((d Diagnostic) -> d.Message)))
        Assert.True(
            secondResult.Success,
            string.Join("; ", secondResult.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        Assert.Equal(first.ToArray(), second.ToArray())
    }

    shared {
        /// Compiles and emits [`source`](paramref), loads the resulting PE,
        /// invokes its entry point, and returns captured console output.
        /// @param contextName The collectible load-context name.
        /// @param source The G# source to compile.
        /// @returns The captured console output.
        private func CompileAndRun(contextName string, source string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
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
                } catch (ex TargetInvocationException) when ex.InnerException is AggregateException agg {
                    throw agg.InnerException ?? agg
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
