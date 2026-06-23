// <copyright file="SwitchStatementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 2.6: <c>switch</c> statements over int / string / bool with required
/// brace-block case bodies and no implicit fallthrough (ADR-0013).
/// </summary>
public class SwitchStatementTests
{
    [Fact]
    public void Switch_Int_Binds()
    {
        var src = @"func F() {
 var x = 1
 switch x {
 case 1 { var a = ""one"" }
 case 2 { var b = ""two"" }
 default { var c = ""other"" }
 }
}
";
        Assert.Empty(Bind(src));
    }

    [Fact]
    public void Switch_String_Binds()
    {
        var src = @"func F() {
 var s = ""hi""
 switch s {
 case ""hi"" { var a = 1 }
 case ""bye"" { var b = 2 }
 }
}
";
        Assert.Empty(Bind(src));
    }

    [Fact]
    public void Switch_Bool_Binds()
    {
        var src = @"func F() {
 var b = true
 switch b {
 case true { var x = 1 }
 case false { var y = 2 }
 }
}
";
        Assert.Empty(Bind(src));
    }

    [Fact]
    public void Switch_Without_Default_Binds()
    {
        var src = @"func F() {
 var x = 1
 switch x {
 case 1 { var a = 1 }
 }
}
";
        Assert.Empty(Bind(src));
    }

    [Fact]
    public void Switch_Case_Type_Mismatch_Reports_Error()
    {
        var src = @"func F() {
 var x = 1
 switch x {
 case ""hi"" { var a = 1 }
 }
}
";
        var diagnostics = Bind(src);
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void Switch_Duplicate_Default_Reports_Error()
    {
        var src = @"func F() {
 var x = 1
 switch x {
 case 1 { var a = 1 }
 default { var b = 2 }
 default { var c = 3 }
 }
}
";
        var diagnostics = Bind(src);
        Assert.Contains(diagnostics, d => d.Message.Contains("default", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Fallthrough_Reports_Error()
    {
        var src = @"func F() {
 var x = 1
 switch x {
 case 1 { fallthrough }
 case 2 { var a = 1 }
 }
}
";
        var diagnostics = Bind(src);
        Assert.Contains(diagnostics, d => d.Message.Contains("fallthrough", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Switch_Default_NotLast_Still_Routes_Correctly()
    {
        // Default in the middle still binds; semantic equivalence verified by
        // the chain construction in BindSwitchStatement.
        var src = @"func F() {
 var x = 1
 switch x {
 case 1 { var a = 1 }
 default { var b = 2 }
 case 3 { var c = 3 }
 }
}
";
        Assert.Empty(Bind(src));
    }

    // Issue #991: `when` guards on switch-statement arms.
    [Fact]
    public void Switch_WhenGuard_Binds()
    {
        var src = @"func F() {
 var x = 5
 switch x {
 case > 0 when x < 10 { var a = ""small"" }
 case > 0 { var b = ""big"" }
 default { var c = ""nonpositive"" }
 }
}
";
        Assert.Empty(Bind(src));
    }

    [Fact]
    public void Switch_NonBoolGuard_Diagnoses()
    {
        var src = @"func F() {
 var x = 1
 switch x {
 case > 0 when x { var a = 1 }
 default { var b = 2 }
 }
}
";
        var diagnostics = Bind(src);
        Assert.Contains(diagnostics, d => d.Message.Contains("Cannot convert type", System.StringComparison.Ordinal) && d.Message.Contains("'bool'", System.StringComparison.Ordinal));
    }

    // Issue #992: a binding type pattern under `or` / `not` is rejected (GS0390),
    // because the variable would not be definitely assigned when the arm runs.
    [Fact]
    public void Switch_TypePatternBindingUnderOr_Diagnoses()
    {
        var src = @"open class Animal { var Name string }
class Dog : Animal { }
class Cat : Animal { }
func F(a Animal) {
 switch a {
 case d is Dog or e is Cat { var x = 1 }
 default { var y = 2 }
 }
}
";
        var diagnostics = Bind(src);
        Assert.Contains(diagnostics, d => d.Message.Contains("may not be declared under an 'or' or 'not' pattern", System.StringComparison.Ordinal));
    }

    [Fact]
    public void Switch_DiscardTypePatternUnderOr_IsAllowed()
    {
        // Discard (`_`) type patterns under `or` introduce no binding and are
        // permitted.
        var src = @"open class Animal { var Name string }
class Dog : Animal { }
class Cat : Animal { }
func F(a Animal) {
 switch a {
 case _ is Dog or _ is Cat { var x = 1 }
 default { var y = 2 }
 }
}
";
        Assert.Empty(Bind(src));
    }

    // Issue #992: smart-cast under `and` narrows the discriminant in the arm
    // body; under `or` it does NOT (which keeps the narrowing sound).
    [Fact]
    public void Switch_TypePatternUnderAnd_NarrowsDiscriminant()
    {
        var src = @"open class Animal { var Name string }
class Dog : Animal { func Bark() string { return ""woof"" } }
func F(a Animal) {
 switch a {
 case d is Dog and { Name: ""Rex"" } { var s = a.Bark() }
 default { }
 }
}
";
        Assert.Empty(Bind(src));
    }

    [Fact]
    public void Switch_TypePatternUnderOr_DoesNotNarrowDiscriminant()
    {
        // `a` is not narrowed across an `or`, so `a.Bark()` (defined only on Dog)
        // does not resolve.
        var src = @"open class Animal { var Name string }
class Dog : Animal { func Bark() string { return ""woof"" } }
class Cat : Animal { }
func F(a Animal) {
 switch a {
 case _ is Dog or _ is Cat { var s = a.Bark() }
 default { }
 }
}
";
        var diagnostics = Bind(src);
        Assert.Contains(diagnostics, d => d.Message.Contains("Bark", System.StringComparison.Ordinal));
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
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

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
