// <copyright file="Adr0199RecordProvenanceMarkerRemovalTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0199 seam (a): the compiler-intrinsic `@__Cs2GsRecordProvenance_4828`
/// annotation is gone. gsc no longer recognizes it, so it is an ordinary unknown
/// annotation and no longer suppresses G#'s `Deconstruct` on a body-only
/// data type (ADR-0199 item 4 keeps that `Deconstruct` for every data type).
open class Adr0199RecordProvenanceMarkerRemovalTests {
    @Fact
    func BodyOnlyDataClass_DeconstructsFieldsThenAutoProperties() {
        let body = GetStruct("package P\n" + Body, "Body", out _)
        let members = TypeMemberModel.GetDataDeconstructionMembers(body)
        Assert.Equal([]string{"X", "Y"}, members.Select((m Symbol) -> m.Name).ToArray())
    }

    @Fact
    func FormerMarker_NoLongerSuppressesDeconstruct() {
        let body = GetStruct(`package P
@__Cs2GsRecordProvenance_4828
` + Body, "Body", out var diagnostics)
        let members = TypeMemberModel.GetDataDeconstructionMembers(body)
        // Before the marker was removed this was empty (the marker suppressed it).
        Assert.Equal([]string{"X", "Y"}, members.Select((m Symbol) -> m.Name).ToArray())
        // The name is now an ordinary, unresolved annotation: gsc reports it
        // instead of silently consuming it.
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("__Cs2GsRecordProvenance_4828", StringComparison.Ordinal)
        )
    }

    shared {
        private const Body string = `data class Body {
    var X int32
    prop Y int32 { get; set; }
}`

        private func GetStruct(source string, name string, out diagnostics IReadOnlyList[Diagnostic]) StructSymbol {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            diagnostics = compilation.GlobalScope.Diagnostics.ToList()
            return cast[StructSymbol](compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == name))
        }
    }
}
