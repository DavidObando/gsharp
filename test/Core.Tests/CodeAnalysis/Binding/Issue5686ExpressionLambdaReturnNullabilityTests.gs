// <copyright file="Issue5686ExpressionLambdaReturnNullabilityTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #5686: an expression-bodied function literal converts its result to the target delegate's return
/// type, as a block-bodied function literal's `return` statement does. A `T?` result where the target
/// delegate returns a non-null `T` reports `GS0155` at the body expression.
open class Issue5686ExpressionLambdaReturnNullabilityTests {
    @Theory
    @MemberData("RejectedRows")
    func ExpressionLambda_WithNullableResultAtNonNullDelegateReturn_ReportsDiagnostic(
        name string,
        source string,
        expectedSnippet string,
        expectedId string
    ) {
        let errors = GetErrors(source)
        let diagnostic = Assert.Single(errors)
        Assert.True(
            diagnostic.Id == expectedId,
            "'$name' expected $expectedId, got ${diagnostic.Id}: ${diagnostic.Message}"
        )
        let spanText = diagnostic.Location.Text!!.ToString(diagnostic.Location.Span)
        Assert.Equal(expectedSnippet, spanText)
    }

    @Theory
    @MemberData("AcceptedRows")
    func ExpressionLambda_WithCompatibleOrNullableDelegateReturn_BindsCleanly(name string, source string) {
        let errors = GetErrors(source)
        Assert.True(errors.IsEmpty, "'$name' must bind with no errors. Got: " + Describe(errors))
    }

    shared {
        private const Prelude string = `package Demo
import System
import System.Collections.Generic
import System.Linq
import System.Linq.Expressions
import System.Threading.Tasks
import Lib5686

class Box {
    var Value int32
    prop MaybeName string? { get; set; }
}

interface IThing {
    func M() int32;
}

delegate StringFunc() string;
delegate NullableStringFunc() string?;
delegate BoxFunc() Box;
delegate IntMapFunc(x int32) string;

class Holder {
    var Callback () -> string = () -> "init"
    prop Prop () -> string { get; set; }
}

func Maybe() string? -> nil
func MaybeBox() Box? -> nil
func MaybeThing() IThing? -> nil
func MaybeInt() int32? -> nil
func MaybePair() (string, int32)? -> nil
func TakeFunc(f () -> string) string -> f()
func TakeClrFunc(f Func[string]) string -> f()
func TakeNamedDelegate(f StringFunc) string -> f()
func TakeNullableDelegate(f (() -> string)?) string -> if f != nil { f() } else { "" }
`

        func RejectedRows() sequence[[]object] {
            yield Row("repro-expression-arrow", `func Run() string {
    let f () -> string = () -> Maybe()
    return f()
}`, "Maybe()")
            yield Row("repro-block-return-control", `func Run() string {
    let g () -> string = () -> { return Maybe() }
    return g()
}`, "Maybe()")
            yield Row("block-trailing-expression", `func Run() string {
    let f () -> string = () -> {
        let _ = 1
        Maybe()
    }
    return f()
}`, "Maybe()")
            yield Row("clr-func-target", `func Run() string {
    let f Func[string] = () -> Maybe()
    return f()
}`, "Maybe()")
            yield Row("named-delegate-target", `func Run() string {
    let f StringFunc = () -> Maybe()
    return f()
}`, "Maybe()")
            yield Row("imported-strict-delegate-target", `func Run() string {
    let f StrictDelegate5686 = () -> Maybe()
    return f()
}`, "Maybe()")
            yield Row("nullable-arrow-delegate-local", `func Run() {
    let f (() -> string)? = () -> Maybe()
}`, "Maybe()")
            yield Row("nullable-clr-func-local", `func Run() {
    let f Func[string]? = () -> Maybe()
}`, "Maybe()")
            yield Row("nullable-named-delegate-local", `func Run() {
    let f StringFunc? = () -> Maybe()
}`, "Maybe()")
            yield Row("parenthesized-local-initializer", `func Run() string {
    let f () -> string = (() -> Maybe())
    return f()
}`, "Maybe()")
            yield Row("assignment-to-local", `func Run() string {
    var f () -> string = () -> "ok"
    f = () -> Maybe()
    return f()
}`, "Maybe()")
            yield Row("assignment-parenthesized", `func Run() string {
    var f () -> string = () -> "ok"
    f = (() -> Maybe())
    return f()
}`, "Maybe()")
            yield Row("assignment-to-nullable-delegate", `func Run() {
    var f (() -> string)? = nil
    f = () -> Maybe()
}`, "Maybe()")
            yield Row("assignment-to-field", `func Run(h Holder) {
    h.Callback = () -> Maybe()
}`, "Maybe()")
            yield Row("assignment-to-property", `func Run(h Holder) {
    h.Prop = () -> Maybe()
}`, "Maybe()")
            yield Row("return-statement", `func Run() () -> string {
    return () -> Maybe()
}`, "Maybe()")
            yield Row("return-nullable-delegate", `func Run() (() -> string)? {
    return () -> Maybe()
}`, "Maybe()")
            yield Row("expression-bodied-function-return", `func Run() () -> string -> () -> Maybe()`, "Maybe()")
            yield Row("argument-source-function", `func Run() string -> TakeFunc(() -> Maybe())`, "Maybe()")
            yield Row("argument-clr-func", `func Run() string -> TakeClrFunc(() -> Maybe())`, "Maybe()")
            yield Row("argument-named-delegate", `func Run() string -> TakeNamedDelegate(() -> Maybe())`, "Maybe()")
            yield Row(
                "argument-nullable-delegate",
                `func Run() string -> TakeNullableDelegate(() -> Maybe())`,
                "Maybe()"
            )
            yield Row(
                "argument-imported-strict-method",
                `func Run() string -> StrictSink5686.Take(() -> Maybe())`,
                "Maybe()"
            )
            yield Row(
                "argument-imported-generic-receiver",
                `func Run(b StrictGenericBox5686[Box]) string -> b.Run((x Box) -> Maybe())`,
                "Maybe()"
            )
            yield Row("instance-field-initializer", `class FieldSample {
    var f () -> string = () -> Maybe()
}`, "Maybe()")
            yield Row("static-field-initializer", `class StaticFieldSample {
    shared {
        var f () -> string = () -> Maybe()
    }
}`, "Maybe()")
            yield Row("slice-element", `func Run() []() -> string -> []() -> string{() -> Maybe()}`, "Maybe()")
            yield Row("map-value", `func Run() {
    let m = map[int32, () -> string]{1: () -> Maybe()}
}`, "Maybe()")
            yield Row("tuple-element", `func Run() {
    let t (() -> string, int32) = (() -> Maybe(), 1)
}`, "Maybe()")
            yield Row("object-initializer-member", `func Run() Holder -> Holder{Callback: () -> Maybe()}`, "Maybe()")
            yield Row("conditional-arm", `func Run(c bool) () -> string -> c ? () -> Maybe() : () -> "ok"`, "Maybe()")
            yield Row(
                "if-expression-arm",
                `func Run(c bool) () -> string -> if c { () -> Maybe() } else { () -> "ok" }`,
                "Maybe()"
            )
            yield Row("async-expression-lambda", `func Run() () -> Task[string] -> async () -> Maybe()`, "Maybe()")
            yield Row("nested-expression-lambda", `func Run() () -> () -> string -> () -> () -> Maybe()`, "Maybe()")
            yield Row("parameterized-inferred-lambda", `func Run() (int32) -> string -> (x) -> Maybe()`, "Maybe()")
            yield Row("parameterized-explicit-lambda", `func Run() IntMapFunc -> (x int32) -> Maybe()`, "Maybe()")
            yield Row("gsharp-class-return", `func Run() BoxFunc -> () -> MaybeBox()`, "MaybeBox()")
            yield Row("interface-return", `func Run() () -> IThing -> () -> MaybeThing()`, "MaybeThing()")
            yield Row(
                "value-type-nullable-return",
                `func Run() () -> int32 -> () -> MaybeInt()`,
                "MaybeInt()",
                "GS0156"
            )
            yield Row("nullable-tuple-return", `func Run() (string, int32) {
    let f () -> (string, int32) = () -> MaybePair()
    return f()
}`, "MaybePair()")
            yield Row("tuple-nil-element-return", `func Run() (string, int32) {
    let f () -> (string, int32) = () -> (nil, 1)
    return f()
}`, "(nil, 1)")
            yield Row("nil-literal-return", `func Run() () -> string -> () -> nil`, "nil")
        }

        func AcceptedRows() sequence[[]object] {
            yield AcceptedRow("ok-nullable-arrow-return", `func Run() () -> string? -> () -> Maybe()`)
            yield AcceptedRow("ok-nullable-clr-func-return", `func Run() Func[string?] -> () -> Maybe()`)
            yield AcceptedRow("ok-nullable-named-delegate-return", `func Run() NullableStringFunc -> () -> Maybe()`)
            yield AcceptedRow("ok-nullable-nil-return", `func Run() () -> string? -> () -> nil`)
            yield AcceptedRow("ok-nonnull-return", `func Run() () -> string -> () -> "ok"`)
            yield AcceptedRow("ok-nonnull-into-nullable-return", `func Run() () -> string? -> () -> "ok"`)
            yield AcceptedRow(
                "ok-platform-return-into-nonnull",
                `func Run() () -> string -> () -> ObliviousSink5686.Get()`
            )
            yield AcceptedRow(
                "ok-oblivious-delegate-parameter",
                `func Run(b ObliviousGenericBox5686[Box]) string -> b.Run((x Box) -> Maybe())`
            )
            yield AcceptedRow(
                "ok-oblivious-expression-tree-parameter",
                `func Run(b ObliviousGenericBox5686[Box]) -> b.Index((x Box) -> x.MaybeName)`
            )
            yield AcceptedRow(
                "ok-imported-nullable-generic-receiver",
                `func Run(b StrictGenericBox5686[Box]) string? -> b.RunNullable((x Box) -> Maybe())`
            )
            yield AcceptedRow(
                "ok-linq-thenby-inferred-key",
                `func Run(xs []Box) []IGrouping[int32, Box] -> xs.GroupBy((x Box) -> x.Value).OrderByDescending((g IGrouping[int32, Box]) -> g.Count()).ThenBy((g IGrouping[int32, Box]) -> g.Min((x Box) -> x.ToString()), StringComparer.Ordinal).ToArray()`
            )
        }

        private func Row(
            name string,
            snippet string,
            expectedSnippet string,
            expectedId string = "GS0155"
        )[]object -> []object{name, Prelude + "\n" + snippet, expectedSnippet, expectedId}

        private func AcceptedRow(name string, snippet string)[]object -> []object{name, Prelude + "\n" + snippet}

        private let LibraryPath string = EmitLibrary()

        private func GetErrors(source string) ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic] {
            using let resolver = ReferenceResolver.WithReferences([]string{LibraryPath})
            let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source))
            let compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                .ToImmutableArray()
        }

        private func Describe(diagnostics ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic]) string -> string.Join(
            "; ",
            diagnostics.Select(
                (
                    d GSharp.Core.CodeAnalysis.Diagnostic
                ) -> "${d.Id}@${d.Location.StartLine}:${d.Location.StartCharacter}: ${d.Message}"
            )
        )

        private func EmitLibrary() string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue5686Binding")
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Lib5686.dll")
            const csharpSource = `#nullable enable
using System;
using System.Linq.Expressions;

namespace Lib5686
{
    public delegate string StrictDelegate5686();

    public static class StrictSink5686
    {
        public static string Take(Func<string> f) => f();
    }

    public class StrictGenericBox5686<T>
    {
        public string Run(Func<T, string> f) => "";
        public string? RunNullable(Func<T, string?> f) => null;
    }
}

#nullable disable
namespace Lib5686
{
    public static class ObliviousSink5686
    {
        public static string Get() => "oblivious";
    }

    public class ObliviousGenericBox5686<T>
    {
        public string Run(Func<T, string> f) => "";
        public void Index(Expression<Func<T, string>> f) { }
    }
}`
            let syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            let compilation = CSharpCompilation.Create(
                "Lib5686",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let peStream = File.Create(libraryPath)
                let emitResult = compilation.Emit(peStream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            return libraryPath
        }
    }
}
