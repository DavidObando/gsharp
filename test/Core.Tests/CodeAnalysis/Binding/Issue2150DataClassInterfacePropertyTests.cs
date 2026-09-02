// <copyright file="Issue2150DataClassInterfacePropertyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2150: a data-class positional (primary-constructor) parameter is
/// materialized as an init-only property and may satisfy a matching get-only
/// interface property. Before the fix the interface-satisfaction walk only
/// scanned <c>StructSymbol.Properties</c>, so the positional field never
/// satisfied the contract and GS0187 fired. The fix recognises the positional
/// parameter as an implementation and synthesises a backing auto-property
/// getter so the emitted type carries the CLR <c>get_</c> interface slot.
/// Issue #2875 separately rejects using that init-only member for an ordinary
/// settable interface property.
/// </summary>
public class Issue2150DataClassInterfacePropertyTests
{
    [Fact]
    public void PositionalParams_SatisfyGetOnlyInterfaceProperties_NoDiagnostics()
    {
        // The exact issue repro: two positional parameters satisfy two get-only
        // interface properties. Previously reported GS0187 twice.
        const string source = """
            package Test
            interface IQuality {
                prop SampleRate int32? { get; }
                prop BitRate int32? { get; }
            }
            open data class Quality(SampleRate int32?, BitRate int32?) : IQuality {
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void RegularProperty_StillSatisfiesInterface_NoDiagnostics()
    {
        // Guard: a hand-written property still satisfies the same interface.
        const string source = """
            package Test
            interface IQuality {
                prop SampleRate int32? { get; }
            }
            class QualityOk : IQuality {
                prop SampleRate int32? -> nil
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void MissingInterfaceProperty_StillReportsGS0187()
    {
        // Don't over-fix: a genuinely missing member is still an error. The
        // positional parameter X satisfies the interface, but Y has no
        // corresponding member.
        const string source = """
            package Test
            interface IHas {
                prop X int32 { get; }
                prop Y int32 { get; }
            }
            open data class D(X int32) : IHas {
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0187" && d.Message.Contains("Y"));
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0187" && d.Message.Contains(".X"));
    }

    [Fact]
    public void TypeMismatchedPositionalParam_ReportsSingleGS0504()
    {
        // A positional parameter whose name matches but whose type is
        // incompatible does NOT satisfy the contract, and the diagnostic is
        // reported exactly once (not duplicated by the fallback path).
        const string source = """
            package Test
            interface IHas {
                prop X int32 { get; }
            }
            open data class D(X string) : IHas {
            }
            """;

        var diagnostic = Assert.Single(Bind(source));
        Assert.Equal("GS0504", diagnostic.Id);
        Assert.Contains("expected type 'int32', actual type 'string'", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void GetOnlyNullableInterfaceProperty_SatisfiedByNullablePositionalParam_NoDiagnostics()
    {
        // Original #2150 repro: iface `int32?` <- impl `int32?` (exact match).
        const string source = """
            package Test
            interface IQuality {
                prop SampleRate int32? { get; }
            }
            open data class Quality(SampleRate int32?) : IQuality {
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GetOnlyNullableValueInterfaceProperty_NotSatisfiedByNonNullablePositionalParam_ReportsGS0504()
    {
        // `int32?` is CLR Nullable<int32>, not an erased annotation. Its getter
        // signature therefore differs from `int32`, so covariance is invalid.
        const string source = """
            package Test
            interface IHasNullableX {
                prop X int32? { get; }
            }
            open data class NonNullableX(X int32) : IHasNullableX {
            }
            """;

        var diagnostic = Assert.Single(Bind(source));
        Assert.Equal("GS0504", diagnostic.Id);
        Assert.Contains("expected type 'int32?', actual type 'int32'", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void GetOnlyNullableReferenceInterfaceProperty_SatisfiedByNonNullablePositionalParam_EmitsAndLoads()
    {
        const string source = """
            package Test
            interface IHasNullableX {
                prop X string? { get; }
            }
            data class NonNullableX(X string) : IHasNullableX
            """;

        AssertEmitsAndLoads(source);
    }

    [Fact]
    public void GetOnlyNonNullableInterfaceProperty_SatisfiedByNonNullablePositionalParam_NoDiagnostics()
    {
        // Exact match: iface `int32` <- impl `int32`.
        const string source = """
            package Test
            interface IHasX {
                prop X int32 { get; }
            }
            open data class ExactX(X int32) : IHasX {
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GetOnlyNonNullableInterfaceProperty_NotSatisfiedByNullablePositionalParam_ReportsGS0504()
    {
        // Unsound direction, now rejected: iface `int32` <- impl `int32?`.
        // A get-only interface property is a covariant (return) position, so
        // the implementation must be a SUBTYPE of the interface's declared
        // type. `int32?` is a SUPERTYPE of `int32` (never the reverse), so
        // accepting it here would let a consumer of the non-null `X int32`
        // contract observe `null` and NPE. Mirrors
        // `interface IProfileKey { prop AccountId string { get; } }` rejecting
        // `open data class ProfileKey(AccountId string?) : IProfileKey`.
        const string source = """
            package Test
            interface IProfileKey {
                prop AccountId string { get; }
            }
            open data class ProfileKey(AccountId string?) : IProfileKey {
            }
            """;

        var diagnostic = Assert.Single(Bind(source));
        Assert.Equal("GS0504", diagnostic.Id);
        Assert.Contains("expected type 'string', actual type 'string?'", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void GetSetNullableInterfaceProperty_NotSatisfiedByNullablePositionalParam_ReportsGS0502()
    {
        const string source = """
            package Test
            interface IHasX {
                prop X int32? { get; set; }
            }
            open data class ExactNullableX(X int32?) : IHasX {
            }
            """;

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0502");
        Assert.Contains("positional member 'X'", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains("IHasX.X", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void GetSetNullableInterfaceProperty_NotSatisfiedByNonNullablePositionalParam_ReportsGS0504()
    {
        // Invariant mismatch: iface `int32?` <- impl `int32`. A setter makes
        // the interface property invariant (both a producer, via get, and a
        // consumer, via set), so widening alone is unsound: a caller could
        // `set` a `null` through the interface reference into a field the
        // implementation type promises is never null.
        const string source = """
            package Test
            interface IHasX {
                prop X int32? { get; set; }
            }
            open data class NonNullableX(X int32) : IHasX {
            }
            """;

        var diagnostic = Assert.Single(Bind(source));
        Assert.Equal("GS0504", diagnostic.Id);
        Assert.Contains("expected type 'int32?', actual type 'int32'", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void GetSetNonNullableInterfaceProperty_NotSatisfiedByNullablePositionalParam_ReportsGS0504()
    {
        // Invariant mismatch (reverse direction): iface `int32` <- impl
        // `int32?`. Also unsound via the `get` side (as in the get-only case).
        const string source = """
            package Test
            interface IHasX {
                prop X int32 { get; set; }
            }
            open data class NullableX(X int32?) : IHasX {
            }
            """;

        var diagnostic = Assert.Single(Bind(source));
        Assert.Equal("GS0504", diagnostic.Id);
        Assert.Contains("expected type 'int32', actual type 'int32?'", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void PositionalParam_DoesNotSatisfySetterRequiringInterfaceProperty_ReportsGS0502()
    {
        const string source = """
            package Test
            interface IHas {
                prop X int32 { get; set; }
            }
            open data class D(X int32) : IHas {
            }
            """;

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0502");
        Assert.Equal(
            "Type 'D' cannot use positional member 'X' to implement interface property 'IHas.X' because the member uses accessor 'init' but the interface requires 'set'; declare property 'X' explicitly with a 'set' accessor.",
            diagnostic.Message);
    }

    [Fact]
    public void ExplicitInitOnlyProperty_DoesNotSatisfySettableInterfaceProperty_ReportsGS0502()
    {
        const string source = """
            package Test
            interface IHas {
                prop X int32 { get; set; }
            }
            class D : IHas {
                prop X int32 { get; init; }
            }
            """;

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0502");
        Assert.Contains("property 'X'", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains("uses accessor 'init'", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitInitOnlyProperty_DoesNotSatisfySettableInterfaceProperty_ReportsOnlyGS0502()
    {
        const string source = """
            package Test
            interface IHas {
                prop X int32 { get; set; }
            }
            class D : IHas {
                prop (IHas) X int32 { get; init; }
            }
            """;

        var diagnostic = Assert.Single(Bind(source));
        Assert.Equal("GS0502", diagnostic.Id);
        Assert.Contains("change property 'X' to use accessor 'set'", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SettableProperty_DoesNotSatisfyInitOnlyInterfaceProperty_ReportsGS0502()
    {
        const string source = """
            package Test
            interface IHas {
                prop X int32 { get; init; }
            }
            class D : IHas {
                prop X int32 { get; set; }
            }
            """;

        var diagnostic = Assert.Single(Bind(source));
        Assert.Equal("GS0502", diagnostic.Id);
        Assert.Contains("uses accessor 'set'", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains("requires 'init'", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitSettableProperty_DoesNotSatisfyInitOnlyInterfaceProperty_ReportsOnlyGS0502()
    {
        const string source = """
            package Test
            interface IHas {
                prop X int32 { get; init; }
            }
            class D : IHas {
                prop (IHas) X int32 { get; set; }
            }
            """;

        var diagnostic = Assert.Single(Bind(source));
        Assert.Equal("GS0502", diagnostic.Id);
        Assert.Contains("change property 'X' to use accessor 'init'", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void GenericSettableInterfaceProperty_NotSatisfiedByPositionalMember_ReportsGS0502()
    {
        const string source = """
            package Test
            interface IBox[T] {
                prop Value T { get; set; }
            }
            data class Box(Value int32) : IBox[int32]
            """;

        var diagnostic = Assert.Single(Bind(source));
        Assert.Equal("GS0502", diagnostic.Id);
        Assert.Contains("IBox[int32].Value", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void GenericMissingInterfaceProperty_ReportsGS0187()
    {
        const string source = """
            package Test
            interface IBox[T] {
                prop Value T { get; set; }
            }
            class Box : IBox[int32] {
            }
            """;

        var diagnostic = Assert.Single(Bind(source));
        Assert.Equal("GS0187", diagnostic.Id);
        Assert.Contains("Value", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void GenericGetOnlyInterfaceProperty_SatisfiedByPositionalMember_EmitsAndLoads()
    {
        const string source = """
            package Test
            interface IBox[T] {
                prop Value T { get; }
            }
            data class Box(Value int32) : IBox[int32]
            """;

        AssertEmitsAndLoads(source);
    }

    [Fact]
    public void ExplicitInitProperty_ConstructedGenericInterface_EmitsAndLoads()
    {
        const string source = """
            package Test
            interface IBox[T] {
                prop Value T { get; init; }
            }
            class Box : IBox[int32] {
                private prop (IBox[int32]) Value int32 { get; init; }
            }
            """;

        AssertEmitsAndLoads(source);
    }

    [Fact]
    public void ExplicitProperties_ForTwoConstructionsOfSameGenericInterface_EmitAndLoad()
    {
        const string source = """
            package Test
            interface IBox[T] {
                prop Value T { get; }
            }
            class Boxes : IBox[int32], IBox[string] {
                private prop (IBox[int32]) Value int32 -> 1
                private prop (IBox[string]) Value string -> "two"
            }
            """;

        AssertEmitsAndLoads(source);
    }

    [Fact]
    public void BaseDataClassParam_SatisfiesInterfaceListedOnDerived_NoDiagnostics()
    {
        // Issue #1066 semantics: a positional parameter on a base data class
        // satisfies an interface listed on a derived data class.
        const string source = """
            package Test
            interface IHas {
                prop X int32 { get; }
            }
            open data class Base(X int32) {
            }
            open data class Derived(Y int32) : Base(0), IHas {
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void EmittedType_ImplementsInterface_AndDispatchesThroughIt()
    {
        // The binder no longer reports GS0187, but the emitted assembly must
        // also be loadable: the data class needs a real get_ accessor to fill
        // the CLR interface slot. This test emits, loads, and dispatches a call
        // through the interface accessor — a missing accessor would surface here
        // as a TypeLoadException at load time.
        const string source = """
            package Test
            interface IQuality {
                prop SampleRate int32? { get; }
            }
            open data class Quality(SampleRate int32?) : IQuality {
            }
            """;

        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);

        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext("Issue2150_EmitDispatch", isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);

            // Loading the type graph exercises the CLR interface-slot check.
            var quality = asm.GetTypes().First(t => t.Name == "Quality");
            var iquality = asm.GetTypes().First(t => t.Name == "IQuality");
            Assert.True(iquality.IsAssignableFrom(quality), "Quality must implement IQuality");

            var instance = Activator.CreateInstance(quality, new object[] { (int?)44100 });

            // Dispatch through the interface's get accessor (not the field).
            var getter = iquality.GetMethod("get_SampleRate");
            Assert.NotNull(getter);
            var viaInterface = getter.Invoke(instance, null);
            Assert.Equal((int?)44100, (int?)viaInterface);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }

    private static void AssertEmitsAndLoads(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();

        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        _ = EmittedFixture.Load(peStream.ToArray()).GetTypes();
    }
}
