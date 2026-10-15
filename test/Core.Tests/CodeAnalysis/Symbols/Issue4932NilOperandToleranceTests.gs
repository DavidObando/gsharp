// <copyright file="Issue4932NilOperandToleranceTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Reflection
import Xunit

/// Issue #4932: the cut-over self-migration asserted (`!!`) operands that the
/// C# passed on and then null-tested, so these helpers threw a
/// NullReferenceException for a nil operand where the C# returned a
/// "nothing found" / "not equivalent" answer. Each test fails if the
/// assertion is put back.
class Issue4932NilOperandToleranceTests {
    private let Flags BindingFlags = BindingFlags.Public | BindingFlags.Instance

    @Fact
    func SafeGetEventIncludingInterfaces_NilType_ReturnsNil() {
        Assert.Null(ClrTypeUtilities.SafeGetEventIncludingInterfaces(nil, "Changed", Flags))
    }

    @Fact
    func SafeGetPropertyIncludingInterfaces_NilType_ReturnsNil() {
        Assert.Null(ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(nil, "Length", Flags))
    }

    @Fact
    func SafeGetMethodsIncludingInterfaces_NilType_ReturnsEmpty() {
        Assert.Empty(ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(nil, Flags))
    }

    @Fact
    func IncludingInterfacesLookups_NonNilType_StillFindMembers() {
        Assert.NotNull(ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(typeof(string), "Length", Flags))
        Assert.NotEmpty(ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(typeof(string), Flags))
    }

    @Fact
    func AreRuntimeEquivalentIgnoringReferenceNullability_NilOperands_CompareWithoutThrowing() {
        Assert.True(TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(nil, nil))
        Assert.False(TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(nil, TypeSymbol.String))
        Assert.False(TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(TypeSymbol.String, nil))
    }
}
