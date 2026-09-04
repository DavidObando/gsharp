// <copyright file="Issue3880QualifiedTypeAcrossCollidingImportsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3880 (self-migration wall in <c>tools/cs2gs/Cs2Gs.Tests</c>): a FULLY
/// QUALIFIED source-type reference — <c>typeof(ImportedVisible.defer_)</c> —
/// reported GS0113 "type doesn't exist" whenever a second <em>imported</em>
/// package also declared a type of that simple name.
/// <para>
/// The qualified type-clause path falls back to a simple-name lookup of the
/// final segment, and #2455 makes that lookup refuse to guess between two
/// separately-imported packages. But a qualified reference is not ambiguous:
/// its qualifier names the package outright. The repair publishes that
/// qualifier as the explicit package hint #2455 already honours for qualified
/// CONSTRUCTION (<c>Pkg.Type{…}</c>).
/// </para>
/// <para>
/// The message was also a masking shape: the type did exist, in a file that
/// was compiled; only the lookup path could not see it. This is the shape
/// cs2gs produces when it splits a multi-namespace C# file into one .gs per
/// namespace and imports every one of them.
/// </para>
/// </summary>
public class Issue3880QualifiedTypeAcrossCollidingImportsTests
{
    // Two packages that BOTH declare `Marker`, both imported by the consumer.
    private const string AlphaPackage = @"
package Alpha

class Marker {
}
";

    private const string BetaPackage = @"
package Beta

class Marker {
}
";

    [Fact]
    public void QualifiedTypeOf_ResolvesTheQualifiedPackagesType()
    {
        // Evaluated, not merely bound: the reflected NAMESPACE is what
        // discriminates — resolving to the other package's same-named type
        // would bind just as cleanly and answer "Alpha".
        var result = Evaluate(@"
import Alpha
import Beta

typeof(Beta.Marker).Namespace
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("Beta", result.Value);
    }

    [Fact]
    public void TheOtherQualifierStillSelectsTheOtherPackage()
    {
        // Anti-vacuity: the hint must SELECT a package, not merely stop the
        // lookup from failing. Same file, other qualifier, other answer.
        var result = Evaluate(@"
import Alpha
import Beta

typeof(Alpha.Marker).Namespace
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("Alpha", result.Value);
    }

    [Fact]
    public void AQualifiedTypeClause_ResolvesInADeclaration()
    {
        // The same lookup reached through a declared type rather than through
        // `typeof`, since the wall's file uses both spellings.
        var result = Evaluate(@"
import Alpha
import Beta

let m Beta.Marker = Beta.Marker{}
m.GetType().Namespace
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("Beta", result.Value);
    }

    [Fact]
    public void AnUnqualifiedCollidingName_IsStillRejected()
    {
        // The #2455 rule the fix must leave alone: with no qualifier there is
        // nothing to disambiguate with, so the bare name must keep failing
        // rather than silently picking a package.
        var result = Evaluate(@"
import Alpha
import Beta

typeof(Marker).Namespace
");

        Assert.NotEmpty(result.Diagnostics);
    }

    private static EmittedOracleResult Evaluate(string consumer)
        => EmittedOracle.Evaluate(new[] { AlphaPackage, BetaPackage, consumer });
}
