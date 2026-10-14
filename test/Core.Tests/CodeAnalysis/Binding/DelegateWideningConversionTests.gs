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

    shared {
        func DelegateBaseTypes() TheoryData[Type] -> TheoryData[Type]{typeof(Delegate), typeof(MulticastDelegate)}
    }
}
