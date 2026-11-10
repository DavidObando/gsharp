// <copyright file="Issue5708GoStorageTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Linq
import Xunit

open class Issue5708GoStorageTests {
    @Theory
    @InlineData("Inc(&x)")
    @InlineData("Inc(ref x)")
    @InlineData("Out(&x)")
    @InlineData("Out(out x)")
    @InlineData("Read(in x)")
    @InlineData("Read(&x)")
    @InlineData("Read(x)")
    @InlineData("Read(42)")
    @InlineData("Inc(&(choose ? x : y))")
    @InlineData("Pair(value: 2, slot: &x)")
    @InlineData("worker.RefMethod(&x)")
    @InlineData("Worker.StaticRef(&x)")
    @InlineData("indirect(&x)")
    @InlineData("Interlocked.Increment(&x)")
    @InlineData("dict.TryGetValue(\"key\", &x)")
    @InlineData("base.RefMethod(&x)")
    func ByReferenceGoArguments_ReportGS0460AtTheCall(operand string) {
        let source = `package Issue5708
import System.Collections.Generic
import System.Threading
func Inc(ref slot int32) { slot++ }
func Out(out slot int32) { slot = 1 }
func Read(in slot int32) int32 -> slot
func Pair(ref slot int32, value int32) { slot = value }
open class Parent {
    open func RefMethod(ref slot int32) { slot++ }
}
class Worker : Parent {
    shared { func StaticRef(ref slot int32) { slot++ } }
    func Run(choose bool) {
        var x = 1
        var y = 2
        let worker = Worker()
        let dict = Dictionary[string, int32]()
        let indirect = func(ref slot int32) { slot++ }
        scope {
            go ` + operand + `
        }
    }
}
`
        let errors = BindErrors(source)
        let error = Assert.Single(errors)
        Assert.Equal("GS0460", error.Id)
        Assert.Equal(TextSpan(source.IndexOf("go ") + 3, operand.Length), error.Location.Span)
        Assert.Equal("'go' cannot capture a call with 'ref', 'out', or 'in' arguments.", error.Message)
    }

    @Theory
    @InlineData("go", "AppendRef")
    @InlineData("defer", "AppendRef")
    @InlineData("go", "AppendIn")
    @InlineData("defer", "AppendIn")
    func ByReferenceInterpolatedHandlers_ReportGS0460(keyword string, method string) {
        let operand = `ByRefHandlerHarness.` + method + `("P:", "x=${42}")`
        let source = `package Issue5708Handler
import GSharp.Core.Tests.Fixtures
` + keyword + " " + operand + "\n"
        let errors = BindErrors(source)
        let error = Assert.Single(errors)
        Assert.Equal("GS0460", error.Id)
        Assert.Equal(
            TextSpan(source.IndexOf(keyword + " " + operand) + keyword.Length + 1, operand.Length),
            error.Location.Span
        )
    }

    @Theory
    @InlineData("go")
    @InlineData("defer")
    func UnmanagedPointerArguments_AreValues(keyword string) {
        let source = `package Issue5708Pointer
unsafe func Write(pointer *int32) { *pointer = 42 }
unsafe func Run() {
    let items = []int32{0}
    ` + keyword + ` Write(&items[0])
}
`
        Assert.Empty(BindErrors(source))
    }

    @Theory
    @InlineData("go")
    @InlineData("defer")
    func UnsafeAddressAtRefParameter_ReportsGS0460(keyword string) {
        let operand = "Inc(&x)"
        let source = `package Issue5708UnsafeRef
func Inc(ref value int32) { value++ }
unsafe func Run() {
    var x = 1
    ` + keyword + " " + operand + `
}
`
        let error = Assert.Single(BindErrors(source))
        Assert.Equal("GS0460", error.Id)
        Assert.Equal(TextSpan(source.IndexOf(operand), operand.Length), error.Location.Span)
    }

    @Theory
    @InlineData("go")
    @InlineData("defer")
    func UnforwardedByReferenceHandlers_ReportGS0460(keyword string) {
        using let fixture = CSharpFixture(`namespace Handler5708 {
    public static class Api {
        public static void Use(ref System.Runtime.CompilerServices.DefaultInterpolatedStringHandler handler) {}
    }
}`)
        using let references = fixture.RuntimeReferences()
        let operand = `Api.Use("x=${42}")`
        let source = "package Issue5708BareHandler\nimport Handler5708\n" + keyword + " " + operand + "\n"
        let error = Assert.Single(BindErrors(source, references))
        Assert.Equal("GS0460", error.Id)
        Assert.Equal(TextSpan(source.IndexOf(operand), operand.Length), error.Location.Span)
    }

    @Theory
    @InlineData("go Consume(*p)", "Consume(*p)")
    @InlineData("async let r = Identity(*p)", "Identity(*p)")
    func ManagedReferenceGlobals_StillReportCaptureEscape(statement string, operand string) {
        let source = `package Issue5708ManagedGlobal
func Identity(value int32) int32 -> value
func Consume(value int32) {}
var x = 1
var p = &x
scope {
    ` + statement + `
}
`
        let error = Assert.Single(BindErrors(source))
        Assert.Equal("GS9004", error.Id)
        Assert.Equal(TextSpan(source.IndexOf(operand), operand.Length), error.Location.Span)
    }

    @Theory
    @InlineData("UseSpan(MakeSpan(), { let _ = 0 x = 1 x })", "System.ReadOnlySpan[char]", "")
    @InlineData("UseSpan(extra: 1, value: text.AsSpan())", "System.ReadOnlySpan[char]", "")
    @InlineData("UseSpan({ let s = text.AsSpan() s }, 1)", "System.ReadOnlySpan[char]", "")
    @InlineData("UseSpan(default(ReadOnlySpan[char]), 1)", "System.ReadOnlySpan[char]", "")
    @InlineData("UseSpan(spanLocal, 1)", "System.ReadOnlySpan[char]", " (variable 'spanLocal')")
    @InlineData("items.AsSpan().Clear()", "System.Span[int32]", "")
    @InlineData("default(Span[int32]).Clear()", "System.Span[int32]", "")
    @InlineData("(*&(choose ? spanA : spanB)).Clear()", "System.Span[int32]", " (variable 'spanA')")
    @InlineData("MakeWindow().Run()", "Window", "")
    @InlineData("MakeWindow().counter.Bump()", "Window", "")
    @InlineData("MakeWindow().pair.Item1.Bump()", "Window", "")
    @InlineData("worker.AcceptSpan(MakeSpan())", "System.ReadOnlySpan[char]", "")
    @InlineData("Worker.StaticAcceptSpan(MakeSpan())", "System.ReadOnlySpan[char]", "")
    @InlineData("indirectSpan(MakeSpan())", "System.ReadOnlySpan[char]", "")
    @InlineData("base.AcceptSpan(MakeSpan())", "System.ReadOnlySpan[char]", "")
    @InlineData("UseUtf8(u8\"abc\")", "System.ReadOnlySpan[uint8]", "")
    func ByRefLikeGoOperands_ReportGS0219AtTheCall(operand string, typeName string, variableSuffix string) {
        let source = `package Issue5836
import System
struct Counter {
    var n int32
    func Bump() { n++ }
}
ref struct Window {
    var counter Counter
    var pair (Counter, int32)
    func Run() {}
}
func MakeSpan() ReadOnlySpan[char] -> "abc".AsSpan()
func MakeWindow() Window -> Window{counter: Counter{}, pair: (Counter{}, 0)}
func UseSpan(value ReadOnlySpan[char], extra int32) {}
func UseUtf8(value ReadOnlySpan[byte]) {}
var x int32 = 0
open class Parent {
    open func AcceptSpan(value ReadOnlySpan[char]) {}
}
class Worker : Parent {
    shared { func StaticAcceptSpan(value ReadOnlySpan[char]) {} }
    func Run(choose bool) {
        let text = "abc"
        let spanLocal = text.AsSpan()
        let items = []int32{1}
        let other = []int32{2}
        var spanA = items.AsSpan()
        var spanB = other.AsSpan()
        let worker = Worker()
        let indirectSpan = func(value ReadOnlySpan[char]) {}
        scope {
            go ` + operand + `
        }
    }
}
`
        let errors = BindErrors(source)
        Assert.NotEmpty(errors)
        Assert.All(
            errors,
            func (error Diagnostic) {
                Assert.Equal("GS0219", error.Id)
                Assert.Equal(TextSpan(source.IndexOf("go ") + 3, operand.Length), error.Location.Span)
            }
        )
        Assert.Equal(
            "By-ref-like type '" +
                typeName +
                "' is a `ref struct` and cannot be captured by a closure" +
                variableSuffix +
                ".",
            errors[0].Message
        )
    }

    shared {
        private func BindErrors(source string, references ReferenceResolver? = nil)[]Diagnostic {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(references, tree)
            let program = Binder.BindProgram(compilation.GlobalScope, compilation.References)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(program.Diagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToArray()
        }
    }
}
