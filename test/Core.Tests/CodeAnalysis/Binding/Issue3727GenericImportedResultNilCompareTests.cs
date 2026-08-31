// <copyright file="Issue3727GenericImportedResultNilCompareTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3727: <c>Volatile.Read(&amp;x) != nil</c> over a nullable reference
/// reported <c>GS0129</c>. The nil-comparison table itself was never consulted:
/// an earlier arm in the binary-operator binder rejects
/// <c>importedCall == nil</c> when the imported method's METADATA declares a
/// non-null reference return (so a genuine <c>string</c> result is not
/// pointlessly compared against nil), and that check asked
/// <c>ClrNullability.GetReturnTypeSymbol</c> about the DECLARED return type.
/// For <c>T Read&lt;T&gt;(ref T location)</c> the declared return type is the
/// open type parameter, which carries no nullable annotation — its nullability
/// comes from the type argument at the call site. Inference had already
/// substituted <c>C?</c>, so the binder's own result type was nullable while
/// the metadata check said "explicitly non-null", and the comparison the call
/// exists for was rejected. <c>GS0154</c> at the enclosing lambda
/// (<c>() -&gt; ?</c> against <c>() -&gt; bool</c>) was pure cascade.
/// </summary>
public class Issue3727GenericImportedResultNilCompareTests
{
    [Fact]
    public void VolatileRead_OverANullableClass_ComparesAgainstNil()
    {
        const string source = @"
package P

import System.Threading

class Result {
    var Value int32
}

func Guard() bool {
    var r Result? = nil
    return Volatile.Read(&r) != nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void VolatileRead_OverANullableString_ComparesAgainstNil()
    {
        const string source = @"
package P

import System.Threading

func Guard() bool {
    var s string? = nil
    return Volatile.Read(&s) == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void VolatileReadNilCompare_BindsInsideALambdaArgument()
    {
        // The reported shape: `await WaitForAsync(() -> Volatile.Read(&x) !=
        // nil)`. A failed body degraded the lambda to `() -> ?` and cascaded
        // into GS0154 at the `() -> bool` parameter.
        const string source = @"
package P

import System.Threading

class Result {
    var Value int32
}

func Wait(condition () -> bool) bool {
    return condition()
}

func Guard() bool {
    var r Result? = nil
    return Wait(() -> Volatile.Read(&r) != nil)
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void AnExplicitlyNonNullImportedResult_StillRejectsANilComparison()
    {
        // The guard the fix narrows is otherwise unchanged: a NON-generic
        // imported member whose metadata declares a non-null reference return
        // is still not comparable against nil.
        const string source = @"
package P

func Guard() bool {
    return ""abc"".ToUpperInvariant() != nil
}
";
        Assert.Contains(GetErrors(source), d => d.Id == "GS0129");
    }

    [Fact]
    public void VolatileReadNilCompare_EvaluatesTheRealNullState()
    {
        const string source = @"
package P

import System.Threading

class Result {
    var Value int32
}

func Read(value Result?) bool {
    var slot = value
    return Volatile.Read(&slot) != nil
}

let empty Result? = nil
(Read(empty), Read(Result()))
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal((false, true), result.Value);
    }

    private static ImmutableArray<Diagnostic> GetErrors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree) { IsLibrary = true };
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToImmutableArray();
    }
}
