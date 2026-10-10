// <copyright file="Adr0199RecordProvenanceMarkerRemovalTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0199 seam (a): the compiler-intrinsic <c>@__Cs2GsRecordProvenance_4828</c>
/// annotation is gone. gsc no longer recognizes it, so it is an ordinary unknown
/// annotation and no longer suppresses G#'s <c>Deconstruct</c> on a body-only
/// data type (ADR-0199 item 4 keeps that <c>Deconstruct</c> for every data type).
/// </summary>
public class Adr0199RecordProvenanceMarkerRemovalTests
{
    private const string Body = """
        data class Body {
            var X int32
            prop Y int32 { get; set; }
        }
        """;

    [Fact]
    public void BodyOnlyDataClass_DeconstructsFieldsThenAutoProperties()
    {
        StructSymbol body = GetStruct("package P\n" + Body, "Body", out _);

        var members = TypeMemberModel.GetDataDeconstructionMembers(body);

        Assert.Equal(new[] { "X", "Y" }, members.Select(m => m.Name).ToArray());
    }

    [Fact]
    public void FormerMarker_NoLongerSuppressesDeconstruct()
    {
        StructSymbol body = GetStruct(
            "package P\n@__Cs2GsRecordProvenance_4828\n" + Body,
            "Body",
            out var diagnostics);

        var members = TypeMemberModel.GetDataDeconstructionMembers(body);

        // Before the marker was removed this was empty (the marker suppressed it).
        Assert.Equal(new[] { "X", "Y" }, members.Select(m => m.Name).ToArray());

        // The name is now an ordinary, unresolved annotation: gsc reports it
        // instead of silently consuming it.
        Assert.Contains(
            diagnostics,
            d => d.Message.Contains("__Cs2GsRecordProvenance_4828", System.StringComparison.Ordinal));
    }

    private static StructSymbol GetStruct(
        string source,
        string name,
        out System.Collections.Generic.IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> diagnostics)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        diagnostics = compilation.GlobalScope.Diagnostics.ToList();
        return (StructSymbol)compilation.GlobalScope.Structs.Single(s => s.Name == name);
    }
}
