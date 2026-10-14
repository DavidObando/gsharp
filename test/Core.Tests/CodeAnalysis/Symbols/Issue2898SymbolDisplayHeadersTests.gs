// <copyright file="Issue2898SymbolDisplayHeadersTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #2898: source declaration headers and constructed nested enums.
open class Issue2898SymbolDisplayHeadersTests {
    @Fact
    func DeclarationHeaders_UseSquareBracketsAndConstructedArguments() {
        let compilation = Compile(`package P
class Box[T] { var Value T }
func Identity[T](value T) T { return value }
func Use(value Box[int32]) {}`)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
        let definition = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Box")
        let identity = compilation.GlobalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Identity")
        let constructed = compilation
            .GlobalScope
            .Functions
            .Single((f FunctionSymbol) -> f.Name == "Use")
            .Parameters
            .Single()
            .Type
        Assert.Equal(
            "class P.Box[T] { var Value T }",
            SymbolDisplay.ToDisplayString(definition, SymbolDisplayFormat.Hover)
        )
        Assert.Equal("func Identity[T](value T) T", SymbolDisplay.ToDisplayString(identity, SymbolDisplayFormat.Hover))
        Assert.Equal(
            "class P.Box[int32] { var Value int32 }",
            SymbolDisplay.ToDisplayString(constructed, SymbolDisplayFormat.Hover)
        )
    }

    @Fact
    func ConstructedNestedEnums_PreserveIdentityDisplayMemberTypeAndValue() {
        let compilation = Compile(`package P
struct Outer[T] { enum Color { Red } }
func I(c Outer[int32].Color) Outer[int32].Color { return Outer[int32].Color.Red }
func S(c Outer[string].Color) Outer[string].Color { return Outer[string].Color.Red }`)
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
        let intFunction = compilation.GlobalScope.Functions.Single((f FunctionSymbol) -> f.Name == "I")
        let stringFunction = compilation.GlobalScope.Functions.Single((f FunctionSymbol) -> f.Name == "S")
        let intEnum = Assert.IsType[EnumSymbol](intFunction.Parameters.Single().Type)
        let stringEnum = Assert.IsType[EnumSymbol](stringFunction.Parameters.Single().Type)
        Assert.NotSame(intEnum, stringEnum)
        Assert.Same(intEnum.Definition, intEnum.Definition!!.Definition)
        Assert.Same(intEnum.Definition, stringEnum.Definition)
        Assert.Equal("int32", Assert.Single(intEnum.EnclosingTypeArguments).Name)
        Assert.Equal("string", Assert.Single(stringEnum.EnclosingTypeArguments).Name)
        Assert.Equal("Outer[int32].Color", SymbolDisplay.ToTypeDisplayString(intEnum))
        Assert.Equal("Outer[string].Color", SymbolDisplay.ToTypeDisplayString(stringEnum))
        Assert.Equal(
            "enum P.Outer[int32].Color { Red }",
            SymbolDisplay.ToDisplayString(intEnum, SymbolDisplayFormat.Hover)
        )
        Assert.Equal(
            "enum P.Outer[string].Color { Red }",
            SymbolDisplay.ToDisplayString(stringEnum, SymbolDisplayFormat.Hover)
        )
        let outerDefinition = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Outer")
        let openEnum = EnumSymbol.ConstructNested(
            intEnum.Definition,
            ImmutableArray.Create[TypeSymbol](Assert.Single(outerDefinition.TypeParameters))
        )
        Assert.True(TypeSymbol.ContainsTypeParameter(openEnum!!))
        Assert.False(TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(intEnum, stringEnum))
        Assert.True(
            TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                stringEnum,
                EnumSymbol.ConstructNested(
                    stringEnum.Definition,
                    ImmutableArray.Create[TypeSymbol](NullableTypeSymbol.Get(TypeSymbol.String))
                )!!
            )
        )
        let intOuter = StructSymbol.Construct(outerDefinition, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        Assert.Same(intEnum, intOuter.SubstituteMemberType(intEnum.Definition))
        Assert.Same(
            intEnum,
            Binder.SubstituteType(
                intEnum.Definition!!,
                Dictionary[TypeParameterSymbol, TypeSymbol]{
                    [Assert.Single(outerDefinition.TypeParameters)] = TypeSymbol.Int32
                }
            )
        )
        AssertEnumLiteral(compilation, "I", intEnum)
        AssertEnumLiteral(compilation, "S", stringEnum)
    }

    @Fact
    func ComposedTypeSpellings_AreDistinctExceptCanonicalResidualCollisions() {
        let compilation = Compile(`package P
class Box[T] {}
struct Outer[T] {
    struct Tag {}
    enum Color { Red }
}
func Use(
    intTag Outer[int32].Tag,
    stringTag Outer[string].Tag,
    intColor Outer[int32].Color,
    stringColor Outer[string].Color) {}`)
        let boxDefinition = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Box")
        let use = compilation.GlobalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Use")
        let intType = TypeSymbol.Int32
        let distinct = []TypeSymbol{
            SliceTypeSymbol.Get(intType),
            ArrayTypeSymbol.Get(intType, 3),
            NullableTypeSymbol.Get(ArrayTypeSymbol.Get(intType, 3)),
            ArrayTypeSymbol.Get(NullableTypeSymbol.Get(intType), 3),
            NullableTypeSymbol.Get(intType),
            PointerTypeSymbol.Get(intType),
            ChannelTypeSymbol.Get(intType),
            PinnedTypeSymbol(intType),
            StructSymbol.Construct(boxDefinition, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)),
            StructSymbol.Construct(boxDefinition, ImmutableArray.Create[TypeSymbol](TypeSymbol.String)),
            use.Parameters[0].Type,
            use.Parameters[1].Type,
            use.Parameters[2].Type,
            use.Parameters[3].Type
        }
        let spellings = distinct.Select(SymbolDisplay.ToTypeDisplayString).ToArray()
        Assert.Equal(spellings.Length, spellings.Distinct().Count())
        AssertCanonicalCollision(
            NullableTypeSymbol.Get(PointerTypeSymbol.Get(intType)),
            PointerTypeSymbol.Get(NullableTypeSymbol.Get(intType)),
            "*int32?"
        )
        // ADR-0174 D2: bracketing the element removed the one collision the
        // juxtaposed spelling could not avoid — a nullable channel and a
        // channel of nullable now have distinct canonical spellings.
        Assert.Equal(
            "chan[int32]?",
            SymbolDisplay.ToTypeDisplayString(NullableTypeSymbol.Get(ChannelTypeSymbol.Get(intType)))
        )
        Assert.Equal(
            "chan[int32?]",
            SymbolDisplay.ToTypeDisplayString(ChannelTypeSymbol.Get(NullableTypeSymbol.Get(intType)))
        )
        Assert.Equal(
            "in chan[int32]",
            SymbolDisplay.ToTypeDisplayString(ChannelTypeSymbol.Get(intType, ChannelDirection.In))
        )
        Assert.Equal(
            "out chan[int32]",
            SymbolDisplay.ToTypeDisplayString(ChannelTypeSymbol.Get(intType, ChannelDirection.Out))
        )
        AssertCanonicalCollision(
            NullableTypeSymbol.Get(PinnedTypeSymbol(intType)),
            PinnedTypeSymbol(NullableTypeSymbol.Get(intType)),
            "pinned int32?"
        )
    }

    @Fact
    func ReferenceResolverDisposal_ClearsConstructedNestedEnumCache() {
        let compilation = Compile("package P\nstruct Outer[T] { enum Color { Red } }")
        let definition = compilation.GlobalScope.Enums.Single((e EnumSymbol) -> e.Name == "Color")
        let arguments = ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
        let before = EnumSymbol.ConstructNested(definition, arguments)
        ReferenceResolver.WithReferences([]string{typeof(object).Assembly.Location}).Dispose()
        let after = EnumSymbol.ConstructNested(definition, arguments)
        Assert.NotSame(before, after)
    }

    @Fact
    func ConstructNested_NormalizesEmptyArgumentsAndConstructedDefinitions() {
        let compilation = Compile("package P\nstruct Outer[T] { enum Color { Red } }")
        let definition = compilation.GlobalScope.Enums.Single((e EnumSymbol) -> e.Name == "Color")
        Assert.Same(definition, EnumSymbol.ConstructNested(definition, ImmutableArray[TypeSymbol].Empty))
        let intConstruction = EnumSymbol.ConstructNested(
            definition,
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
        )
        let stringConstruction = EnumSymbol.ConstructNested(
            intConstruction,
            ImmutableArray.Create[TypeSymbol](TypeSymbol.String)
        )
        Assert.Same(definition, stringConstruction.Definition)
        Assert.Equal("Outer[string].Color", SymbolDisplay.ToTypeDisplayString(stringConstruction))
    }

    @Fact
    func NestedEnumSubstitution_PropagatesReferenceNullabilityErasure() {
        let compilation = Compile("package P\nstruct Outer[T] { enum Color { Red } }")
        let definition = compilation.GlobalScope.Enums.Single((e EnumSymbol) -> e.Name == "Color")
        let typeParameter = Assert.Single(
            compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Outer").TypeParameters
        )
        let openNullable = EnumSymbol.ConstructNested(
            definition,
            ImmutableArray.Create[TypeSymbol](NullableTypeSymbol.Get(typeParameter))
        )
        let substituted = Assert.IsType[EnumSymbol](
            StructSymbol.SubstituteTypeParameters(
                openNullable,
                Dictionary[TypeParameterSymbol, TypeSymbol]{[typeParameter] = TypeSymbol.String},
                eraseReferenceNullability: true
            )
        )
        Assert.Same(TypeSymbol.String, Assert.Single(substituted.EnclosingTypeArguments))
    }

    private class EnumLiteralCollector : BoundTreeWalker {
        init() {
            Literals = List[BoundLiteralExpression]()
        }

        prop Literals List[BoundLiteralExpression] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            if node is BoundLiteralExpression literal && literal.Type is EnumSymbol {
                Literals.Add(literal)
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func AssertEnumLiteral(compilation Compilation, functionName string, expectedType EnumSymbol) {
            let function = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == functionName)
            let collector = Issue2898SymbolDisplayHeadersTests.EnumLiteralCollector()
            collector.Visit(compilation.BoundProgram.Functions[function])
            let literal = Assert.Single(collector.Literals)
            Assert.Same(expectedType, literal.Type)
            Assert.Equal(0, literal.Value)
        }

        private func AssertCanonicalCollision(left TypeSymbol, right TypeSymbol, expected string) {
            Assert.Equal(expected, SymbolDisplay.ToTypeDisplayString(left))
            Assert.Equal(expected, SymbolDisplay.ToTypeDisplayString(right))
        }

        private func Compile(source string) Compilation -> Compilation(SyntaxTree.Parse(SourceText.From(source))){
            IsLibrary = true
        }
    }
}
