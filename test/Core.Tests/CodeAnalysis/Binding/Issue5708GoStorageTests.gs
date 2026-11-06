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
