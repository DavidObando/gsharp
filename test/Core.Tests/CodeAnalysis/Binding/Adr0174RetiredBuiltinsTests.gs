// <copyright file="Adr0174RetiredBuiltinsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Immutable
import System.Linq
import System.Text
import Xunit

/// ADR-0174 D12/D13: the Go-style built-ins `len`, `cap`,
/// `append`, `delete` and `close` are retired. A bare call
/// reports GS0566 at the call, and the guidance names the member the operand
/// actually has — computed for the site, so pasting it in place of the
/// retired call compiles clean (the Phase 2 gate). The names stay free for
/// users: a user-defined function of the same name is an ordinary call. The
/// `Gsharp.Extensions.Go` gate is gone with them — no import is needed
/// for any channel program, and the old import is an ordinary unresolved
/// import.
/// @remarks Discrimination witness (ADR-0154): a mutant that reports GS0566 before
/// consulting the scope breaks (cref:UserDefinedLen_Wins); a mutant
/// that names `.Length` for every receiver breaks
/// (cref:Len_OnMap_NamesCount) and (cref:Len_OnChannel_NamesLengthMethod),
/// whose replacements would then fail to compile in
/// (cref:EveryReplacement_CompilesClean).
open class Adr0174RetiredBuiltinsTests {
    @Theory
    @InlineData("len(xs)", "use 'xs.Length' instead.")
    @InlineData("cap(xs)", "'xs.Length'")
    @InlineData("append(xs, 4)", "call 'xs.Add(4)' instead.")
    func SliceBuiltins_ReportGS0566_AtTheCall(call string, guidance string) {
        let source = (`package P
func main() {
    var xs = []int32{1, 2, 3}
    let r = ` + "$call" + `
}`)
        let (diagnostics, _) = Bind(source)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0566", diagnostic.Id)
        Assert.Contains(guidance, diagnostic.Message)
        Assert.Equal(call, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func Len_OnMap_NamesCount() {
        let (diagnostics, _) = Bind(`package P
func main() {
    let m = map[string, int32]{"a": 1}
    let n = len(m)
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0566", diagnostic.Id)
        Assert.Contains("use 'm.Count' instead.", diagnostic.Message)
    }

    @Fact
    func Delete_OnMap_NamesRemove() {
        let (diagnostics, _) = Bind(`package P
func main() {
    let m = map[string, int32]{"a": 1}
    delete(m, "a")
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0566", diagnostic.Id)
        Assert.Contains("use 'm.Remove(\"a\")' instead.", diagnostic.Message)
    }

    @Fact
    func Len_OnChannel_NamesLengthMethod() {
        let (diagnostics, _) = Bind(`package P
func main() {
    let ch = chan[int32](2)
    let n = len(ch)
    let c = cap(ch)
}`)
        Assert.Equal(2, diagnostics.Length)
        Assert.All(diagnostics, (d Diagnostic) -> Assert.Equal("GS0566", d.Id))
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("use 'ch.Length()' instead."))
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("use 'ch.Capacity' instead."))
    }

    @Fact
    func Close_NamesTheMember() {
        let (diagnostics, _) = Bind(`package P
func main() {
    let ch = chan[int32](1)
    close(ch)
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0566", diagnostic.Id)
        Assert.Contains("use 'ch.Close()' instead.", diagnostic.Message)
    }

    @Fact
    func EveryReplacement_CompilesClean() {
        let result = EmittedOracle.Evaluate(`package P0174Replacements
import System.Collections.Generic
let xs = []int32{1, 2, 3}
let m = map[string, int32]{"a": 1, "b": 2}
let ch = chan[int32](2)
ch <- 1
let grown = List[int32]()
grown.Add(4)
m.Remove("a")
let total = xs.Length * 1000 + m.Count * 100 + ch.Length() * 10 + ch.Capacity + grown[0]
ch.Close()
total`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3116, result.Value)
    }

    @Fact
    func UserDefinedLen_Wins() {
        let result = EmittedOracle.Evaluate(`package P0174UserLen
func len(xs []int32) int32 {
    return xs.Length * 10
}
let xs = []int32{1, 2, 3}
len(xs)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(30, result.Value)
    }

    @Fact
    func UserDefinedClose_Wins() {
        let result = EmittedOracle.Evaluate(`package P0174UserClose
func close(door string) string {
    return door + " closed"
}
close("front")`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("front closed", result.Value)
    }

    @Theory
    @InlineData("close")
    @InlineData("len")
    @InlineData("cap")
    @InlineData("append")
    @InlineData("delete")
    func CallableParameter_Wins(name string) {
        AssertCalledOnce(`import System
func Call(CALLABLE Action) { CALLABLE() }
func Main() {
    var called = 0
    Call(() -> {
        called += 1
        Console.WriteLine("called")
    })
    Console.WriteLine(called)
}`.Replace("CALLABLE", name))
    }

    @Theory
    @InlineData("() -> close()")
    @InlineData("() -> { close() }")
    func CapturedCloseParameter_InNestedCallback_Wins(callback string) {
        AssertCalledOnce(`import System
func Run(callback Action) { callback() }
func Call(close Action) { Run(CALLBACK) }
func Main() {
    var called = 0
    Call(() -> {
        called += 1
        Console.WriteLine("called")
    })
    Console.WriteLine(called)
}`.Replace("CALLBACK", callback))
    }

    @Theory
    @InlineData("Action")
    @InlineData("() -> void")
    @InlineData("Callback")
    func CapturedCallableLocal_Wins(typeName string) {
        AssertCalledOnce(`import System
delegate Callback();
func Main() {
    var called = 0
    let close CALLABLE_TYPE = () -> {
        called += 1
        Console.WriteLine("called")
    }
    let callback Action = () -> close()
    callback()
    Console.WriteLine(called)
}`.Replace("CALLABLE_TYPE", typeName))
    }

    @Theory
    @InlineData("() -> void", "close(1)", "GS0144")
    @InlineData("int32", "close()", "GS0131")
    func ShadowingVariable_InvalidCall_ReportsOrdinaryDiagnostic(typeName string, call string, diagnosticId string) {
        let source = `func Call(close CALLABLE_TYPE) { CALL }`.Replace("CALLABLE_TYPE", typeName).Replace("CALL", call)
        let (diagnostics, _) = Bind(source)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal(diagnosticId, diagnostic.Id)
        Assert.Equal(source.LastIndexOf("close", StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Equal("close".Length, diagnostic.Location.Span.Length)
    }

    @Fact
    func ChannelProgram_NeedsNoImport() {
        let result = EmittedOracle.Evaluate(`package P0174NoImport
func produce(w out chan[int32]) {
    w <- 20
    w <- 22
    w.Close()
}
let ch = chan[int32](2)
go produce(ch)
var sum = 0
for v in ch {
    sum = sum + v
}
sum`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func GoExtensionsNamespace_NoLongerExists() {
        // An import of a namespace nothing declares is accepted silently (it
        // is how a project imports a namespace a later reference will
        // supply), so the observable fact is that the marker type the
        // namespace used to carry is gone — and that no gate diagnostic
        // fires for the import.
        let (diagnostics, _) = Bind(`package P
import Gsharp.Extensions.Go
func main() {
    let marker = GoExtensions()
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Contains("GoExtensions", diagnostic.Message)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> (d.Id is "GS0316" or "GS0317"))
    }

    shared {
        private func AssertCalledOnce(source string) {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics)
            Assert.Equal(0, result.ExitCode)
            Assert.Empty(result.ErrorOutput)
            Assert.Equal(
                Encoding.UTF8.GetBytes("called${Environment.NewLine}1${Environment.NewLine}"),
                Encoding.UTF8.GetBytes(result.Output)
            )
        }

        private func Bind(source string)(Diagnostics ImmutableArray[Diagnostic], Compilation Compilation) {
            let compilation = Compilation(SyntaxTree.Parse(source))
            return (EmittedOracle.CompileDiagnostics(compilation), compilation)
        }
    }
}
