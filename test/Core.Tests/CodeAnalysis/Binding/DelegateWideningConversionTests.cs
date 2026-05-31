// <copyright file="DelegateWideningConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #323: a delegate-typed value (a named/generic CLR delegate such as
/// <c>Func[string]</c> or a GSharp <c>func</c> literal) widens implicitly to
/// <see cref="System.Delegate"/> and <see cref="System.MulticastDelegate"/>,
/// the common base types of every delegate. These tests pin
/// <see cref="Conversion.Classify"/> so the reference-widening rule is not lost
/// in a future refactor.
/// </summary>
public class DelegateWideningConversionTests
{
    public static TheoryData<Type> DelegateBaseTypes() => new()
    {
        typeof(Delegate),
        typeof(MulticastDelegate),
    };

    [Theory]
    [MemberData(nameof(DelegateBaseTypes))]
    public void NamedDelegateValueWidensImplicitly(Type baseType)
    {
        var from = ImportedTypeSymbol.Get(typeof(Func<string>));
        var to = ImportedTypeSymbol.Get(baseType);

        var conversion = Conversion.Classify(from, to);

        Assert.True(conversion.Exists);
        Assert.True(conversion.IsImplicit);
        Assert.False(conversion.IsIdentity);
    }

    [Theory]
    [MemberData(nameof(DelegateBaseTypes))]
    public void FunctionLiteralTypeWidensImplicitly(Type baseType)
    {
        var from = FunctionTypeSymbol.Get(ImmutableArray<TypeSymbol>.Empty, TypeSymbol.String);
        var to = ImportedTypeSymbol.Get(baseType);

        var conversion = Conversion.Classify(from, to);

        Assert.True(conversion.Exists);
        Assert.True(conversion.IsImplicit);
    }

    [Fact]
    public void NonDelegateValueDoesNotWidenToSystemDelegate()
    {
        var from = TypeSymbol.Int32;
        var to = ImportedTypeSymbol.Get(typeof(Delegate));

        var conversion = Conversion.Classify(from, to);

        Assert.False(conversion.Exists);
    }
}
