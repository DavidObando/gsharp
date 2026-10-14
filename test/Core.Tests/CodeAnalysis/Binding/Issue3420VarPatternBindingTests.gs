// <copyright file="Issue3420VarPatternBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Binding and flow coverage for native total `var name` patterns.
class Issue3420VarPatternBindingTests {
    @Fact
    func VarBindings_KeepExactStaticInputTypesThroughNestedPatterns() {
        let program = BindProgram(Shapes + `func Use(holder Holder, reference object?, number int32?) int32 {
    if holder is { Maybe: var maybe, Values: [var first, ..] }
        && maybe == nil {
        return first
    }
    if reference is var captured {
        return captured == nil ? 1 : 2
    }
    if number is var nullableNumber {
        return nullableNumber ?? 0
    }
    return -1
}`)
        Assert.Empty(program.Diagnostics)
        let patterns = FindVarPatterns(program).ToDictionary(
            func (pattern BoundDiscardPattern) string {
                return pattern.Variable!!.Name
            }
        )
        Assert.Equal(TypeSymbol.Int32, patterns["first"].Variable!!.Type)
        AssertNullable(patterns["maybe"].Variable!!.Type, TypeSymbol.String)
        AssertNullable(patterns["captured"].Variable!!.Type, TypeSymbol.Object)
        AssertNullable(patterns["nullableNumber"].Variable!!.Type, TypeSymbol.Int32)
        Assert.All(patterns.Values, (pattern BoundDiscardPattern) -> Assert.True(pattern.Variable!!.IsReadOnly))
        Assert.All(
            patterns.Values,
            (pattern BoundDiscardPattern) -> Assert.False(pattern.Variable!!.HasDefinitelyNonNullValue)
        )
    }

    @Fact
    func VarPattern_UsesExistingDefinitelyAssignedRegions() {
        let diagnostics = Bind(Shapes + `func Use(value object?) bool {
    if value is var captured && captured == nil {
        return true
    }
    return false
}`)
        Assert.Empty(diagnostics)
        let outside = Assert.Single(Bind(Shapes + `func Use(value object?) bool {
    if value is var captured { }
    return captured == nil
}`))
        Assert.Equal("GS0532", outside.Id)
    }

    @Theory
    @InlineData("value is not var captured")
    @InlineData("value is var captured or _")
    func VarBinding_UnderNotOrOr_ReportsGS0390(condition string) {
        let diagnostic = Assert.Single(Bind((`func Use(value object?) bool {
    return ` + "$condition" + `
}`)))
        Assert.Equal("GS0390", diagnostic.Id)
        Assert.Equal("captured", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func VarPattern_IsTotalInSwitchExpressionAndScopesGuardAndArm() {
        let diagnostics = Bind(`func Describe(value object?) string {
    return switch value {
        case var captured when captured == nil: "nil"
        case var captured: captured == nil ? "nil" : "value"
    }
}`)
        Assert.Empty(diagnostics)
    }

    private class VarPatternCollector : BoundTreeWalker {
        init() {
            Patterns = List[BoundDiscardPattern]()
        }

        prop Patterns List[BoundDiscardPattern] {
            get;
        }

        override func VisitPattern(node BoundPattern) {
            if node is BoundDiscardPattern{Variable: not nil} varPattern {
                Patterns.Add(varPattern)
            }
            base.VisitPattern(node)
        }
    }

    shared {
        private const Shapes string = `class Holder {
    prop Maybe string? { get; init; }
    prop Values []int32 { get; init; }
}
`

        private func AssertNullable(actual TypeSymbol, expectedUnderlying TypeSymbol) {
            let nullable = Assert.IsType[NullableTypeSymbol](actual)
            Assert.Equal(expectedUnderlying, nullable.UnderlyingType)
        }

        private func FindVarPatterns(program BoundProgram) IEnumerable[BoundDiscardPattern] {
            let collector = VarPatternCollector()
            for body in program.Functions.Values {
                collector.VisitStatement(body)
            }
            collector.VisitStatement(program.Statement)
            return collector.Patterns
        }

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            return Binder.BindProgram(globalScope).Diagnostics
        }

        private func BindProgram(source string) BoundProgram {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            Assert.Empty(tree.Diagnostics)
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            Assert.Empty(globalScope.Diagnostics)
            return Binder.BindProgram(globalScope)
        }
    }
}
