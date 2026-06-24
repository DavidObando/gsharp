// <copyright file="Issue1068InterfacePropertyAccessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1068: reading (and writing) a property through an interface-typed
/// reference must bind, mirroring the already-working interface method path.
/// Property member access on an interface receiver previously fell through to
/// GS0158 because the member-access binder only modelled interface methods,
/// not interface properties. The binder now routes interface property lookups
/// through <c>TypeMemberModel.TryGetProperty</c>, which also walks base
/// interfaces.
/// </summary>
public class Issue1068InterfacePropertyAccessTests
{
    [Fact]
    public void GetOnlyProperty_ReadThroughInterfaceReference_Binds()
    {
        const string source = """
            package p
            interface IBase { prop H int32 { get; } }
            class C : IBase {
                prop H int32 { get; init; }
                init(h int32) { H = h }
            }
            func read(b IBase) int32 { return b.H }
            """;
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InheritedProperty_ReadThroughDerivedInterfaceReference_Binds()
    {
        // H is declared on IBase and reached through an IDerived-typed
        // reference — the lookup must walk the base interface chain.
        const string source = """
            package p
            interface IBase { prop H int32 { get; } }
            interface IDerived : IBase { prop W int32 { get; set; } }
            class C : IDerived {
                prop H int32 { get; init; }
                prop W int32 { get; set; }
                init(h int32) { H = h }
            }
            func read(d IDerived) int32 { return d.H }
            """;
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void GetSetProperty_WriteThroughInterfaceReference_Binds()
    {
        const string source = """
            package p
            interface IBag { prop W int32 { get; set; } }
            class C : IBag {
                prop W int32 { get; set; }
            }
            func write(b IBag, v int32) { b.W = v }
            func read(b IBag) int32 { return b.W }
            """;
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void AbsentMember_ThroughInterfaceReference_ReportsGS0158()
    {
        // A truly-absent member must still surface "Cannot find member".
        const string source = """
            package p
            interface IBase { prop H int32 { get; } }
            class C : IBase {
                prop H int32 { get; init; }
                init(h int32) { H = h }
            }
            func read(b IBase) int32 { return b.Missing }
            """;
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0158");
    }

    [Fact]
    public void GetOnlyProperty_WriteThroughInterfaceReference_ReportsCannotAssign()
    {
        // IBase.H has no setter, so writing it through the interface reference
        // must be rejected rather than silently succeeding.
        const string source = """
            package p
            interface IBase { prop H int32 { get; } }
            class C : IBase {
                prop H int32 { get; init; }
                init(h int32) { H = h }
            }
            func write(b IBase, v int32) { b.H = v }
            """;
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0127");
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);

        // BoundProgram fully binds function bodies (where member access is
        // resolved), surfacing body-level diagnostics such as GS0158/GS0127 —
        // GlobalScope.Diagnostics only covers declaration-level binding.
        return compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToList();
    }
}
