// <copyright file="Issue3409PatternVariableBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Binder and flow coverage for ADR-0166 pattern variables in boolean
/// `is` expressions (issue #3409).
class Issue3409PatternVariableBindingTests {
    @Fact
    func TypeDesignation_BindsReadOnlyPatternVariableWithoutDeclaringIt() {
        let program = BindProgram(Shapes + `func Length(value object) int32 {
    if value is string text && text.Length > 3 {
        return text.Length
    }
    return 0
}`)
        Assert.Empty(program.Diagnostics)
        let isExpression = FindIsExpressions(program).Single()
        let typePattern = Assert.IsType[BoundTypePattern](isExpression.Pattern)
        Assert.True(typePattern.HasBinding)
        Assert.Equal("text", typePattern.Variable.Name)
        Assert.True(typePattern.Variable.IsReadOnly)
        Assert.Same(TypeSymbol.String, typePattern.Variable.Type)
        Assert.False(isExpression.IsSimpleTypeTest)
        // Every read of `text` (the `&&` continuation and the body) resolves to
        // the very symbol the pattern assigns.
        let reads = FindReads(program, "text").ToArray()
        Assert.Equal(2, reads.Length)
        Assert.All(reads, (read BoundVariableExpression) -> Assert.Same(typePattern.Variable, read.Variable))
    }

    @Fact
    func IssueExample_NestedPropertyDesignation_BindsThroughAndChain() {
        let diagnostics = Bind(Shapes + `class Receiver {
    prop Type object? { get; init; }
}
class Access {
    prop Receiver Receiver? { get; init; }
}
func IsClassField(fa Access) bool {
    if fa.Receiver is { Type: Dog s } && s.Name.Length > 0 {
        return false
    }
    return true
}`)
        Assert.Empty(diagnostics)
    }

    @Theory
    @InlineData("if value is Dog { Name: \"Rex\" } rex { return rex.Name.Length }")
    @InlineData("if value is { } present { return present.GetHashCode() }")
    @InlineData("if !(value is string missing) { return 0 } else { return missing.Length }")
    @InlineData("if value !is string s { return 0 }\n    return s.Length")
    @InlineData("if !(value is string s) || s.Length == 0 { return 0 }\n    return s.Length")
    @InlineData("return value is int32 n ? n : 0")
    @InlineData("return if value is string s { s.Length } else { 0 }")
    @InlineData("for value is string s && s.Length > 100 { return s.Length }\n    return 0")
    @InlineData("switch value { case Dog d when d.Name is string name { return name.Length } default { return 0 } }")
    @InlineData("return switch value { case Dog d when d.Name is string name: name.Length default: 0 }")
    @InlineData(`if value is Dog dog { let f = () -> dog.Name
        return f().Length }
    return 0`)
    func PatternVariables_AreInScopeWhereDefinitelyAssigned(body string) {
        let diagnostics = Bind(Shapes + (`func Use(value object) int32 {
    ` + "$body" + `
    return 0
}`))
        Assert.Empty(diagnostics)
    }

    @Fact
    func OutVarInsidePatternVariableRegion_KeepsItsStatementScope() {
        // An inline `out var` in the right operand of `&&` (bound inside the
        // pattern-variable region) still belongs to the enclosing block, so the
        // then-body and the statements after the `if` can read it.
        let diagnostics = Bind(Shapes + `class Reader {
    func TryRead(name string, out value string?) bool {
        value = name
        return true
    }
}
func Use(value object) int32 {
    if value is Reader reader && reader.TryRead("x", out var got) && got!!.Length > 0 {
        return got!!.Length + reader.GetHashCode()
    }
    if !(value is Reader other) || !other.TryRead("y", out var second) {
        return 0
    }
    return second!!.Length
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func AssigningPatternVariableAcrossLoopBackEdge_RemovesTargetNarrowingAtTheLoopEntry() {
        // ADR-0213 row R7 (b) and question 4: a variable is no proof across a back edge, a pattern
        // variable included, so the loop removes the narrowing of `access` at its entry and the
        // read in the loop header is reported. The fix is a nullable-aware read or a `let` copy
        // before the loop (the pin-move PR restructures the one site in `src/Core`).
        let diagnostics = Bind(`class Node {
    prop Receiver Node? { get; init; }
    prop IsStatic bool { get; init; }
}
func Depth(receiver object) int32 {
    var access Node? = receiver as Node
    if access == nil {
        return 0
    }
    var depth = 1
    while true {
        if access.IsStatic {
            depth += 10
        }
        if !(access.Receiver is Node inner) {
            return depth
        }
        access = inner
        depth += 1
    }
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
    }

    @Fact
    func GuardLeak_DeclaresPatternVariableForTheRestOfTheBlock() {
        let program = BindProgram(Shapes + `func Use(value object) int32 {
    if !(value is string s) {
        return 0
    }
    let first = s.Length
    return first + s.Length
}`)
        Assert.Empty(program.Diagnostics)
        let pattern = Assert.IsType[BoundTypePattern](FindIsExpressions(program).Single().Pattern)
        let reads = FindReads(program, "s").ToArray()
        Assert.Equal(2, reads.Length)
        Assert.All(reads, (read BoundVariableExpression) -> Assert.Same(pattern.Variable, read.Variable))
    }

    @Fact
    func NativeNotGuard_DeclaresPatternVariableOnTheFalseEdge() {
        let program = BindProgram(Shapes + `func Use(value object) int32 {
    if value is not string text {
        return 0
    }
    return text.Length
}`)
        Assert.Empty(program.Diagnostics)
        let notPattern = Assert.IsType[BoundNotPattern](FindIsExpressions(program).Single().Pattern)
        let typePattern = Assert.IsType[BoundTypePattern](notPattern.Pattern)
        let read = Assert.Single(FindReads(program, "text"))
        Assert.Same(typePattern.Variable, read.Variable)
    }

    @Fact
    func NativeNotBinding_IsUnavailableInTheTrueBranch() {
        let diagnostic = Assert.Single(Bind(Shapes + `func Use(value object) int32 {
    if value is not string text {
        return text.Length
    }
    return 0
}`))
        Assert.Equal("GS0532", diagnostic.Id)
        Assert.Equal("text", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func NativeNotBinding_StillRejectsNestedDesignations() {
        let diagnostic = Assert.Single(Bind(Shapes + `func Use(value object) int32 {
    if value is not Dog { Name: string name } dog {
        return 0
    }
    return dog.Name.Length
}`))
        Assert.Equal("GS0390", diagnostic.Id)
        Assert.Equal("name", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Theory
    @InlineData("if value is string s { }\n    return s.Length", "s")
    @InlineData("if value is string s || s.Length > 0 { return 1 }\n    return 0", "s")
    @InlineData("if value is string s { return 1 } else { return s.Length }", "s")
    @InlineData("let ok = value is string s\n    return s.Length", "s")
    @InlineData("if true { } else if !(value is string s) { return 0 }\n    return s.Length", "s")
    @InlineData("return value is int32 n ? 0 : n", "n")
    @InlineData("for value is string s { }\n    return s.Length", "s")
    func PatternVariables_OutsideTheirRegion_ReportGS0532(body string, name string) {
        let diagnostics = Bind(Shapes + (`func Use(value object) int32 {
    ` + "$body" + `
    return 0
}`))
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0532", diagnostic.Id)
        Assert.Equal(name, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.Contains("not definitely assigned here", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func SwitchSpelling_InBooleanIs_StillReportsGS0525PointingAtDesignation() {
        let diagnostic = Assert.Single(Bind("let value object = \"hello\"\nlet matched = value is text is string"))
        Assert.Equal("GS0525", diagnostic.Id)
        Assert.Equal("text", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.Contains("'is Type text'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func SliceCapture_InBooleanIs_IsNowABinding() {
        let diagnostics = Bind(`func First(values []int32) int32 {
    if values is [1, ..rest] && rest.Length > 0 {
        return rest[0]
    }
    return -1
}`)
        Assert.Empty(diagnostics)
    }

    @Theory
    @InlineData("return a is string t && b is int32 t", "t")
    @InlineData("return !(a is string t) || !(b is int32 t)", "t")
    @InlineData("return a is Box { Value: string t } && b is int32 t", "t")
    func DuplicatePatternVariablesOnOnePath_ReportGS0102Once(body string, name string) {
        let diagnostics = Bind(Shapes + (`func Use(a object, b object) bool {
    ` + "$body" + `
}`))
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0102", diagnostic.Id)
        Assert.Equal(name, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func GuardLeak_CollidingWithEnclosingLocal_ReportsGS0102AtDesignation() {
        let diagnostics = Bind(Shapes + `func Use(value object) int32 {
    let s = 5
    if !(value is string s) {
        return 0
    }
    return s
}`)
        let declared = Assert.Single(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0102")
        Assert.Equal("s", declared.Location.Text!!.ToString(declared.Location.Span))
        Assert.Contains(
            "value is string s",
            declared.Location.Text!!.Lines[declared.Location.StartLine].ToString(),
            StringComparison.Ordinal
        )
    }

    @Fact
    func ExitingElseBranch_LeaksWhenTrueVariables() {
        let diagnostics = Bind(Shapes + `func Use(value object) int32 {
    if value is string s { } else { return 0 }
    return s.Length
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func PatternVariables_AreImmutable() {
        let diagnostic = Assert.Single(Bind(Shapes + `func Use(value object) int32 {
    if value is string s {
        s = "x"
    }
    return 0
}`))
        Assert.Equal("GS0127", diagnostic.Id)
    }

    @Fact
    func ThenScope_ShadowsSameNameInSiblingIf_WithoutConflict() {
        let diagnostics = Bind(Shapes + `func Use(a object, b object) int32 {
    if a is string s { return s.Length }
    if b is string s { return s.Length + 1 }
    return 0
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SwitchCases_AcceptDesignationSpelling() {
        let diagnostics = Bind(Shapes + `func Name(animal Animal) string {
    switch animal {
        case Dog dog { return dog.Name }
        default { }
    }
    return switch animal {
        case Dog { Name: "Rex" } rex: rex.Name
        case other is Dog: other.Name
        default: "?"
    }
}`)
        Assert.Empty(diagnostics)
    }

    private class ReadCollector : BoundTreeWalker {
        private let name string

        init(name string) {
            Reads = List[BoundVariableExpression]()
            IsExpressions = List[BoundIsExpression]()
            this.name = name
        }

        prop Reads List[BoundVariableExpression] {
            get;
        }

        prop IsExpressions List[BoundIsExpression] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            if node is BoundVariableExpression variable && variable.Variable.Name == name {
                Reads.Add(variable)
            }
            if node is BoundIsExpression isExpression {
                IsExpressions.Add(isExpression)
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private const Shapes string = `open class Animal { }
class Dog : Animal {
    prop Name string { get; init; }
}
class Box {
    prop Value object? { get; init; }
}
`

        private func FindReads(program BoundProgram, name string) IEnumerable[BoundVariableExpression] {
            let collector = ReadCollector(name)
            for body in program.Functions.Values {
                collector.VisitStatement(body)
            }
            collector.VisitStatement(program.Statement)
            return collector.Reads
        }

        private func FindIsExpressions(program BoundProgram) IEnumerable[BoundIsExpression] {
            let collector = ReadCollector(name: string.Empty)
            for body in program.Functions.Values {
                collector.VisitStatement(body)
            }
            collector.VisitStatement(program.Statement)
            return collector.IsExpressions
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
