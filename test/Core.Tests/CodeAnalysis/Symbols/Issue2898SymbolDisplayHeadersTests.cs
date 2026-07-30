// <copyright file="Issue2898SymbolDisplayHeadersTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>Issue #2898: source declaration headers and constructed nested enums.</summary>
public class Issue2898SymbolDisplayHeadersTests
{
    [Fact]
    public void DeclarationHeaders_UseSquareBracketsAndConstructedArguments()
    {
        var compilation = Compile("""
            package P
            class Box[T] { var Value T }
            func Identity[T](value T) T { return value }
            func Use(value Box[int32]) {}
            """);

        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));

        var definition = compilation.GlobalScope.Structs.Single(s => s.Name == "Box");
        var identity = compilation.GlobalScope.Functions.Single(f => f.Name == "Identity");
        var constructed = compilation.GlobalScope.Functions.Single(f => f.Name == "Use").Parameters.Single().Type;

        Assert.Equal("class P.Box[T] { var Value T }", SymbolDisplay.ToDisplayString(definition, SymbolDisplayFormat.Hover));
        Assert.Equal("func Identity[T](value T) T", SymbolDisplay.ToDisplayString(identity, SymbolDisplayFormat.Hover));
        Assert.Equal("class P.Box[int32] { var Value int32 }", SymbolDisplay.ToDisplayString(constructed, SymbolDisplayFormat.Hover));
    }

    [Fact]
    public void ConstructedNestedEnums_PreserveIdentityDisplayMemberTypeAndValue()
    {
        var compilation = Compile("""
            package P
            struct Outer[T] { enum Color { Red } }
            func I(c Outer[int32].Color) Outer[int32].Color { return Outer[int32].Color.Red }
            func S(c Outer[string].Color) Outer[string].Color { return Outer[string].Color.Red }
            """);

        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));

        var intFunction = compilation.GlobalScope.Functions.Single(f => f.Name == "I");
        var stringFunction = compilation.GlobalScope.Functions.Single(f => f.Name == "S");
        var intEnum = Assert.IsType<EnumSymbol>(intFunction.Parameters.Single().Type);
        var stringEnum = Assert.IsType<EnumSymbol>(stringFunction.Parameters.Single().Type);

        Assert.NotSame(intEnum, stringEnum);
        Assert.Same(intEnum.Definition, stringEnum.Definition);
        Assert.Equal("int32", Assert.Single(intEnum.EnclosingTypeArguments).Name);
        Assert.Equal("string", Assert.Single(stringEnum.EnclosingTypeArguments).Name);
        Assert.Equal("Outer[int32].Color", SymbolDisplay.ToTypeDisplayString(intEnum));
        Assert.Equal("Outer[string].Color", SymbolDisplay.ToTypeDisplayString(stringEnum));
        Assert.Equal("enum P.Outer[int32].Color { Red }", SymbolDisplay.ToDisplayString(intEnum, SymbolDisplayFormat.Hover));
        Assert.Equal("enum P.Outer[string].Color { Red }", SymbolDisplay.ToDisplayString(stringEnum, SymbolDisplayFormat.Hover));

        var outerDefinition = compilation.GlobalScope.Structs.Single(s => s.Name == "Outer");
        var intOuter = StructSymbol.Construct(
            outerDefinition,
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));
        Assert.Same(intEnum, intOuter.SubstituteMemberType(intEnum.Definition));
        Assert.Same(
            intEnum,
            Binder.SubstituteType(
                intEnum.Definition,
                new Dictionary<TypeParameterSymbol, TypeSymbol>
                {
                    [Assert.Single(outerDefinition.TypeParameters)] = TypeSymbol.Int32,
                }));

        AssertEnumLiteral(compilation, "I", intEnum);
        AssertEnumLiteral(compilation, "S", stringEnum);
    }

    [Fact]
    public void ComposedTypeSpellings_AreDistinctExceptCanonicalResidualCollisions()
    {
        var compilation = Compile("""
            package P
            class Box[T] {}
            struct Outer[T] {
                struct Tag {}
                enum Color { Red }
            }
            func Use(
                intTag Outer[int32].Tag,
                stringTag Outer[string].Tag,
                intColor Outer[int32].Color,
                stringColor Outer[string].Color) {}
            """);
        var boxDefinition = compilation.GlobalScope.Structs.Single(s => s.Name == "Box");
        var use = compilation.GlobalScope.Functions.Single(f => f.Name == "Use");
        var intType = TypeSymbol.Int32;
        var distinct = new TypeSymbol[]
        {
            SliceTypeSymbol.Get(intType),
            ArrayTypeSymbol.Get(intType, 3),
            NullableTypeSymbol.Get(ArrayTypeSymbol.Get(intType, 3)),
            ArrayTypeSymbol.Get(NullableTypeSymbol.Get(intType), 3),
            NullableTypeSymbol.Get(intType),
            PointerTypeSymbol.Get(intType),
            ChannelTypeSymbol.Get(intType),
            new PinnedTypeSymbol(intType),
            StructSymbol.Construct(boxDefinition, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32)),
            StructSymbol.Construct(boxDefinition, ImmutableArray.Create<TypeSymbol>(TypeSymbol.String)),
            use.Parameters[0].Type,
            use.Parameters[1].Type,
            use.Parameters[2].Type,
            use.Parameters[3].Type,
        };

        var spellings = distinct.Select(SymbolDisplay.ToTypeDisplayString).ToArray();
        Assert.Equal(spellings.Length, spellings.Distinct().Count());

        AssertCanonicalCollision(
            NullableTypeSymbol.Get(PointerTypeSymbol.Get(intType)),
            PointerTypeSymbol.Get(NullableTypeSymbol.Get(intType)),
            "*int32?");
        AssertCanonicalCollision(
            NullableTypeSymbol.Get(ChannelTypeSymbol.Get(intType)),
            ChannelTypeSymbol.Get(NullableTypeSymbol.Get(intType)),
            "chan int32?");
        AssertCanonicalCollision(
            NullableTypeSymbol.Get(new PinnedTypeSymbol(intType)),
            new PinnedTypeSymbol(NullableTypeSymbol.Get(intType)),
            "pinned int32?");
    }

    [Fact]
    public void ReferenceResolverDisposal_ClearsConstructedNestedEnumCache()
    {
        var compilation = Compile("""
            package P
            struct Outer[T] { enum Color { Red } }
            """);
        var definition = compilation.GlobalScope.Enums.Single(e => e.Name == "Color");
        var arguments = ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32);
        var before = EnumSymbol.ConstructNested(definition, arguments);

        ReferenceResolver.WithReferences(new[] { typeof(object).Assembly.Location }).Dispose();

        var after = EnumSymbol.ConstructNested(definition, arguments);
        Assert.NotSame(before, after);
    }

    private static void AssertEnumLiteral(Compilation compilation, string functionName, EnumSymbol expectedType)
    {
        var function = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == functionName);
        var collector = new EnumLiteralCollector();
        collector.Visit(compilation.BoundProgram.Functions[function]);
        var literal = Assert.Single(collector.Literals);

        Assert.Same(expectedType, literal.Type);
        Assert.Equal(0, literal.Value);
    }

    private static void AssertCanonicalCollision(TypeSymbol left, TypeSymbol right, string expected)
    {
        Assert.Equal(expected, SymbolDisplay.ToTypeDisplayString(left));
        Assert.Equal(expected, SymbolDisplay.ToTypeDisplayString(right));
    }

    private static Compilation Compile(string source)
        => new(SyntaxTree.Parse(SourceText.From(source))) { IsLibrary = true };

    private sealed class EnumLiteralCollector : BoundTreeWalker
    {
        public List<BoundLiteralExpression> Literals { get; } = new();

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundLiteralExpression literal && literal.Type is EnumSymbol)
            {
                Literals.Add(literal);
            }

            base.VisitExpression(node);
        }
    }
}
