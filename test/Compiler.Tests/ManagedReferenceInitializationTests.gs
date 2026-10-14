// <copyright file="ManagedReferenceInitializationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import Gsharp.Values
import System
import System.IO
import System.Linq
import Xunit

class ManagedReferenceInitializationTests {
    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    func SameCompilationEmitsTwiceWithoutMutatingInitializers(firstRefout bool, secondRefout bool) {
        using let references = ReferenceResolver.WithRuntimeReferences(
            []string{typeof(ManagedRef[_]).Assembly.Location}
        )
        let compilation = Compilation(references, SyntaxTree.Parse(Source)){IsLibrary = true}
        let bound = compilation.BoundProgram
        Assert.Empty(bound.Diagnostics.Where((d Diagnostic) -> d.IsError))
        let holder = Assert.Single(bound.Structs, (type StructSymbol) -> type.Name == "Holder")
        let original = holder.InstanceFieldInitializers
        let originalBase BaseConstructorInitializer? = holder.BaseConstructorInitializer
        for refout in[]bool{firstRefout, secondRefout} {
            using let pe = MemoryStream()
            using let reference = MemoryStream()
            let result = compilation.Emit(
                pe,
                nil,
                if refout {
                    reference
                } else {
                    default(MemoryStream?)
                }
            )
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            Assert.Same(original, holder.InstanceFieldInitializers)
            Assert.Same(originalBase, holder.BaseConstructorInitializer)
            let assembly = EmittedFixture.Load(pe.ToArray())
            Assert.Equal(57, assembly.GetType("ManagedInitializers.Probe")!!.GetMethod("Run")!!.Invoke(nil, nil))
            if refout {
                Assert.True(reference.Length > int64(0))
            }
        }
    }

    @Fact
    func InitializerOwnersVerifyThroughRealDriver() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(Source + `
func Main() { Console.WriteLine(Probe.Run()) }
`, "ManagedInitializers", true)
        IlVerifier.Verify(dll)
        Assert.Equal("57\n", fixture.Run(dll))
    }

    @Fact
    func NamedConstructorOrderingAndExplicitParameterIdentityRemainUnchanged() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ManagedConstructorOrder
import System
class Trace {
    shared {
        var Text string = ""
        func Mark(text string) int32 {
            Text += text
            return 0
        }
    }
}
open class Parent {
    var Saved readonly managed[int32]
    init(saved readonly managed[int32], marker int32) {
        this.Saved = saved
        Trace.Mark("B")
    }
}
class Child : Parent {
    var Other readonly managed[int32]
    var Marker int32 = Trace.Mark("F")
    init(value int32) : Parent(readonly managed(value), Trace.Mark("A")) {
        this.Other = readonly managed(value)
        Trace.Mark("C")
    }
}
func Main() {
    let child = Child(42)
    Console.WriteLine(Trace.Text)
    Console.WriteLine(child.Saved.SameLocation(child.Other))
    Console.WriteLine(*child.Other)
}`, "ManagedConstructorOrder", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`ABFC
True
42
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("interface Bad { shared { var Value managed[int32] } }")
    @InlineData(
        "open class Base(Value managed[int32]) { }\nclass Bad : Base { init(scoped p managed[int32]) : Base(p) { } }"
    )
    @InlineData("class Bad { shared { var Value int32 = 1\nvar Pointer managed[int32] = managed(Value) } }")
    func OutOfBodyContractsRejectEscapesAndUninitializedStorage(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile("package ManagedInitializerReject\n" + declaration, "bad", false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("error GS0604:", StringComparison.Ordinal), output)
    }

    shared {
        private const Source string = `package ManagedInitializers
import System
open class Base[T](Saved readonly managed[T]) { }
class Holder[T](Value T) : Base[T](readonly managed(Value)) {
    var Other readonly managed[T] = readonly managed(Value)
    var Reader () -> T = func () T { return Value }
    var Local managed[int32] = {
        const initial = 2
        var local = initial
        let ref early = local
        let pointer = managed(local)
        early = 7
        pointer
    }
    func Same() bool { return this.Saved.SameLocation(this.Other) }
}
interface Shared {
    shared {
        var Value managed[int32] = {
            var local = 9
            managed(local)
        }
    }
}
interface GenericShared[T] {
    shared {
        var Value readonly managed[T] = {
            var local T = default
            readonly managed(local)
        }
    }
}
class Probe {
    shared {
        func Run() int32 {
            var original = 41
            let holder = Holder[int32](original)
            original = 99
            if !holder.Same() { return -1 }
            if holder.Reader() != 41 { return -2 }
            return *holder.Other + *holder.Local + *Shared.Value + *GenericShared[int32].Value
        }
    }
}`
    }
}
