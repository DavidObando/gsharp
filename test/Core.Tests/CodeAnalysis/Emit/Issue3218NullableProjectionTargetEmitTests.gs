// <copyright file="Issue3218NullableProjectionTargetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Tests
import Xunit

/// Issue #3218 / ADR-0148: a structural projection whose target is an
/// imported nullable class parameter (e.g. `System.Uri?`) classified as
/// a plain implicit conversion — the `T → U?` nullable-wrapping arm of
/// `Conversion.Classify` dropped the `IsStructuralProjection` flag —
/// so `BindConversion` skipped the bind-time projection lowering and left
/// a raw `BoundConversionExpression` in the tree. The evaluator absorbed
/// that dynamically, but the emitter (correctly) has no arm for it and threw
/// `NotSupportedException: Conversion from 'Source' to 'System.Uri?' is not
/// yet supported`. The classification now preserves the projection flag and
/// the lowering projects into the bare underlying reference type (the nullable
/// wrap is representation-free), so both engines run the ADR-0148 §E lowering.
open class Issue3218NullableProjectionTargetEmitTests {
    @Fact
    func ProjectionIntoImportedNullableCtorParameter_ConstructsTheProjectedValue() {
        // Executing witness: HttpRequestMessage(HttpMethod, Uri?) is side-
        // effect-free, so the projected System.Uri (built from `uriString`
        // through Uri's public ctor — the ADR-0148 construction path) is
        // observable through the request it lands in. Pre-fix this failed at
        // emit with the NotSupportedException above.
        let result = EmittedOracle.Evaluate(`
import System
import System.Net.Http
class Source { var uriString string }
let source = Source{uriString: "https://example.test/probe"}
let request = HttpRequestMessage(HttpMethod.Get, source)
request.RequestUri!!.AbsoluteUri
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("https://example.test/probe", result.Value)
    }

    @Fact
    func ProjectionIntoImportedNullableMethodParameter_BindsAndEmits() {
        // The issue's exact repro shape (never invoked — GetAsync would do
        // I/O): overload resolution picks GetAsync(System.Uri?) via the
        // structural projection and the emitted body must compile.
        let result = EmittedOracle.Evaluate(`
import System.Net.Http
class Source { var uriString string }
func Probe(client HttpClient, source Source) {
    let pending = client.GetAsync(source)
}
0
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }
}
