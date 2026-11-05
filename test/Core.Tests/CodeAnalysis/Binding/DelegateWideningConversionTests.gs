// <copyright file="DelegateWideningConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import Xunit

/// Issue #323: a delegate-typed value (a named/generic CLR delegate such as
/// `Func[string]` or a GSharp `func` literal) widens implicitly to
/// (cref:System.Delegate) and (cref:System.MulticastDelegate),
/// the common base types of every delegate. These tests pin
/// (cref:Conversion.Classify) so the reference-widening rule is not lost
/// in a future refactor.
open class DelegateWideningConversionTests {
    @Theory
    @MemberData("DelegateBaseTypes")
    func NamedDelegateValueWidensImplicitly(baseType Type) {
        let from = ImportedTypeSymbol.Get(typeof(() -> string))
        let to = ImportedTypeSymbol.Get(baseType)
        let conversion = Conversion.Classify(from, to)
        Assert.True(conversion.Exists)
        Assert.True(conversion.IsImplicit)
        Assert.False(conversion.IsIdentity)
    }

    @Theory
    @MemberData("DelegateBaseTypes")
    func FunctionLiteralTypeWidensImplicitly(baseType Type) {
        let from = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, TypeSymbol.String)
        let to = ImportedTypeSymbol.Get(baseType)
        let conversion = Conversion.Classify(from, to)
        Assert.True(conversion.Exists)
        Assert.True(conversion.IsImplicit)
    }

    @Fact
    func NonDelegateValueDoesNotWidenToSystemDelegate() {
        let from = TypeSymbol.Int32
        let to = ImportedTypeSymbol.Get(typeof(Delegate))
        let conversion = Conversion.Classify(from, to)
        Assert.False(conversion.Exists)
    }

    @Fact
    func SourceElementFunctionDelegateAndChannel_WidenToObject_AndImportedFuncConvertsToArrow() {
        let animal = StructSymbol(
            "Animal",
            ImmutableArray[FieldSymbol].Empty,
            Accessibility.Public,
            nil,
            "probe",
            true,
            false,
            true
        )
        let dog = StructSymbol(
            "Dog",
            ImmutableArray[FieldSymbol].Empty,
            Accessibility.Public,
            nil,
            "probe",
            false,
            false,
            true
        )
        dog.SetBaseClass(animal)
        let handler = DelegateTypeSymbol(
            "Handler",
            "probe",
            Accessibility.Public,
            ImmutableArray.Create(ParameterSymbol("x", dog)),
            dog,
            nil
        )
        let arrow = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](dog), dog)
        let channel = ChannelTypeSymbol.Get(dog)
        for source in[]TypeSymbol{arrow, handler, channel} {
            let toObject = Conversion.Classify(source, TypeSymbol.Object)
            Assert.True(toObject.IsImplicit)
            Assert.False(toObject.IsIdentity)
            let toNullableObject = Conversion.Classify(source, NullableTypeSymbol.Get(TypeSymbol.Object))
            Assert.True(toNullableObject.IsImplicit)
        }
        let funcDog = ImportedTypeSymbol.GetConstructed(
            typeof(Func[object]),
            typeof(Func[_]),
            ImmutableArray.Create[TypeSymbol](dog)
        )
        let funcAnimal = ImportedTypeSymbol.GetConstructed(
            typeof(Func[object]),
            typeof(Func[_]),
            ImmutableArray.Create[TypeSymbol](animal)
        )
        let actionAnimal = ImportedTypeSymbol.GetConstructed(
            typeof(Action[object]),
            typeof(Action[_]),
            ImmutableArray.Create[TypeSymbol](animal)
        )
        let actionDog = ImportedTypeSymbol.GetConstructed(
            typeof(Action[object]),
            typeof(Action[_]),
            ImmutableArray.Create[TypeSymbol](dog)
        )
        let arrowDog = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, dog)
        let arrowAnimal = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, animal)
        let arrowVoidDog = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](dog), TypeSymbol.Void)
        let arrowVoidAnimal = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](animal), TypeSymbol.Void)
        Assert.True(Conversion.Classify(funcDog, arrowDog).IsImplicit)
        Assert.True(Conversion.Classify(funcDog, arrowAnimal).IsImplicit)
        Assert.True(Conversion.Classify(actionAnimal, arrowVoidDog).IsImplicit)
        Assert.True(Conversion.ReusesFunctionValueDelegate(funcDog, arrowDog))
        Assert.True(Conversion.ReusesFunctionValueDelegate(funcDog, arrowAnimal))
        Assert.True(Conversion.ReusesFunctionValueDelegate(actionAnimal, arrowVoidDog))
        Assert.False(Conversion.Classify(funcAnimal, arrowDog).IsImplicit)
        Assert.False(Conversion.Classify(actionDog, arrowVoidAnimal).IsImplicit)
    }

    shared {
        func DelegateBaseTypes() TheoryData[Type] -> TheoryData[Type]{typeof(Delegate), typeof(MulticastDelegate)}
    }
}
