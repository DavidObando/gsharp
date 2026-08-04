// <copyright file="Issue3218NullableProjectionTargetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3218 / ADR-0148: a structural projection whose target is an
/// imported nullable class parameter (e.g. <c>System.Uri?</c>) classified as
/// a plain implicit conversion — the <c>T → U?</c> nullable-wrapping arm of
/// <c>Conversion.Classify</c> dropped the <c>IsStructuralProjection</c> flag —
/// so <c>BindConversion</c> skipped the bind-time projection lowering and left
/// a raw <c>BoundConversionExpression</c> in the tree. The evaluator absorbed
/// that dynamically, but the emitter (correctly) has no arm for it and threw
/// <c>NotSupportedException: Conversion from 'Source' to 'System.Uri?' is not
/// yet supported</c>. The classification now preserves the projection flag and
/// the lowering projects into the bare underlying reference type (the nullable
/// wrap is representation-free), so both engines run the ADR-0148 §E lowering.
/// </summary>
public class Issue3218NullableProjectionTargetEmitTests
{
    [Fact]
    public void ProjectionIntoImportedNullableCtorParameter_ConstructsTheProjectedValue()
    {
        // Executing witness: HttpRequestMessage(HttpMethod, Uri?) is side-
        // effect-free, so the projected System.Uri (built from `uriString`
        // through Uri's public ctor — the ADR-0148 construction path) is
        // observable through the request it lands in. Pre-fix this failed at
        // emit with the NotSupportedException above.
        var result = EmittedOracle.Evaluate(@"
import System
import System.Net.Http
class Source { var uriString string }
let source = Source{uriString: ""https://example.test/probe""}
let request = HttpRequestMessage(HttpMethod.Get, source)
request.RequestUri!!.AbsoluteUri
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("https://example.test/probe", result.Value);
    }

    [Fact]
    public void ProjectionIntoImportedNullableMethodParameter_BindsAndEmits()
    {
        // The issue's exact repro shape (never invoked — GetAsync would do
        // I/O): overload resolution picks GetAsync(System.Uri?) via the
        // structural projection and the emitted body must compile.
        var result = EmittedOracle.Evaluate(@"
import System.Net.Http
class Source { var uriString string }
func Probe(client HttpClient, source Source) {
    let pending = client.GetAsync(source)
}
0
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }
}
