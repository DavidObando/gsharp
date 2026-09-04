// <copyright file="Issue3409PatternVariableBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Binder and flow coverage for ADR-0166 pattern variables in boolean
/// <c>is</c> expressions (issue #3409).
/// </summary>
public sealed class Issue3409PatternVariableBindingTests
{
    private const string Shapes = """
        open class Animal { }
        class Dog : Animal {
            prop Name string { get; init; }
        }
        class Box {
            prop Value object? { get; init; }
        }

        """;

    [Fact]
    public void TypeDesignation_BindsReadOnlyPatternVariableWithoutDeclaringIt()
    {
        var program = BindProgram(Shapes + """
            func Length(value object) int32 {
                if value is string text && text.Length > 3 {
                    return text.Length
                }
                return 0
            }
            """);

        Assert.Empty(program.Diagnostics);
        var isExpression = FindIsExpressions(program).Single();
        var typePattern = Assert.IsType<BoundTypePattern>(isExpression.Pattern);

        Assert.True(typePattern.HasBinding);
        Assert.Equal("text", typePattern.Variable.Name);
        Assert.True(typePattern.Variable.IsReadOnly);
        Assert.Same(TypeSymbol.String, typePattern.Variable.Type);
        Assert.False(isExpression.IsSimpleTypeTest);

        // Every read of `text` (the `&&` continuation and the body) resolves to
        // the very symbol the pattern assigns.
        var reads = FindReads(program, "text").ToArray();
        Assert.Equal(2, reads.Length);
        Assert.All(reads, read => Assert.Same(typePattern.Variable, read.Variable));
    }

    [Fact]
    public void IssueExample_NestedPropertyDesignation_BindsThroughAndChain()
    {
        var diagnostics = Bind(Shapes + """
            class Receiver {
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
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Theory]
    [InlineData("if value is Dog { Name: \"Rex\" } rex { return rex.Name.Length }")]
    [InlineData("if value is { } present { return present.GetHashCode() }")]
    [InlineData("if !(value is string missing) { return 0 } else { return missing.Length }")]
    [InlineData("if value !is string s { return 0 }\n    return s.Length")]
    [InlineData("if !(value is string s) || s.Length == 0 { return 0 }\n    return s.Length")]
    [InlineData("return value is int32 n ? n : 0")]
    [InlineData("return if value is string s { s.Length } else { 0 }")]
    [InlineData("for value is string s && s.Length > 100 { return s.Length }\n    return 0")]
    [InlineData("switch value { case Dog d when d.Name is string name { return name.Length } default { return 0 } }")]
    [InlineData("return switch value { case Dog d when d.Name is string name: name.Length default: 0 }")]
    [InlineData("if value is Dog dog { let f = () -> dog.Name\n        return f().Length }\n    return 0")]
    public void PatternVariables_AreInScopeWhereDefinitelyAssigned(string body)
    {
        var diagnostics = Bind(Shapes + $$"""
            func Use(value object) int32 {
                {{body}}
                return 0
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void OutVarInsidePatternVariableRegion_KeepsItsStatementScope()
    {
        // An inline `out var` in the right operand of `&&` (bound inside the
        // pattern-variable region) still belongs to the enclosing block, so the
        // then-body and the statements after the `if` can read it.
        var diagnostics = Bind(Shapes + """
            class Reader {
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
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void AssigningPatternVariableAcrossLoopBackEdge_KeepsTargetNarrowing()
    {
        // A pattern variable is proven non-nil by its match, so `access = inner`
        // on the loop back-edge preserves the smart cast of `access` obtained
        // from the early-exit nil guard (the same rule as a `let` local with a
        // non-nil initializer).
        var diagnostics = Bind("""
            class Node {
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
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void GuardLeak_DeclaresPatternVariableForTheRestOfTheBlock()
    {
        var program = BindProgram(Shapes + """
            func Use(value object) int32 {
                if !(value is string s) {
                    return 0
                }
                let first = s.Length
                return first + s.Length
            }
            """);

        Assert.Empty(program.Diagnostics);
        var pattern = Assert.IsType<BoundTypePattern>(FindIsExpressions(program).Single().Pattern);
        var reads = FindReads(program, "s").ToArray();

        Assert.Equal(2, reads.Length);
        Assert.All(reads, read => Assert.Same(pattern.Variable, read.Variable));
    }

    [Fact]
    public void NativeNotGuard_DeclaresPatternVariableOnTheFalseEdge()
    {
        var program = BindProgram(Shapes + """
            func Use(value object) int32 {
                if value is not string text {
                    return 0
                }
                return text.Length
            }
            """);

        Assert.Empty(program.Diagnostics);
        var notPattern = Assert.IsType<BoundNotPattern>(FindIsExpressions(program).Single().Pattern);
        var typePattern = Assert.IsType<BoundTypePattern>(notPattern.Pattern);
        var read = Assert.Single(FindReads(program, "text"));

        Assert.Same(typePattern.Variable, read.Variable);
    }

    [Fact]
    public void NativeNotBinding_IsUnavailableInTheTrueBranch()
    {
        var diagnostic = Assert.Single(Bind(Shapes + """
            func Use(value object) int32 {
                if value is not string text {
                    return text.Length
                }
                return 0
            }
            """));

        Assert.Equal("GS0532", diagnostic.Id);
        Assert.Equal("text", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void NativeNotBinding_StillRejectsNestedDesignations()
    {
        var diagnostic = Assert.Single(Bind(Shapes + """
            func Use(value object) int32 {
                if value is not Dog { Name: string name } dog {
                    return 0
                }
                return dog.Name.Length
            }
            """));

        Assert.Equal("GS0390", diagnostic.Id);
        Assert.Equal("name", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Theory]
    [InlineData("if value is string s { }\n    return s.Length", "s")]
    [InlineData("if value is string s || s.Length > 0 { return 1 }\n    return 0", "s")]
    [InlineData("if value is string s { return 1 } else { return s.Length }", "s")]
    [InlineData("let ok = value is string s\n    return s.Length", "s")]
    [InlineData("if true { } else if !(value is string s) { return 0 }\n    return s.Length", "s")]
    [InlineData("return value is int32 n ? 0 : n", "n")]
    [InlineData("for value is string s { }\n    return s.Length", "s")]
    public void PatternVariables_OutsideTheirRegion_ReportGS0532(string body, string name)
    {
        var diagnostics = Bind(Shapes + $$"""
            func Use(value object) int32 {
                {{body}}
                return 0
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0532", diagnostic.Id);
        Assert.Equal(name, diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.Contains("not definitely assigned here", diagnostic.Message, System.StringComparison.Ordinal);
    }

    [Fact]
    public void SwitchSpelling_InBooleanIs_StillReportsGS0525PointingAtDesignation()
    {
        var diagnostic = Assert.Single(Bind("""
            let value object = "hello"
            let matched = value is text is string
            """));

        Assert.Equal("GS0525", diagnostic.Id);
        Assert.Equal("text", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.Contains("'is Type text'", diagnostic.Message, System.StringComparison.Ordinal);
    }

    [Fact]
    public void SliceCapture_InBooleanIs_IsNowABinding()
    {
        var diagnostics = Bind("""
            func First(values []int32) int32 {
                if values is [1, ..rest] && rest.Length > 0 {
                    return rest[0]
                }
                return -1
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Theory]
    [InlineData("return a is string t && b is int32 t", "t")]
    [InlineData("return !(a is string t) || !(b is int32 t)", "t")]
    [InlineData("return a is Box { Value: string t } && b is int32 t", "t")]
    public void DuplicatePatternVariablesOnOnePath_ReportGS0102Once(string body, string name)
    {
        var diagnostics = Bind(Shapes + $$"""
            func Use(a object, b object) bool {
                {{body}}
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0102", diagnostic.Id);
        Assert.Equal(name, diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void GuardLeak_CollidingWithEnclosingLocal_ReportsGS0102AtDesignation()
    {
        var diagnostics = Bind(Shapes + """
            func Use(value object) int32 {
                let s = 5
                if !(value is string s) {
                    return 0
                }
                return s
            }
            """);

        var declared = Assert.Single(diagnostics, diagnostic => diagnostic.Id == "GS0102");
        Assert.Equal("s", declared.Location.Text.ToString(declared.Location.Span));
        Assert.Contains("value is string s", declared.Location.Text.Lines[declared.Location.StartLine].ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void ExitingElseBranch_LeaksWhenTrueVariables()
    {
        var diagnostics = Bind(Shapes + """
            func Use(value object) int32 {
                if value is string s { } else { return 0 }
                return s.Length
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void PatternVariables_AreImmutable()
    {
        var diagnostic = Assert.Single(Bind(Shapes + """
            func Use(value object) int32 {
                if value is string s {
                    s = "x"
                }
                return 0
            }
            """));

        Assert.Equal("GS0127", diagnostic.Id);
    }

    [Fact]
    public void ThenScope_ShadowsSameNameInSiblingIf_WithoutConflict()
    {
        var diagnostics = Bind(Shapes + """
            func Use(a object, b object) int32 {
                if a is string s { return s.Length }
                if b is string s { return s.Length + 1 }
                return 0
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SwitchCases_AcceptDesignationSpelling()
    {
        var diagnostics = Bind(Shapes + """
            func Name(animal Animal) string {
                switch animal {
                    case Dog dog { return dog.Name }
                    default { }
                }
                return switch animal {
                    case Dog { Name: "Rex" } rex: rex.Name
                    case other is Dog: other.Name
                    default: "?"
                }
            }
            """);

        Assert.Empty(diagnostics);
    }

    private static System.Collections.Generic.IEnumerable<BoundVariableExpression> FindReads(BoundProgram program, string name)
    {
        var collector = new ReadCollector(name);
        foreach (var body in program.Functions.Values)
        {
            collector.VisitStatement(body);
        }

        collector.VisitStatement(program.Statement);
        return collector.Reads;
    }

    private static System.Collections.Generic.IEnumerable<BoundIsExpression> FindIsExpressions(BoundProgram program)
    {
        var collector = new ReadCollector(name: string.Empty);
        foreach (var body in program.Functions.Values)
        {
            collector.VisitStatement(body);
        }

        collector.VisitStatement(program.Statement);
        return collector.IsExpressions;
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        return Binder.BindProgram(globalScope).Diagnostics;
    }

    private static BoundProgram BindProgram(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Empty(tree.Diagnostics);
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        Assert.Empty(globalScope.Diagnostics);
        return Binder.BindProgram(globalScope);
    }

    private sealed class ReadCollector : BoundTreeWalker
    {
        private readonly string name;

        public ReadCollector(string name)
        {
            this.name = name;
        }

        public System.Collections.Generic.List<BoundVariableExpression> Reads { get; } = new();

        public System.Collections.Generic.List<BoundIsExpression> IsExpressions { get; } = new();

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundVariableExpression variable && variable.Variable.Name == name)
            {
                Reads.Add(variable);
            }

            if (node is BoundIsExpression isExpression)
            {
                IsExpressions.Add(isExpression);
            }

            base.VisitExpression(node);
        }
    }
}
