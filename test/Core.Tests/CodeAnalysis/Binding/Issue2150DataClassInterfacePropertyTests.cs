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
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2150: a data-class positional (primary-constructor) parameter is
/// materialized as a public instance field, yet — like a C# record's
/// positional property (<c>record R(int X) : IHasX</c>) — it must satisfy a
/// matching get-only (or get/set) interface property. Before the fix the
/// interface-satisfaction walk only scanned <c>StructSymbol.Properties</c>, so
/// the positional field never satisfied the contract and GS0187 fired. The fix
/// recognises the positional parameter as an implementation AND synthesises a
/// backing auto-property accessor so the emitted type carries the CLR
/// <c>get_/set_</c> interface slot (otherwise the assembly would fail to load
/// with a <see cref="TypeLoadException"/>).
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
    public void TypeMismatchedPositionalParam_ReportsSingleGS0187()
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

        var gs0187 = Bind(source).Where(d => d.Id == "GS0187").ToList();
        Assert.Single(gs0187);
    }

    [Fact]
    public void NullableAnnotationMismatch_StillSatisfiesInterface_NoDiagnostics()
    {
        // Oahu migration: `interface IProfileKey { prop AccountId string { get; } }`
        // (non-nullable) is satisfied by `open data class ProfileKey(AccountId
        // string?) : IProfileKey` (nullable). C# allows a non-nullable
        // interface property to be satisfied by a nullable-annotated
        // implementation with at most a nullable warning, never a compile
        // error, because nullability is annotation-only and both sides share
        // the same runtime type (`string`). The reverse direction (nullable
        // interface property satisfied by a non-nullable positional param)
        // must also work, matching C#'s covariant-nullability leniency.
        const string source = """
            package Test
            interface IProfileKey {
                prop AccountId string { get; }
            }
            open data class ProfileKey(AccountId string?) : IProfileKey {
            }
            interface IHasNullableX {
                prop X int32? { get; }
            }
            open data class NonNullableX(X int32) : IHasNullableX {
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void PositionalParam_SatisfiesSetterRequiringInterfaceProperty_NoDiagnostics()
    {
        // A data-class positional parameter is a mutable public field, so it can
        // satisfy an interface property that also requires a setter.
        const string source = """
            package Test
            interface IHas {
                prop X int32 { get; set; }
            }
            open data class D(X int32) : IHas {
            }
            """;

        Assert.Empty(Bind(source));
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
}
