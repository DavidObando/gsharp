// <copyright file="Issue4731InheritedClrInterfaceConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue4731InheritedClrInterfaceConversionTests
{
    [Theory]
    [InlineData("class Leaf : ArrayList {}", "Leaf", "IEnumerable", "value")]
    [InlineData("class Leaf : ArrayList {}", "Leaf", "IEnumerable", "cast[IEnumerable](value)")]
    [InlineData("open class Mid : ArrayList {}\nclass Leaf : Mid {}", "Leaf", "IEnumerable", "value")]
    [InlineData("open class Mid : ArrayList {}\nclass Leaf : Mid {}", "Leaf", "IEnumerable", "cast[IEnumerable](value)")]
    [InlineData("class Leaf : List[string] {}", "Leaf", "IEnumerable[object]", "value")]
    [InlineData("class Leaf : List[string] {}", "Leaf", "IEnumerable[object]", "cast[IEnumerable[object]](value)")]
    [InlineData("class Leaf : List[string] {}", "Leaf", "sequence[object]", "value")]
    [InlineData("class Leaf : List[string] {}", "Leaf", "sequence[object]", "cast[sequence[object]](value)")]
    [InlineData("class Leaf : List[int32?] {}", "Leaf", "IEnumerable[int32?]", "value")]
    [InlineData("class Leaf : List[int32?] {}", "Leaf", "sequence[int32?]", "value")]
    [InlineData("class Leaf : ArrayList {}", "Leaf?", "IEnumerable?", "value")]
    [InlineData("class Leaf : ArrayList {}", "Leaf?", "IEnumerable", "cast[IEnumerable](value)")]
    [InlineData("class Leaf : ArrayList {}", "Leaf", "ArrayList", "value")]
    [InlineData("class Leaf : ArrayList, IEnumerable {}", "Leaf", "IEnumerable", "value")]
    public void InheritedInterface_ImplicitAndCheckedConversionsBind(
        string declarations,
        string sourceType,
        string targetType,
        string expression)
    {
        var compilation = Bind(declarations, sourceType, targetType, expression);
        Assert.Empty(compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics));
    }

    [Theory]
    [InlineData("value")]
    [InlineData("cast[IEnumerable[T]](value)")]
    public void GenericImportedOwner_SubstitutesTheInScopeTypeParameter(string expression)
    {
        var compilation = Bind(
            "open class Mid[T] : List[T] {}\nclass Leaf[T] : Mid[T] {}",
            "Leaf[T]",
            "IEnumerable[T]",
            expression,
            "[T]");
        Assert.Empty(compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics));
    }

    [Theory]
    [InlineData("value")]
    [InlineData("cast[IEnumerable[Item]](value)")]
    public void GenericImportedOwner_PreservesSameCompilationElementIdentity(string expression)
    {
        var compilation = Bind(
            "class Item {}\nopen class Mid[T] : List[T] {}\nclass Leaf : Mid[Item] {}",
            "Leaf",
            "IEnumerable[Item]",
            expression);
        Assert.Empty(compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics));
    }

    [Theory]
    [InlineData("value")]
    [InlineData("cast[sequence[T]](value)")]
    public void GenericSequenceAlias_PreservesTheInScopeElement(string expression)
    {
        var compilation = Bind(
            "open class Mid[T] : List[T] {}\nclass Leaf[T] : Mid[T] {}",
            "Leaf[T]",
            "sequence[T]",
            expression,
            "[T]");
        Assert.Empty(compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics));
    }

    [Theory]
    [InlineData("IEnumerable[object]", "value")]
    [InlineData("sequence[object]", "value")]
    [InlineData("sequence[object]", "cast[sequence[object]](value)")]
    public void UnconstrainedSequenceElement_CannotUseReferenceVariance(string targetType, string expression)
    {
        var compilation = Bind("class Leaf[T] : List[T] {}", "Leaf[T]", targetType, expression, "[T]");
        var error = Assert.Single(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            diagnostic => diagnostic.IsError);
        Assert.Equal("GS0155", error.Id);
    }

    [Theory]
    [InlineData("class Leaf {}", "Leaf", "IEnumerable", "value")]
    [InlineData("class Leaf {}", "Leaf", "IEnumerable", "cast[IEnumerable](value)")]
    [InlineData("class Leaf : ArrayList {}", "Leaf?", "IEnumerable", "value")]
    [InlineData("class Leaf : List[int32] {}", "Leaf", "IEnumerable[object]", "value")]
    [InlineData("class Leaf : List[object] {}", "Leaf", "IList[string]", "value")]
    [InlineData("class Item {}\nclass Other {}\nclass Leaf : List[Item] {}", "Leaf", "IEnumerable[Other]", "value")]
    [InlineData("class Item {}\nclass Other {}\nclass Leaf : List[Item] {}", "Leaf", "sequence[Other]", "value")]
    [InlineData("class Leaf : List[int32] {}", "Leaf", "sequence[object]", "value")]
    public void InvalidImplicitConversions_RemainRejected(
        string declarations,
        string sourceType,
        string targetType,
        string expression)
    {
        var compilation = Bind(declarations, sourceType, targetType, expression);
        var error = Assert.Single(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            diagnostic => diagnostic.IsError);
        Assert.Equal(sourceType == "Leaf?" ? "GS0156" : "GS0155", error.Id);
        Assert.True(error.Location.Span.Length > 0);
    }

    [Theory]
    [InlineData("IEnumerable[string]", false)]
    [InlineData("IEnumerable[string?]", true)]
    [InlineData("sequence[string]", false)]
    [InlineData("sequence[string?]", true)]
    public void SubstitutedPlatformElement_ReusesContainerNullabilityRules(string targetType, bool isImplicit)
    {
        var compilation = Bind("class Leaf[T] : List[T] {}", "Leaf[string]", targetType, "value");
        Assert.Empty(compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics));
        var definition = Assert.Single(compilation.GlobalScope.Structs, type => type.Name == "Leaf");
        var source = StructSymbol.Construct(
            definition,
            ImmutableArray.Create<TypeSymbol>(PlatformTypeSymbol.Get(TypeSymbol.String)));
        var target = Assert.Single(compilation.GlobalScope.Functions, function => function.Name == "Convert").Type;

        Assert.Equal(isImplicit, Conversion.Classify(source, target).IsImplicit);
        if (!isImplicit)
        {
            Assert.False(Conversion.Classify(source, target).Exists);
        }
    }

    private static Compilation Bind(
        string declarations,
        string sourceType,
        string targetType,
        string expression,
        string typeParameters = "")
    {
        string source = $"""
            package Issue4731
            import System.Collections
            import System.Collections.Generic

            {declarations}
            func Convert{typeParameters}(value {sourceType}) {targetType} -> {expression}
            """;
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Empty(tree.Diagnostics);
        return new Compilation(tree) { Nullability = NullabilityMode.PlatformTypes };
    }
}
