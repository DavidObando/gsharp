// <copyright file="Issue3779MetadataArgumentVariadicOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3779: two variadic overloads that differ only by a leading fixed
/// parameter tied (GS0266) whenever the single argument's type came from CLR
/// METADATA — an imported member's return type — rather than from source.
///
/// The #1493 variadic-tail applicability check asked whether the argument
/// already IS the carrier with `==` on two (cref:TypeSymbol)s.
/// Neither `TypeSymbol` nor `Symbol` declares an `operator ==`,
/// so that is REFERENCE identity: the `[]string` a carrier is declared
/// with and the `string[]` read back from metadata denote the same runtime
/// type but are two different symbol instances. The pass-through went
/// undetected, the candidate fell into the per-element loop, failed
/// `string[] -> string`, and was dropped as non-convertible — and when
/// EVERY candidate is dropped the resolver deliberately keeps the unfiltered
/// set and ranks it, so the two variadic siblings tied.
///
/// These tests EXECUTE the emitted program: the interesting part is not
/// merely that the call binds but that it binds in NORMAL form (the array is
/// passed through) rather than expanded form (the array wrapped as a single
/// element), which only running can tell apart.
open class Issue3779MetadataArgumentVariadicOverloadTests {
    /// The migrated `TranslationTestValidation.AssertBinds` shape, reduced:
    /// a variadic overload pair where the argument is a local inferred from an
    /// imported member's return type. Fails on `origin/main` with GS0266.
    @Fact
    func VariadicOverloadPair_ArgumentTypedByImportedMember_BindsInNormalForm() {
        let source = (`
import System

class Holder {}

func Count(sources ...string) int32 { return sources.Length }
func Count(references Holder?, sources ...string) int32 { return -1 }

func run() int32 {
    // The type of ` + "`" + `three` + "`" + ` comes from CLR metadata (Environment.GetCommandLineArgs),
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
    if Count("x", "y") != 2 {
        return -20
    }

    // The two-parameter sibling is still reachable (it also tied on main).
    if Count(nil, three) != -1 {
        return -30
    }

    return 1
}

run()
`)
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(1, result.Value)
    }

    /// The same defect reached through an imported GENERIC member
    /// (`Enumerable.ToArray`) — the exact expression the migrated
    /// `Cs2Gs.Tests` call sites use. Fails on `origin/main`.
    @Fact
    func VariadicOverloadPair_ArgumentTypedByImportedGenericMember_BindsInNormalForm() {
        let source = `
import System
import System.Linq

class Holder {}

func Join(sources ...string) string { return string.Join("|", sources) }
func Join(references Holder?, sources ...string) string { return "two-param" }

func run() string {
    let docs []string = []string{"a", "b", "c"}
    let printed = docs.Select((d string) -> d.ToUpperInvariant()).ToArray()
    return Join(printed)
}

run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("A|B|C", result.Value)
    }

    /// Anti-vacuity guard: this one PASSES on `origin/main` and must keep
    /// passing. A single variadic candidate given an argument that genuinely
    /// does not fit its only fixed parameter must still be rejected — the fix
    /// widens a pass-through test, and must not make inapplicable overloads
    /// applicable.
    @Fact
    func SingleCandidate_MetadataArgumentAgainstUnrelatedFixedParameter_StillRejected() {
        let source = `
import System

class Holder {}

func Only(references Holder?, sources ...string) int32 { return -1 }

func run() int32 {
    let three = Environment.GetCommandLineArgs()
    return Only(three)
}

run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError && d.Id == "GS0154")
    }

    /// Anti-vacuity guard: this one PASSES on `origin/main` too. The
    /// source-written carrier spelling was never broken, and the fix must not
    /// disturb it.
    @Fact
    func VariadicOverloadPair_SourceDeclaredArgument_StillBindsInNormalForm() {
        let source = `
class Holder {}

func Count(sources ...string) int32 { return sources.Length }
func Count(references Holder?, sources ...string) int32 { return -1 }

func run() int32 {
    let docs []string = []string{"a", "b", "c"}
    return Count(docs)
}

run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(3, result.Value)
    }
}
