// <copyright file="Issue3866UserDefinedConversionVsObjectTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3866: <c>List[EntityHandle].Add(x)</c>, where <c>x</c> reaches
/// <c>EntityHandle</c> through a user-defined <c>op_Implicit</c>, bound to the
/// NON-GENERIC <c>System.Collections.IList.Add(object)</c> face instead of
/// <c>Add(T)</c>.
/// <para><c>ClrOverloadResolution.CompareConversions</c> ranked candidates by
/// the ordinal of <see cref="object"/>-taking
/// <c>ImplicitConversionKind.Boxing</c> (4) against
/// <c>ImplicitConversionKind.UserDefinedImplicit</c> (6) and so preferred
/// boxing to <c>object</c>. C# §12.6.4.5 ranks by "better conversion target",
/// not by the mechanism of the conversion, and <c>System.Object</c> is the
/// least specific target there is.</para>
/// <para>The divergence was SILENT at compile time: the migrated
/// <c>Gsharp.HotReload.Runtime.HotReloadDeltaBuilder.MapStandaloneSignature</c>
/// compiled and passed ILVerify, then threw
/// <c>ArgumentException: The value "System.Reflection.Metadata.StandaloneSignatureHandle"
/// is not of type "System.Reflection.Metadata.EntityHandle"</c> from
/// <c>List&lt;T&gt;.IList.Add</c> at run time. So these tests EXECUTE: binding
/// alone cannot tell the two faces apart.</para>
/// </summary>
public class Issue3866UserDefinedConversionVsObjectTests
{
    /// <summary>
    /// The exact BCL shape the migrated <c>HotReloadDeltaBuilder</c> hit:
    /// <c>StandaloneSignatureHandle</c> has an <c>op_Implicit</c> to
    /// <c>EntityHandle</c>, and <c>List&lt;EntityHandle&gt;</c> exposes both
    /// <c>Add(EntityHandle)</c> and <c>IList.Add(object)</c>. On
    /// <c>origin/main</c> this throws <see cref="System.ArgumentException"/>.
    /// </summary>
    [Fact]
    public void ListAdd_ImportedHandleWithImplicitConversion_BindsToGenericAdd()
    {
        var source = @"
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(1, result.Value);
    }

    /// <summary>
    /// The same ranking question with source-declared types, so the rule is
    /// pinned independently of any BCL detail: a G# <c>func operator implicit</c>
    /// target must beat an <c>object</c> parameter on the same argument.
    /// </summary>
    [Fact]
    public void OverloadPair_UserDefinedConversionTarget_BeatsObjectParameter()
    {
        var source = @"
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

    // `Wrapped -> Payload` is user-defined; `Wrapped -> object` is boxing.
    // Payload is the better conversion target, so the Payload overload wins.
    if Accept(w) != 7 {
        return -10
    }

    // A value with no better target still reaches the object overload.
    if Accept(""s"") != -1 {
        return -20
    }

    return 1
}

run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(1, result.Value);
    }

    /// <summary>
    /// Anti-vacuity guard rail: an argument whose ONLY conversion to the
    /// candidate set is boxing must still reach the <c>object</c> overload, and
    /// an exact match must still beat both. This test passes on
    /// <c>origin/main</c> — it exists so the fix above cannot be "everything
    /// now prefers the non-object candidate".
    /// </summary>
    [Fact]
    public void OverloadPair_ObjectCandidate_StillWinsWhenItIsTheOnlyApplicableOne()
    {
        var source = @"
import System

struct Unrelated {
    var value int32
}

func Accept(s string) int32 { return 1 }
func Accept(o object) int32 { return 2 }

func run() int32 {
    if Accept(""s"") != 1 {
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
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(1, result.Value);
    }
}
