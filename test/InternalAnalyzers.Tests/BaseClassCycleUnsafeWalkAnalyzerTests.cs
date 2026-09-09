// <copyright file="BaseClassCycleUnsafeWalkAnalyzerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using Xunit;

namespace GSharp.InternalAnalyzers.Tests;

public sealed class BaseClassCycleUnsafeWalkAnalyzerTests
{
    [Fact]
    public Task ReportsForLoopWalk()
    {
        const string Source = """
class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        for (var c = s.BaseClass; c != null; [|c = c.BaseClass|])
        {
        }
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new BaseClassCycleUnsafeWalkAnalyzer(), Source, "GSA0006");
    }

    [Fact]
    public Task ReportsWhileLoopWalk()
    {
        const string Source = """
class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        while (current != null)
        {
            [|current = current.BaseClass|];
        }
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new BaseClassCycleUnsafeWalkAnalyzer(), Source, "GSA0006");
    }

    [Fact]
    public Task ReportsDoWhileLoopWalk()
    {
        const string Source = """
class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        do
        {
            [|current = current.BaseClass|];
        }
        while (current != null);
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new BaseClassCycleUnsafeWalkAnalyzer(), Source, "GSA0006");
    }

    [Fact]
    public Task ReportsNullConditionalWalk()
    {
        const string Source = """
class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        while (current != null)
        {
            [|current = current?.BaseClass|];
        }
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new BaseClassCycleUnsafeWalkAnalyzer(), Source, "GSA0006");
    }

    [Fact]
    public Task IgnoresGetHierarchyItself()
    {
        // The one sanctioned implementation every other walk should call
        // instead: StructSymbol.GetHierarchy() is exempt so this rule does
        // not flag its own guarded (or, as here, simplified) walk.
        const string Source = """
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
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new BaseClassCycleUnsafeWalkAnalyzer(), Source);
    }

    [Fact]
    public Task IgnoresDetectClassInheritanceCyclesItself()
    {
        // DeclarationBinder.DetectClassInheritanceCycles() is the post-bind
        // cycle detector (#973) itself: it cannot call GetHierarchy() because
        // it needs the exact back-edge node to break, not just an acyclic
        // prefix. Its own onPath/acyclic-set guard is exempt.
        const string Source = """
class StructSymbol
{
    public StructSymbol? BaseClass;
}

class DeclarationBinder
{
    void DetectClassInheritanceCycles(StructSymbol start)
    {
        StructSymbol? current = start;
        while (current != null)
        {
            current = current.BaseClass;
        }
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new BaseClassCycleUnsafeWalkAnalyzer(), Source);
    }

    [Fact]
    public Task IgnoresSingleHopFetchIntoNewVariable()
    {
        // Fetching the immediate base class into a NEW variable name is the
        // ordinary, safe, single-hop shape used throughout the binder (e.g.
        // `if (x.BaseClass != null)`); it is not a walk and is not flagged.
        const string Source = """
class StructSymbol
{
    public StructSymbol? BaseClass;
}

class Checker
{
    bool HasBase(StructSymbol s)
    {
        var parent = s.BaseClass;
        return parent != null;
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new BaseClassCycleUnsafeWalkAnalyzer(), Source);
    }

    [Fact]
    public Task IgnoresUnrelatedTypeNamedSimilarly()
    {
        // A `.BaseClass` self-reassignment loop on a type that is not named
        // `StructSymbol` is not this bug class; the semantic containing-type
        // check keeps the rule scoped to the actual symbol hierarchy.
        const string Source = """
class SomeOtherType
{
    public SomeOtherType? BaseClass;
}

class Walker
{
    void Walk(SomeOtherType s)
    {
        var current = s;
        while (current != null)
        {
            current = current.BaseClass;
        }
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new BaseClassCycleUnsafeWalkAnalyzer(), Source);
    }

    [Fact]
    public Task IgnoresGuardedWalkThroughHierarchyHelper()
    {
        // The consolidated, GetHierarchy()-based pattern every #4164 fix
        // landed on: no direct `.BaseClass` self-reassignment loop remains,
        // so nothing to flag.
        const string Source = """
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

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new BaseClassCycleUnsafeWalkAnalyzer(), Source);
    }
}
