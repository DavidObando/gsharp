// <copyright file="Issue3866UserDefinedConversionVsObjectTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3866: `List[EntityHandle].Add(x)`, where `x` reaches
/// `EntityHandle` through a user-defined `op_Implicit`, bound to the
/// NON-GENERIC `System.Collections.IList.Add(object)` face instead of
/// `Add(T)`.
///
/// `ClrOverloadResolution.CompareConversions` ranked candidates by
/// the ordinal of (cref:object)-taking
/// `ImplicitConversionKind.Boxing` (4) against
/// `ImplicitConversionKind.UserDefinedImplicit` (6) and so preferred
/// boxing to `object`. C# §12.6.4.5 ranks by "better conversion target",
/// not by the mechanism of the conversion, and `System.Object` is the
/// least specific target there is.
///
/// The divergence was SILENT at compile time: the migrated
/// `Gsharp.HotReload.Runtime.HotReloadDeltaBuilder.MapStandaloneSignature`
/// compiled and passed ILVerify, then threw
/// `ArgumentException: The value "System.Reflection.Metadata.StandaloneSignatureHandle"
/// is not of type "System.Reflection.Metadata.EntityHandle"` from
/// `List<T>.IList.Add` at run time. So these tests EXECUTE: binding
/// alone cannot tell the two faces apart.
open class Issue3866UserDefinedConversionVsObjectTests {
    /// The exact BCL shape the migrated `HotReloadDeltaBuilder` hit:
    /// `StandaloneSignatureHandle` has an `op_Implicit` to
    /// `EntityHandle`, and `List<EntityHandle>` exposes both
    /// `Add(EntityHandle)` and `IList.Add(object)`. On
    /// `origin/main` this throws (cref:System.ArgumentException).
    @Fact
    func ListAdd_ImportedHandleWithImplicitConversion_BindsToGenericAdd() {
        let source = `
import System
import System.Collections.Generic
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

func run() int32 {
    let list = List[EntityHandle]()
    let handle = MetadataTokens.StandaloneSignatureHandle(1)

    // On main this bound to IList.Add(object) and threw at run time.
    list.Add(handle)

    if list.Count != 1 {
        return -10
    }

    // The stored element must be a real EntityHandle, not a boxed
    // StandaloneSignatureHandle: reading it back through the generic indexer
    // is what proves the element type was converted rather than boxed.
    if list[0].Kind != HandleKind.StandaloneSignature {
        return -20
    }

    if MetadataTokens.GetToken(list[0]) != MetadataTokens.GetToken(handle) {
        return -30
    }

    return 1
}

run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(1, result.Value)
    }

    /// The same ranking question with source-declared types, so the rule is
    /// pinned independently of any BCL detail: a G# `func operator implicit`
    /// target must beat an `object` parameter on the same argument.
    @Fact
    func OverloadPair_UserDefinedConversionTarget_BeatsObjectParameter() {
        let source = (`
import System

struct Wrapped {
    var value int32
}

struct Payload {
    var value int32
}

func operator implicit (w Wrapped) Payload {
    return Payload{value: w.value}
}

func Accept(p Payload) int32 { return p.value }
func Accept(o object) int32 { return -1 }

func run() int32 {
    let w = Wrapped{value: 7}

    // ` + "`" + `Wrapped -> Payload` + "`" + ` is user-defined; ` + "`" + `Wrapped -> object` + "`" + ` is boxing.
    // Payload is the better conversion target, so the Payload overload wins.
    if Accept(w) != 7 {
        return -10
    }

    // A value with no better target still reaches the object overload.
    if Accept("s") != -1 {
        return -20
    }

    return 1
}

run()
`)
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(1, result.Value)
    }

    /// Anti-vacuity guard rail: an argument whose ONLY conversion to the
    /// candidate set is boxing must still reach the `object` overload, and
    /// an exact match must still beat both. This test passes on
    /// `origin/main` — it exists so the fix above cannot be "everything
    /// now prefers the non-object candidate".
    @Fact
    func OverloadPair_ObjectCandidate_StillWinsWhenItIsTheOnlyApplicableOne() {
        let source = `
import System

struct Unrelated {
    var value int32
}

func Accept(s string) int32 { return 1 }
func Accept(o object) int32 { return 2 }

func run() int32 {
    if Accept("s") != 1 {
        return -10
    }

    if Accept(Unrelated{value: 3}) != 2 {
        return -20
    }

    if Accept(42) != 2 {
        return -30
    }

    return 1
}

run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(1, result.Value)
    }
}
