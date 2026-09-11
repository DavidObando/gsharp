// <copyright file="Issue4201GetHierarchyAccessibilitySnippetRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Analyzers;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4201: <c>test/InternalAnalyzers.Tests/BaseClassCycleUnsafeWalkAnalyzerTests.cs</c>'s
/// <c>IgnoresGuardedWalkThroughHierarchyHelper</c> snippet (added by #4172) declared
/// <c>StructSymbol.GetHierarchy()</c> with no access modifier — defaulting to
/// <c>private</c> in C# — while calling it from the sibling <c>Walker</c> class. That is a
/// genuine CS0122 compile error in the embedded snippet, invisible to
/// <c>dotnet test</c> (Roslyn's analyzer-testing infrastructure still runs the analyzer
/// and checks its diagnostics even when the snippet fails to compile), but fatal to
/// <c>SnippetTranslator</c>, which requires <c>project.BoundWithoutErrors</c> before it
/// will attempt translation at all. That one compile error blocked the ENTIRE
/// <c>test/InternalAnalyzers.Tests</c> app from translating in the selfmig pipeline.
///
/// <para>
/// The fix is a one-word accessibility change (add <c>public</c>) in the fixture
/// itself. This test pins the translator-level failure mode by exercising
/// <see cref="SnippetTranslator.Translate(string)"/> directly on both the fixed shape
/// (copied verbatim from the corrected fixture) and the original broken shape — it
/// documents exactly what breaks and how, in a fast unit test that does not need a
/// whole-repo selfmig run to demonstrate. It is not a substitute for the live fixture:
/// if <c>BaseClassCycleUnsafeWalkAnalyzerTests.cs</c> itself regresses this way again,
/// the nightly cs2gs-selfmig gate (not this test) is what will catch it.
/// </para>
/// </summary>
public sealed class Issue4201GetHierarchyAccessibilitySnippetRegressionTests
{
    // Copied verbatim (post-fix) from
    // test/InternalAnalyzers.Tests/BaseClassCycleUnsafeWalkAnalyzerTests.cs's
    // IgnoresGuardedWalkThroughHierarchyHelper.
    private const string FixedSnippet = """
using System.Collections.Generic;

class StructSymbol
{
    public StructSymbol? BaseClass;

    public List<StructSymbol> GetHierarchy()
    {
        var hierarchy = new List<StructSymbol>();
        StructSymbol? current = this;
        while (current != null)
        {
            hierarchy.Add(current);
            current = current.BaseClass;
        }

        return hierarchy;
    }
}

class Walker
{
    bool FindAncestor(StructSymbol container, StructSymbol target)
    {
        var chain = container.GetHierarchy();
        for (var i = 1; i < chain.Count; i++)
        {
            if (chain[i] == target)
            {
                return true;
            }
        }

        return false;
    }
}
""";

    // The pre-fix shape: `GetHierarchy()` carries no access modifier, so it defaults to
    // `private` and `Walker.FindAncestor`'s cross-class call is a CS0122 compile error.
    private const string BrokenSnippet = """
using System.Collections.Generic;

class StructSymbol
{
    public StructSymbol? BaseClass;

    List<StructSymbol> GetHierarchy()
    {
        var hierarchy = new List<StructSymbol>();
        StructSymbol? current = this;
        while (current != null)
        {
            hierarchy.Add(current);
            current = current.BaseClass;
        }

        return hierarchy;
    }
}

class Walker
{
    bool FindAncestor(StructSymbol container, StructSymbol target)
    {
        var chain = container.GetHierarchy();
        for (var i = 1; i < chain.Count; i++)
        {
            if (chain[i] == target)
            {
                return true;
            }
        }

        return false;
    }
}
""";

    [Fact]
    public void FixedSnippet_TranslatesCleanly_WithNoAnalyzerSnippetDiagnostic()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(FixedSnippet);

        Assert.NotNull(result.GsWithMarkers);
        Assert.DoesNotContain(
            result.Diagnostics,
            d => d.Message.Contains("does not compile", StringComparison.Ordinal));
    }

    [Fact]
    public void BrokenSnippet_FailsToTranslate_WithCs0122InTheDiagnosticMessage()
    {
        // Anti-vacuity (#4201): reverting the one-word `public` fix reproduces exactly
        // this translate-stage failure; restoring it (FixedSnippet, above) fixes it.
        SnippetTranslationResult result = SnippetTranslator.Translate(BrokenSnippet);

        Assert.Null(result.GsWithMarkers);
        Assert.Contains(
            result.Diagnostics,
            d => d.Message.Contains("does not compile", StringComparison.Ordinal)
                && d.Message.Contains("CS0122", StringComparison.Ordinal));
    }
}
