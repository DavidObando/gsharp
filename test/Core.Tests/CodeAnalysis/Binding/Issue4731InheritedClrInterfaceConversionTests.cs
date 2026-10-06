// <copyright file="Issue4731InheritedClrInterfaceConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection.Metadata;
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
    [InlineData(typeof(object), "absent")]
    [InlineData(typeof(object), "present")]
    [InlineData(typeof(object), "null-slot")]
    [InlineData(typeof(object), "error-slot")]
    [InlineData(typeof(object), "short-vector")]
    [InlineData(typeof(object), "missing-unrelated-slot")]
    [InlineData(typeof(object), "present-nullable")]
    [InlineData(typeof(object), "missing-unrelated-slot-nullable")]
    [InlineData(typeof(string), "absent")]
    [InlineData(typeof(string), "present")]
    [InlineData(typeof(string), "null-slot")]
    [InlineData(typeof(string), "error-slot")]
    [InlineData(typeof(string), "short-vector")]
    [InlineData(typeof(string), "missing-unrelated-slot")]
    [InlineData(typeof(string), "present-nullable")]
    [InlineData(typeof(string), "missing-unrelated-slot-nullable")]
    [InlineData(typeof(int), "absent")]
    [InlineData(typeof(int), "present")]
    [InlineData(typeof(int), "null-slot")]
    [InlineData(typeof(int), "error-slot")]
    [InlineData(typeof(int), "short-vector")]
    [InlineData(typeof(int), "missing-unrelated-slot")]
    public void ClosedClrInference_DoesNotInventSymbolicMethodSlotAnnotations(
        Type contextType,
        string symbolicArguments)
    {
        var definition = typeof(MethodDefinition).GetMethods()
            .Single(method => method.Name == nameof(MethodDefinition.DecodeSignature));
        var closed = definition.MakeGenericMethod(typeof(string), contextType);
        Assert.Equal(contextType, closed.GetParameters()[1].ParameterType);
        Assert.Equal(
            ClrNullabilityState.NotAnnotated,
            ClrNullability.GetParameterDeclaredState(definition.GetParameters()[1]));
        var nullableContext = symbolicArguments is "present-nullable" or "missing-unrelated-slot-nullable";
        var contextSymbol = TypeSymbol.FromClrType(contextType);
        if (nullableContext)
        {
            contextSymbol = NullableTypeSymbol.Get(contextSymbol);
        }

        var arguments = symbolicArguments switch
        {
            "absent" => default,
            "present" or "present-nullable" => ImmutableArray.Create<TypeSymbol>(TypeSymbol.String, contextSymbol),
            "null-slot" => ImmutableArray.Create<TypeSymbol>(TypeSymbol.String, null),
            "error-slot" => ImmutableArray.Create<TypeSymbol>(TypeSymbol.String, TypeSymbol.Error),
            "short-vector" => ImmutableArray.Create<TypeSymbol>(TypeSymbol.String),
            "missing-unrelated-slot" or "missing-unrelated-slot-nullable" => ImmutableArray.Create<TypeSymbol>(null, contextSymbol),
            _ => throw new ArgumentOutOfRangeException(nameof(symbolicArguments)),
        };
        var target = MemberLookup.GetClrMethodParameterConversionTargetTypeSymbol(
            TypeSymbol.FromClrType(typeof(MethodDefinition)),
            closed,
            1,
            arguments);

        if (symbolicArguments is "present" or "missing-unrelated-slot" || nullableContext)
        {
            Assert.Equal(contextSymbol, target);
        }
        else
        {
            Assert.Null(target);
        }
    }

    [Theory]
    [InlineData("ImmutableArray[int32]", "IEnumerable[object]")]
    [InlineData("ImmutableArray[List[Item]]", "IEnumerable[List[object]]")]
    public void ImportedValueWrapper_UnsafeVarianceCannotUseErasedBoxing(string sourceType, string targetType)
    {
        var compilation = Bind(
            "import System.Collections.Immutable\nclass Item {}",
            sourceType,
            targetType,
            "value");
        var error = Assert.Single(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            diagnostic => diagnostic.IsError);
        Assert.Equal("GS0155", error.Id);
    }

    [Theory]
    [InlineData("ImmutableArray[IMethodSymbol]", "value")]
    [InlineData("INamedTypeSymbol", "value.InstanceConstructors")]
    [InlineData("IMethodSymbol", "value.ExplicitInterfaceImplementations")]
    public void ImportedValueWrapper_InterfaceProjectionPreservesCovariance(string sourceType, string expression)
    {
        var tree = SyntaxTree.Parse(SourceText.From($"""
            package Issue4731.ImportedValueProjection
            import System.Collections.Generic
            import System.Collections.Immutable
            import Microsoft.CodeAnalysis
            func Convert(value {sourceType}) IEnumerable[ISymbol] -> {expression}
            """));
        var references = ReferenceResolver.WithReferences(
            new[] { typeof(Microsoft.CodeAnalysis.IMethodSymbol).Assembly.Location });
        var compilation = new Compilation(references, tree) { Nullability = NullabilityMode.PlatformTypes };
        Assert.DoesNotContain(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            value => value.IsError);
    }

    [Theory]
    [InlineData("sequence[List[Item]]", "sequence[List[object]]", "GS0155")]
    [InlineData("sequence[List[Item]]", "IEnumerable[List[object]]", "GS0155")]
    [InlineData("async sequence[List[Item]]", "async sequence[List[object]]", "GS0155")]
    [InlineData("async sequence[List[Item]]", "IAsyncEnumerable[List[object]]", "GS0155")]
    [InlineData("sequence[sequence[List[Item]]]", "sequence[sequence[List[object]]]", "GS0155")]
    [InlineData("sequence[List[Item]?]", "sequence[List[object]?]", "GS0155")]
    [InlineData("sequence[(Item, int32)]", "sequence[(object, int32)]", "GS0156")]
    [InlineData("sequence[List[(Item, int32)]]", "sequence[List[(object, int32)]]", "GS0155")]
    [InlineData("async sequence[(Item, int32)]", "async sequence[(object, int32)]", "GS0156")]
    [InlineData("sequence[[3]int32]", "sequence[[4]int32]", "GS0155")]
    [InlineData("async sequence[[3]int32]", "IAsyncEnumerable[[4]int32]", "GS0155")]
    [InlineData("sequence[[]int32]", "sequence[[3]int32]", "GS0155")]
    [InlineData("sequence[List[[]Item]]", "sequence[List[[]object]]", "GS0155")]
    public void NestedInvariantSequenceElements_CannotUseErasedClrIdentity(
        string sourceType,
        string targetType,
        string diagnostic)
    {
        var compilation = Bind("class Item {}", sourceType, targetType, "value");
        var error = Assert.Single(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            diagnostic => diagnostic.IsError);
        Assert.Equal(diagnostic, error.Id);
    }

    [Theory]
    [InlineData("sequence[Item]", "IEnumerable[object]")]
    [InlineData("sequence[Item]", "sequence[object]")]
    [InlineData("IEnumerable[Item]", "sequence[object]")]
    [InlineData("async sequence[Item]", "IAsyncEnumerable[object]")]
    [InlineData("async sequence[Item]", "async sequence[object]")]
    [InlineData("sequence[List[Item]]", "IEnumerable[List[Item]]")]
    [InlineData("sequence[IEnumerable[Item]]", "IEnumerable[IEnumerable[object]]")]
    [InlineData("sequence[(Item, int32)]", "IEnumerable[(Item, int32)]")]
    [InlineData("sequence[[3]int32]", "IEnumerable[[3]int32]")]
    [InlineData("sequence[List[(Item, int32)]]", "IEnumerable[List[(Item, int32)]]")]
    public void ReifiedSequenceSource_SharedImportedVarianceAcceptsReferenceElements(string sourceType, string targetType)
    {
        var compilation = Bind("class Item {}", sourceType, targetType, "value");
        Assert.Empty(compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics));
    }

    [Theory]
    [InlineData("sequence[T]", "IEnumerable[object]", "[T]")]
    [InlineData("sequence[T]", "sequence[object]", "[T]")]
    [InlineData("async sequence[T]", "IAsyncEnumerable[object]", "[T]")]
    [InlineData("sequence[int32]", "IEnumerable[object]", "")]
    [InlineData("async sequence[int32]", "IAsyncEnumerable[object]", "")]
    public void ReifiedSequenceSource_SharedVarianceRejectsValueOrUnconstrainedElements(
        string sourceType,
        string targetType,
        string typeParameters)
    {
        var compilation = Bind("", sourceType, targetType, "value", typeParameters);
        var error = Assert.Single(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            diagnostic => diagnostic.IsError);
        Assert.Equal("GS0156", error.Id);
    }

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
