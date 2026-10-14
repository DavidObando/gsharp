// <copyright file="NamedArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #343: named arguments at call sites. Covers user-defined free
/// functions, user methods, user constructors, user extension functions,
/// imported CLR static/instance methods, imported CLR constructors, and
/// imported extension methods. Also exercises the diagnostics GS0244–GS0247.
open class NamedArgumentTests {
    @Fact
    func UserFunction_AllNamed_BindsAndEvaluates() {
        let source = `
func add(x int32, y int32) int32 {
    return x - y
}

let r = add(y: 1, x: 10)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func UserFunction_PositionalThenNamed_BindsAndEvaluates() {
        let source = `
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(10, y: 3)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func UserFunction_InPositionNamedThenPositional_BindsAndEvaluates() {
        let source = `
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(x: 1, 2)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(-1, result.Value)
    }

    @Fact
    func UserFunction_OutOfPositionNamedThenPositional_Diagnoses_GS0244() {
        let source = `
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(y: 1, 2)
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0244")
    }

    @Fact
    func VariadicFunction_InPositionNamedThenPositional_BindsAndEvaluates() {
        let source = `
func total(additional int32, values ...int32) int32 {
    return additional + values.Length
}

total(additional: 5, 10, 20)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func UserFunction_DuplicateName_Diagnoses_GS0245() {
        let source = `
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(x: 1, x: 2)
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0245")
    }

    @Fact
    func UserFunction_UnknownName_Diagnoses_GS0246() {
        let source = `
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(x: 1, qty: 2)
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0246")
    }

    @Fact
    func UserFunction_NameAlsoPositional_Diagnoses_GS0247() {
        let source = `
func sub(x int32, y int32) int32 {
    return x - y
}

let r = sub(1, x: 2)
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0247")
    }

    @Fact
    func UserMethod_NamedArguments_BindAndEvaluate() {
        let source = `
class Calc {
    var Bias int32

    func Combine(a int32, b int32) int32 {
        return Bias + a * 10 + b
    }
}

let c = Calc{Bias: 100}
let r = c.Combine(b: 7, a: 3)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(137, result.Value)
    }

    @Fact
    func UserMethod_NamedArgument_SkipsOptionalMiddleParameter() {
        let source = `
class Progress {
    func Emit(phase int32, progress int32? = nil, message string? = nil) string {
        return message!!
    }
}

let progress = Progress()
progress.Emit(1, message: "ready")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ready", result.Value)
    }

    @Fact
    func UserConstructor_PrimaryCtor_NamedArguments_BindAndEvaluate() {
        let source = `
class Point(X int32, Y int32) {
}

let p = Point(Y: 7, X: 3)
let r = p.X * 10 + p.Y
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(37, result.Value)
    }

    @Fact
    func UserConstructor_InPositionNamedThenPositional_Binds() {
        let source = `
class Point(X int32, Y int32) {
}

let p = Point(X: 3, 7)
p.X * 10 + p.Y
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(37, result.Value)
    }

    @Fact
    func UserConstructor_PrimaryCtor_NameAlsoPositional_Diagnoses_GS0247() {
        let source = `
class Point(X int32, Y int32) {
}

let p = Point(1, X: 9)
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0247")
    }

    @Fact
    func UserExtensionFunction_NamedArguments_BindAndEvaluate() {
        let source = `
class Box {
    var N int32

    func Mix(low int32, high int32) int32 {
        return N + low * 100 + high
    }
}

let b = Box{N: 1}
let r = b.Mix(high: 7, low: 5)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(508, result.Value)
    }

    @Fact
    func ClrInstance_StringIndexOf_NamedArguments_BindAndEvaluate() {
        let source = `
import System

let s = "hello world"
let i = s.IndexOf(value: "world", startIndex: 0)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func ClrConstructor_StringBuilder_NamedArguments_Binds() {
        let source = `
import System.Text

let sb = StringBuilder(capacity: 16)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ClrConstructor_UnknownName_Diagnoses_GS0246() {
        let source = `
import System.Text

let sb = StringBuilder(qty: 16)
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0246")
    }

    @Fact
    func FunctionVariable_NamedArguments_BindAndEvaluate() {
        let source = `
let subtract func(int32, int32) int32 = func(x int32, y int32) int32 {
    return x - y
}

subtract(y: 3, x: 10)
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func NamedDelegateVariable_NamedArguments_BindAndEvaluate() {
        let source = `
delegate Operation(x int32, y int32) int32;

func subtract(x int32, y int32) int32 {
    return x - y
}

let operation Operation = subtract
operation(y: 3, x: 10)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func ImportedClrKeywordParameter_TypeSpellsUnsuffixed() {
        using let resolver = ReferenceResolver.WithReferences(
            []string{typeof(KeywordNamedParameterFixture).Assembly.Location}
        )
        let tree = SyntaxTree.Parse(SourceText.From(`
import GSharp.Core.Tests.CodeAnalysis.Binding

KeywordNamedParameterFixture.Combine(type: "cat", value: 2)
`))
        let compilation = Compilation(resolver, tree)
        let diagnostics = compilation
            .GlobalScope
            .Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray()
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func ImportedClrParamsParameter_CollisionUsesCanonicalNames() {
        using let resolver = ReferenceResolver.WithReferences(
            []string{typeof(KeywordNamedParameterFixture).Assembly.Location}
        )
        let tree = SyntaxTree.Parse(SourceText.From(`
import GSharp.Core.Tests.CodeAnalysis.Binding

KeywordNamedParameterFixture.CombineParams(params__: "left", params_: "right")
`))
        let compilation = Compilation(resolver, tree)
        let diagnostics = compilation
            .GlobalScope
            .Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray()
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func ImportedClrConstructorParamsParameter_CollisionUsesCanonicalNames() {
        using let resolver = ReferenceResolver.WithReferences(
            []string{typeof(KeywordNamedParameterFixture).Assembly.Location}
        )
        let tree = SyntaxTree.Parse(SourceText.From(`
import GSharp.Core.Tests.CodeAnalysis.Binding

KeywordNamedConstructorFixture(params__: "left", params_: "right")
`))
        let compilation = Compilation(resolver, tree)
        let diagnostics = compilation
            .GlobalScope
            .Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray()
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func ImportedClrGenericMethod_NamedLambdaArguments_InferAndBind() {
        using let resolver = ReferenceResolver.WithReferences(
            []string{typeof(KeywordNamedParameterFixture).Assembly.Location}
        )
        let tree = SyntaxTree.Parse(SourceText.From(`
import GSharp.Core.Tests.CodeAnalysis.Binding

GenericNamedArgumentFixture.Create(
    name: "table",
    columns: (builder GenericNamedArgumentBuilder) -> builder.Value,
    constraints: (value int32) -> {
    })
`))
        let compilation = Compilation(resolver, tree)
        let diagnostics = compilation
            .GlobalScope
            .Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray()
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func ImportedConstructedGenericReceiver_NamedLambdaArgument_BindsSymbolically() {
        using let resolver = ReferenceResolver.WithReferences(
            []string{typeof(KeywordNamedParameterFixture).Assembly.Location}
        )
        let tree = SyntaxTree.Parse(SourceText.From(`
import GSharp.Core.Tests.CodeAnalysis.Binding

class Item {
    var Value int32
}

let receiver = GenericNamedReceiver[Item]()
receiver.Apply(
    name: "value",
    selector: (item Item) -> item.Value)
`))
        let compilation = Compilation(resolver, tree)
        let diagnostics = compilation
            .GlobalScope
            .Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray()
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    shared {
        private func AssertHasDiagnosticId(diagnostics ImmutableArray[Diagnostic], id string) {
            Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == id)
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

/// CLR fixture whose parameter name is a reserved G# keyword.
shared class KeywordNamedParameterFixture {
    /// Combines the supplied values.
    func Combine(type string, value int32) string -> "$type:$value"

    /// Combines colliding source parameter names.
    func CombineParams($params string, params_ string) string -> $params + params_
}

/// CLR constructor fixture with colliding source parameter names.
class KeywordNamedConstructorFixture {
    /// Initializes a new instance.
    init($params string, params_ string) { }
}

/// CLR builder fixture for generic named-lambda calls.
class GenericNamedArgumentBuilder {
    /// Gets a deterministic value.
    prop Value int32 -> 42
}

/// CLR generic call fixture matching migration-builder APIs.
shared class GenericNamedArgumentFixture {
    /// Invokes the supplied delegates.
    func Create[T](name string, columns(GenericNamedArgumentBuilder) -> T, constraints(T) -> void) T {
        let value = columns(GenericNamedArgumentBuilder())
        constraints(value)
        return value
    }
}

/// CLR generic receiver fixture for symbolic named lambdas.
class GenericNamedReceiver[T] {
    /// Accepts a lambda over the receiver's symbolic type.
    func Apply(name string, selector(T) -> int32) int32 -> 0
}
