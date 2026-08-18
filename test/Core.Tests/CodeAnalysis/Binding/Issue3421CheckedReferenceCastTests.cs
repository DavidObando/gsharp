// <copyright file="Issue3421CheckedReferenceCastTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection.Emit;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Issue #3421 checked reference conversion-call coverage.</summary>
public sealed class Issue3421CheckedReferenceCastTests
{
    [Fact]
    public void BinderClassifiesReferenceDowncastsAsExplicit()
    {
        var baseType = GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.FromClrType(typeof(Exception));
        var derivedType = GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.FromClrType(typeof(ArgumentException));
        var interfaceType = GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.FromClrType(typeof(ICloneable));
        var nullableBase = GSharp.Core.CodeAnalysis.Symbols.NullableTypeSymbol.Get(baseType);
        var nullableDerived = GSharp.Core.CodeAnalysis.Symbols.NullableTypeSymbol.Get(derivedType);

        Assert.True(Conversion.Classify(baseType, derivedType).IsExplicit);
        Assert.True(Conversion.Classify(nullableBase, nullableDerived).IsExplicit);
        Assert.True(Conversion.Classify(interfaceType, derivedType).IsExplicit);
        Assert.True(Conversion.Classify(
            GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.FromClrType(typeof(object[])),
            GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.FromClrType(typeof(string[]))).IsExplicit);
        Assert.True(Conversion.Classify(
            GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.FromClrType(typeof(IUnrelated3421)),
            GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.FromClrType(typeof(OpenReference3421))).IsExplicit);
        Assert.False(Conversion.Classify(
            GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.FromClrType(typeof(IUnrelated3421)),
            GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.FromClrType(typeof(SealedReference3421))).Exists);
        Assert.False(Conversion.Classify(
            GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.String,
            GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.FromClrType(typeof(Uri))).Exists);
    }

    [Fact]
    public void BinderAcceptsClassInterfaceNullableAndGenericForms()
    {
        var result = EmittedOracle.Evaluate(
            new[]
            {
                """
                import System.Collections.Generic

                open class Base3421 {}
                interface IMarker3421 {}
                class Derived3421 : Base3421, IMarker3421 {}

                func FromBase(value Base3421) Derived3421 -> Derived3421(value)
                func FromInterface(value IMarker3421) Derived3421 -> Derived3421(value)
                func FromNullable(value Base3421?) Derived3421? -> Derived3421?(value)
                func FromGeneric[T Base3421](value Base3421) T -> T(value)

                open class GenericBase3421[T] {}
                class GenericDerived3421[T] : GenericBase3421[T] {}
                func FromConstructed(
                    value GenericBase3421[int32]
                ) GenericDerived3421[int32] -> GenericDerived3421[int32](value)

                func FromImportedGeneric(value object) List[int32] -> List[int32](value)
                func FromImportedGenericNullable(value object?) List[int32]? -> List[int32]?(value)

                interface IOut3421[out T] {}
                func FromGenericInterface(
                    value IOut3421[object]
                ) IOut3421[string] -> IOut3421[string](value)
                func FromArray(value []object) []string -> []string(value)
                """,
            },
            new EmittedOracleOptions { IsLibrary = true });

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void EmitterUsesCastclassForConcreteReferenceDowncast()
    {
        var result = EmittedOracle.Evaluate("""
            open class Base3421 {}
            class Derived3421 : Base3421 {}

            func Cast3421(value Base3421) Derived3421 -> Derived3421(value)
            let value Base3421 = Derived3421()
            Cast3421(value)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.NotNull(result.Assembly);
        var method = Assert.Single(
            result.Assembly.GetTypes()
                .SelectMany(type => type.GetMethods()),
            candidate => candidate.Name == "Cast3421");
        var body = method.GetMethodBody();
        Assert.NotNull(body);
        var il = body.GetILAsByteArray();
        Assert.NotNull(il);
        Assert.Contains(unchecked((byte)OpCodes.Castclass.Value), il);
    }

    [Fact]
    public void ApplicableSingleArgumentConstructorStillWins()
    {
        var result = EmittedOracle.Evaluate("""
            class Wrapper3421(value object) {}

            func Construct3421(value object) Wrapper3421 -> Wrapper3421(value)
            Construct3421("payload")
            """);

        Assert.Empty(result.Diagnostics);
        Assert.NotNull(result.Assembly);
        var method = Assert.Single(
            result.Assembly.GetTypes()
                .SelectMany(type => type.GetMethods()),
            candidate => candidate.Name == "Construct3421");
        var body = method.GetMethodBody();
        Assert.NotNull(body);
        var il = body.GetILAsByteArray();
        Assert.NotNull(il);
        Assert.Contains(unchecked((byte)OpCodes.Newobj.Value), il);
        Assert.DoesNotContain(unchecked((byte)OpCodes.Castclass.Value), il);
    }

    [Fact]
    public void RuntimePreservesSuccessFailureNullInterfaceAndGenericSemantics()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            import System.Collections.Generic

            interface IMarker3421 {}
            open class Base3421 {}
            class Derived3421 : Base3421, IMarker3421 {
                prop Value int32 -> 42
            }
            class Other3421 : Base3421, IMarker3421 {}
            interface IOut3421[out T] {}
            class StringOut3421 : IOut3421[string] {}
            open class GenericBase3421[T] {}
            class GenericDerived3421[T] : GenericBase3421[T] {}

            func FromBase(value Base3421) Derived3421 -> Derived3421(value)
            func FromInterface(value IMarker3421) Derived3421 -> Derived3421(value)
            func FromGeneric[T Base3421](value Base3421) T -> T(value)
            func FromConstructed(
                value GenericBase3421[int32]
            ) GenericDerived3421[int32] -> GenericDerived3421[int32](value)
            func FromImportedGeneric(value object) List[int32] -> List[int32](value)
            func FromGenericInterface(
                value IOut3421[object]
            ) IOut3421[string] -> IOut3421[string](value)

            let derived Base3421 = Derived3421()
            Console.WriteLine(FromBase(derived).Value)
            Console.WriteLine(FromInterface(Derived3421()).Value)
            Console.WriteLine(FromGeneric[Derived3421](derived) is Derived3421)
            let genericBase GenericBase3421[int32] = GenericDerived3421[int32]()
            Console.WriteLine(FromConstructed(genericBase) is GenericDerived3421[int32])
            let imported object = List[int32]()
            Console.WriteLine(FromImportedGeneric(imported).Count)
            let wide IOut3421[object] = StringOut3421()
            Console.WriteLine(FromGenericInterface(wide) is IOut3421[string])
            let arrayObject object = []string{"array"}
            let wideArray = []object(arrayObject)
            Console.WriteLine([]string(wideArray)[0])

            let missing Base3421? = nil
            Console.WriteLine(Derived3421?(missing) == nil)

            try {
                let wrong Base3421 = Other3421()
                Console.WriteLine(Derived3421(wrong).Value)
            } catch (e InvalidCastException) {
                Console.WriteLine(e.GetType().Name)
            }

            try {
                let wrong IMarker3421 = Other3421()
                Console.WriteLine(Derived3421?(wrong) == nil)
            } catch (e InvalidCastException) {
                Console.WriteLine(e.GetType().Name)
            }
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "42",
                "42",
                "True",
                "True",
                "0",
                "True",
                "array",
                "True",
                "InvalidCastException",
                "InvalidCastException") + Environment.NewLine,
            result.Output);
        Assert.Equal(string.Empty, result.ErrorOutput);
        Assert.Equal(0, result.ExitCode);
    }

    private interface IUnrelated3421
    {
    }

    private class OpenReference3421
    {
    }

    private sealed class SealedReference3421
    {
    }
}
