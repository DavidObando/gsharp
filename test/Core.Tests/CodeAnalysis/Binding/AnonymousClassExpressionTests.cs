// <copyright file="AnonymousClassExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2224: anonymous-class literal expression <c>interface { Name = "Foo" }</c>.
/// </summary>
public class AnonymousClassExpressionTests
{
    [Fact]
    public void AnonymousClass_MemberAccess_ReturnsAssignedValue()
    {
        var source = @"
var x = interface { Name = ""Foo"", Age = 42 }
x.Name
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Foo", result.Value);
    }

    [Fact]
    public void AnonymousClass_SameShape_UnifiesToOneSynthesizedType()
    {
        var source = @"
var a = interface { Id = 1, Alias = ""x"" }
var b = interface { Id = 2, Alias = ""y"" }
1
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);

        // Issue #2224: both literals share the same (Id: int32, Alias: string)
        // shape, so exactly one synthesized anonymous type is created for the
        // whole compile pass — never two distinct TypeDefs for one shape.
        var anonTypes = compilation.GlobalScope.AnonymousTypes;
        Assert.Single(anonTypes);
    }

    [Fact]
    public void AnonymousClass_DifferentShape_ProducesDifferentTypes()
    {
        var source = @"
var a = interface { Id = 1 }
var b = interface { Id = 1, Alias = ""x"" }
1
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);

        var anonTypes = compilation.GlobalScope.AnonymousTypes;
        Assert.Equal(2, anonTypes.Length);
        Assert.NotSame(anonTypes[0], anonTypes[1]);
    }

    [Fact]
    public void AnonymousClass_StructuralEquality_MatchesByValue()
    {
        var source = @"
var a = interface { Id = 1, Alias = ""x"" }
var b = interface { Id = 1, Alias = ""x"" }
a == b
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void AnonymousClass_ToString_ListsMembers()
    {
        var source = @"
var a = interface { Id = 1, Alias = ""x"" }
a.ToString()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Contains("Id", (string)result.Value);
        Assert.Contains("Alias", (string)result.Value);
    }

    [Fact]
    public void AnonymousClass_InsideLambda_Binds()
    {
        var source = @"
func project(id int32, alias string) string {
    var f = (i int32, a string) -> interface { Id = i, Alias = a }
    var r = f(id, alias)
    return r.Alias
}
project(7, ""hi"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void AnonymousClass_InsideExpressionTreeLambda_DoesNotReportGS0473()
    {
        // Issue #2224: this is the actual reported bug. A tuple literal
        // inside an expression-tree lambda body is illegal (GS0473, see
        // Issue2130ExpressionTreeBindingTests.TupleLiteral_IsRejected), which
        // broke cs2gs-translated EF Core migrations that used a C#
        // anonymous-object HasKey/HasIndex selector (lowered, at the time, to
        // a G# tuple literal). An anonymous-class literal must be legal in
        // the same position, exactly like C#'s `new { ... }` is legal inside
        // an expression tree.
        var diagnostics = GetDiagnostics(@"
import System
import System.Linq.Expressions

class Row {
    var Id int32
    var Alias string
}

let expr Expression[Func[Row, object]] = (r Row) -> interface { Id = r.Id, Alias = r.Alias }
");

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0473");
        Assert.Empty(diagnostics);
    }

    private static System.Collections.Immutable.ImmutableArray<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        var result = compilation.Emit(peStream);
        return result.Diagnostics;
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
