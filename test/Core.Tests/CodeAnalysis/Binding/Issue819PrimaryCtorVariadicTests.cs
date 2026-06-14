// <copyright file="Issue819PrimaryCtorVariadicTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #819 / ADR-0102 follow-up — primary-constructor parameter lists
/// (ADR-0078) accept a trailing variadic <c>name ...T</c>. The variadic
/// parameter promotes to a <c>[]T</c> auto-field of the same name; at call
/// sites trailing positional arguments are packed into a fresh <c>[]T</c>
/// (or forwarded unwrapped when the caller supplies a single <c>[]T</c>).
/// </summary>
public class Issue819PrimaryCtorVariadicTests
{
    // ----- Parser-level acceptance (ADR-0078 spelling matrix) -----

    [Theory]
    [InlineData("class Tags(name string, tags ...string) { }")]
    [InlineData("open class Tags(name string, tags ...string) { }")]
    [InlineData("data class Person(name string, hobbies ...string) { }")]
    [InlineData("data struct Point(x int32, ys ...int32) { }")]
    [InlineData("struct Tags(name string, tags ...string) { }")]
    [InlineData("inline struct Ids(values ...int32) { }")]
    public void PrimaryCtorVariadic_OnAllSites_ParsesAndBinds(string declaration)
    {
        var diagnostics = Bind("package P\n" + declaration + "\n");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0145" || d.Id == "GS0364" || d.Id == "GS0146");
    }

    // ----- Binder structural rules (GS0145, GS0364) -----

    [Fact]
    public void PrimaryCtorVariadic_NotLast_ReportsGS0145()
    {
        var diagnostics = Bind(@"
package P
class Bad(xs ...int32, n int32) { }
");
        Assert.Contains(diagnostics, d => d.Id == "GS0145");
    }

    [Fact]
    public void PrimaryCtorVariadic_MultipleVariadic_ReportsGS0364()
    {
        var diagnostics = Bind(@"
package P
class Bad(xs ...int32, ys ...int32) { }
");
        Assert.Contains(diagnostics, d => d.Id == "GS0364");
    }

    // ----- Field promotion shape -----

    [Fact]
    public void PrimaryCtorVariadic_AutoFieldType_IsSliceOfElementType()
    {
        var (compilation, _) = Compile(@"
package P
class Tags(name string, tags ...string) { }
");
        var tagsType = compilation.GlobalScope.Structs.Single(s => s.Name == "Tags");
        Assert.True(tagsType.TryGetField("tags", out var tagsField));
        Assert.IsType<SliceTypeSymbol>(tagsField.Type);
        var slice = (SliceTypeSymbol)tagsField.Type;
        Assert.Same(TypeSymbol.String, slice.ElementType);

        var primaryParams = tagsType.PrimaryConstructorParameters;
        var last = primaryParams[primaryParams.Length - 1];
        Assert.Equal("tags", last.Name);
        Assert.True(last.IsVariadic);
        Assert.IsType<SliceTypeSymbol>(last.Type);
    }

    // ----- Call-site binding semantics -----

    [Fact]
    public void PrimaryCtorVariadic_PacksTrailingArgs()
    {
        var result = Evaluate(@"
class Tags(name string, tags ...string) { }
let t = Tags(""project"", ""a"", ""b"", ""c"")
len(t.tags)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void PrimaryCtorVariadic_EmptyTrailing_ProducesEmptySlice()
    {
        var result = Evaluate(@"
class Tags(name string, tags ...string) { }
let t = Tags(""project"")
len(t.tags)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void PrimaryCtorVariadic_SingleSliceArg_PassesThrough()
    {
        var result = Evaluate(@"
class Tags(name string, tags ...string) { }
let arr = []string{""x"", ""y""}
let t = Tags(""pass"", arr)
len(t.tags)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void PrimaryCtorVariadic_PassThrough_PreservesIdentity()
    {
        // Pass-through: the field's array is the same reference as the
        // caller-supplied array — mutating one is visible on the other.
        var result = Evaluate(@"
class Tags(name string, tags ...string) { }
let arr = []string{""one"", ""two""}
let t = Tags(""x"", arr)
arr[0] = ""ONE""
t.tags[0]
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("ONE", result.Value);
    }

    [Fact]
    public void PrimaryCtorVariadic_OnlyVariadicParam_PacksAll()
    {
        var result = Evaluate(@"
class Words(values ...string) { }
let w = Words(""a"", ""b"", ""c"", ""d"")
len(w.values)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void PrimaryCtorVariadic_OnlyVariadicParam_EmptyCall()
    {
        var result = Evaluate(@"
class Words(values ...string) { }
let w = Words()
len(w.values)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void PrimaryCtorVariadic_OnGenericClass_InfersElementType()
    {
        var result = Evaluate(@"
class Box[T](first T, rest ...T) { }
let b = Box(10, 20, 30)
len(b.rest)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void PrimaryCtorVariadic_OnGenericClass_EmptyPack_NeedsExplicitTypeArg()
    {
        var result = Evaluate(@"
class Box[T](first T, rest ...T) { }
let b = Box[int32](5)
len(b.rest)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void PrimaryCtorVariadic_OnGenericClass_SinglePassThrough_InfersFromSlice()
    {
        var result = Evaluate(@"
class Box[T](first T, rest ...T) { }
let arr = []int32{100, 200}
let b = Box(7, arr)
len(b.rest)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void PrimaryCtorVariadic_TooFewFixedArgs_ReportsDiagnostic()
    {
        var result = Evaluate(@"
class TwoFixedAndVariadic(a int32, b int32, rest ...int32) { }
let x = TwoFixedAndVariadic(1)
0
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void PrimaryCtorVariadic_WrongElementType_ReportsDiagnostic()
    {
        var result = Evaluate(@"
class Nums(values ...int32) { }
let x = Nums(1, ""x"", 3)
0
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void PrimaryCtorVariadic_OnDataClass_PacksAndComparesByReference()
    {
        var result = Evaluate(@"
data class Person(name string, hobbies ...string) { }
let p = Person(""Alice"", ""reading"", ""hiking"")
len(p.hobbies)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void PrimaryCtorVariadic_OnInlineStruct_PromotesSliceField()
    {
        var (compilation, _) = Compile(@"
package P
inline struct Ids(values ...int32) { }
");
        var idsType = compilation.GlobalScope.Structs.Single(s => s.Name == "Ids");
        Assert.True(idsType.TryGetField("values", out var valuesField));
        Assert.IsType<SliceTypeSymbol>(valuesField.Type);
    }

    [Fact]
    public void PrimaryCtorVariadic_NamedArguments_Rejected()
    {
        // Named arguments are not legal at a variadic primary-ctor call site
        // (the trailing slot consumes any number of positional arguments).
        var result = Evaluate(@"
class Tags(name string, tags ...string) { }
let t = Tags(name: ""a"", tags: ""b"")
0
");
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        // Mirrors VariadicTests.Evaluate — `len(...)` lives behind the
        // Gsharp.Extensions.Go gate.
        var syntaxTree = SyntaxTree.Parse(SourceText.From("import Gsharp.Extensions.Go\n" + source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static System.Collections.Immutable.ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, System.Collections.Immutable.ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics;
    }

    private static (Compilation compilation, System.Collections.Immutable.ImmutableArray<Diagnostic> diagnostics) Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var diagnostics = compilation.GlobalScope.Diagnostics;
        return (compilation, diagnostics);
    }
}
