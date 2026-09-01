// <copyright file="Issue3779MetadataArgumentVariadicOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3779: two variadic overloads that differ only by a leading fixed
/// parameter tied (GS0266) whenever the single argument's type came from CLR
/// METADATA — an imported member's return type — rather than from source.
/// <para>The #1493 variadic-tail applicability check asked whether the argument
/// already IS the carrier with <c>==</c> on two <see cref="TypeSymbol"/>s.
/// Neither <c>TypeSymbol</c> nor <c>Symbol</c> declares an <c>operator ==</c>,
/// so that is REFERENCE identity: the <c>[]string</c> a carrier is declared
/// with and the <c>string[]</c> read back from metadata denote the same runtime
/// type but are two different symbol instances. The pass-through went
/// undetected, the candidate fell into the per-element loop, failed
/// <c>string[] -&gt; string</c>, and was dropped as non-convertible — and when
/// EVERY candidate is dropped the resolver deliberately keeps the unfiltered
/// set and ranks it, so the two variadic siblings tied.</para>
/// <para>These tests EXECUTE the emitted program: the interesting part is not
/// merely that the call binds but that it binds in NORMAL form (the array is
/// passed through) rather than expanded form (the array wrapped as a single
/// element), which only running can tell apart.</para>
/// </summary>
public class Issue3779MetadataArgumentVariadicOverloadTests
{
    /// <summary>
    /// The migrated <c>TranslationTestValidation.AssertBinds</c> shape, reduced:
    /// a variadic overload pair where the argument is a local inferred from an
    /// imported member's return type. Fails on <c>origin/main</c> with GS0266.
    /// </summary>
    [Fact]
    public void VariadicOverloadPair_ArgumentTypedByImportedMember_BindsInNormalForm()
    {
        var source = @"
import System

class Holder {}

func Count(sources ...string) int32 { return sources.Length }
func Count(references Holder?, sources ...string) int32 { return -1 }

func run() int32 {
    // The type of `three` comes from CLR metadata (Environment.GetCommandLineArgs),
    // not from a source-written []string. On main this made both candidates
    // non-convertible and the call ambiguous.
    let three = Environment.GetCommandLineArgs()
    let passedThrough = Count(three)

    // Normal form: the array is the carrier, so the count is the array's own
    // length, NOT 1. Expanded form would wrap it as a single element.
    if passedThrough != three.Length {
        return -10
    }

    // Expanded form still works for genuine element arguments.
    if Count(""x"", ""y"") != 2 {
        return -20
    }

    // The two-parameter sibling is still reachable (it also tied on main).
    if Count(nil, three) != -1 {
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
    /// The same defect reached through an imported GENERIC member
    /// (<c>Enumerable.ToArray</c>) — the exact expression the migrated
    /// <c>Cs2Gs.Tests</c> call sites use. Fails on <c>origin/main</c>.
    /// </summary>
    [Fact]
    public void VariadicOverloadPair_ArgumentTypedByImportedGenericMember_BindsInNormalForm()
    {
        var source = @"
import System
import System.Linq

class Holder {}

func Join(sources ...string) string { return string.Join(""|"", sources) }
func Join(references Holder?, sources ...string) string { return ""two-param"" }

func run() string {
    let docs []string = []string{""a"", ""b"", ""c""}
    let printed = docs.Select((d string) -> d.ToUpperInvariant()).ToArray()
    return Join(printed)
}

run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("A|B|C", result.Value);
    }

    /// <summary>
    /// Anti-vacuity guard: this one PASSES on <c>origin/main</c> and must keep
    /// passing. A single variadic candidate given an argument that genuinely
    /// does not fit its only fixed parameter must still be rejected — the fix
    /// widens a pass-through test, and must not make inapplicable overloads
    /// applicable.
    /// </summary>
    [Fact]
    public void SingleCandidate_MetadataArgumentAgainstUnrelatedFixedParameter_StillRejected()
    {
        var source = @"
import System

class Holder {}

func Only(references Holder?, sources ...string) int32 { return -1 }

func run() int32 {
    let three = Environment.GetCommandLineArgs()
    return Only(three)
}

run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.IsError && d.Id == "GS0154");
    }

    /// <summary>
    /// Anti-vacuity guard: this one PASSES on <c>origin/main</c> too. The
    /// source-written carrier spelling was never broken, and the fix must not
    /// disturb it.
    /// </summary>
    [Fact]
    public void VariadicOverloadPair_SourceDeclaredArgument_StillBindsInNormalForm()
    {
        var source = @"
class Holder {}

func Count(sources ...string) int32 { return sources.Length }
func Count(references Holder?, sources ...string) int32 { return -1 }

func run() int32 {
    let docs []string = []string{""a"", ""b"", ""c""}
    return Count(docs)
}

run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(3, result.Value);
    }
}
