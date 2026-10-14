// <copyright file="Issue3352WhileLetBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Binding, scope, flow, and lowering coverage for issue #3352.
class Issue3352WhileLetBindingTests {
    @Fact
    func BindingIsNarrowedInsideBody() {
        let diagnostics = Bind(`func Lengths(value string?) int32 {
    var total = 0
    while let text = value {
        total = total + text.Length
        break
    }
    return total
}`).Diagnostics
        Assert.Empty(diagnostics)
    }

    @Fact
    func MultipleBindingsAreNarrowedInsideBody() {
        let diagnostics = Bind(`func Combine(left string, right string) string {
    return left + right
}

func Run(first string?, second string?) string {
    while let left string = first, let right = second {
        return Combine(left, right)
    }
    return ""
}`).Diagnostics
        Assert.Empty(diagnostics)
    }

    @Fact
    func BindingInitializerResolvesAgainstEnclosingScope() {
        let diagnostics = Bind(`func Run(value string?) int32 {
    while let value = value {
        return value.Length
    }
    return 0
}`).Diagnostics
        Assert.Empty(diagnostics)
    }

    @Fact
    func BindingsAreNotVisibleToLaterInitializers() {
        let diagnostics = Bind(`func Run(first string?) {
    while let left = first, let right = left {
        break
    }
}`).Diagnostics
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0125")
    }

    @Fact
    func BindingDoesNotEscapeLoop() {
        let diagnostic = Assert.Single(Bind(`func Run(value string?) int32 {
    while let text = value { break }
    let escaped = text
    return 0
}`).Diagnostics)
        Assert.Equal("GS0125", diagnostic.Id)
        Assert.Contains("text", diagnostic.Message)
    }

    @Fact
    func NonNullableInitializerReportsGS0296() {
        let diagnostic = Assert.Single(Bind(`func Run(value string) {
    while let text = value { break }
}`).Diagnostics)
        Assert.Equal("GS0296", diagnostic.Id)
        Assert.Contains("'while let'", diagnostic.Message)
    }

    @Fact
    func NestedAndLabeledLoopsBindBreakAndContinue() {
        let diagnostics = Bind(`func Run(outerValue string?, innerValue string?) {
    outer: while let value = outerValue {
        while let value = innerValue {
            if value.Length == 0 { continue outer }
            break outer
        }
    }
}`).Diagnostics
        Assert.Empty(diagnostics)
    }

    @Fact
    func LoweringPlacesBindingAtCheckLabelAfterContinue() {
        let program = Bind(`var next string? = "value"
while let value = next {
    continue
}`)
        Assert.Empty(program.Diagnostics)
        let statements = program.Statement.Statements
        let initialGoto = statements.OfType[BoundGotoStatement]().First()
        Assert.StartsWith("check", initialGoto.Label.Name)
        let continueIndex = statements
            .Select((statement BoundStatement, index int32) -> (statement, index))
            .Single(
            (pair(statement BoundStatement, index int32)) -> pair.Item1 is BoundLabelStatement label &&
                label
                .Label
                .Name
                .StartsWith("continue", StringComparison.Ordinal)
        )
            .Item2
        let checkIndex = statements
            .Select((statement BoundStatement, index int32) -> (statement, index))
            .Single(
            (pair(statement BoundStatement, index int32)) -> pair.Item1 is BoundLabelStatement label &&
                label
                .Label
                .Name
                .StartsWith("check", StringComparison.Ordinal)
        )
            .Item2
        let breakIndex = statements
            .Select((statement BoundStatement, index int32) -> (statement, index))
            .Single(
            (pair(statement BoundStatement, index int32)) -> pair.Item1 is BoundLabelStatement label &&
                label
                .Label
                .Name
                .StartsWith("break", StringComparison.Ordinal)
        )
            .Item2
        Assert.True(continueIndex >= 0)
        Assert.Equal(continueIndex + 1, checkIndex)
        Assert.Equal("value", Assert.IsType[BoundVariableDeclaration](statements[checkIndex + 1]).Variable.Name)
        Assert.StartsWith("body", Assert.IsType[BoundConditionalGotoStatement](statements[checkIndex + 2]).Label.Name)
        Assert.Equal(checkIndex + 3, breakIndex)
    }

    shared {
        private func Bind(source string) BoundProgram {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            Assert.Empty(tree.Diagnostics)
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return Binder.BindProgram(globalScope)
            }
            return Binder.BindProgram(globalScope)
        }
    }
}
