// <copyright file="Issue2152LambdaAssignmentInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2152 — a block-body lambda whose trailing expression is an
/// assignment (e.g. <c>(x bool) -&gt; { field = x }</c>) must infer a
/// <c>void</c> return type on the target-less inference path (overload
/// resolution), not the assigned value's type. In G#'s Kotlin-like
/// semantics an assignment yields Unit/void, so such a lambda matches an
/// <c>Action</c>-style <c>(bool) -&gt; void</c> delegate parameter. Before the
/// fix the lambda was inferred as <c>(bool) -&gt; bool</c>, producing spurious
/// GS0266 (ambiguous overloads) / GS0154 (parameter type mismatch). The
/// target-typed path (issue #889) was already correct; these tests pin the
/// target-less path and guard that value-producing bodies still infer their
/// real value type.
/// </summary>
public class Issue2152LambdaAssignmentInferenceTests
{
    [Fact]
    public void OverloadResolution_TrailingSimpleAssignment_InfersVoidAndResolvesVoidDelegate()
    {
        var source = @"
package Test
class C {
    var inProgress bool
    func M() {
        let g = G((x bool) -> { inProgress = x })
    }
}
class G {
    init(b () -> void) {}
    init(c (bool) -> void) {}
}
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void OverloadResolution_TrailingCompoundAssignment_InfersVoid()
    {
        var source = @"
package Test
class C {
    var count int32
    func M() {
        let g = G((x int32) -> { count += x })
    }
}
class G {
    init(b () -> void) {}
    init(c (int32) -> void) {}
}
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void OverloadResolution_TrailingFieldAssignment_DoesNotMatchFuncOverload()
    {
        // Only a value-returning overload would match if inference wrongly
        // produced (bool) -> bool. With the fix the lambda infers void, so the
        // (bool) -> void overload is selected and binding is clean.
        var source = @"
package Test
class C {
    var inProgress bool
    func M() {
        let g = G((x bool) -> { inProgress = x })
    }
}
class G {
    init(c (bool) -> void) {}
}
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void OverloadResolution_ValueProducingTrailing_StillInfersValueType()
    {
        // Guard: a genuine value-producing trailing expression must keep its
        // value type so it resolves to the (int32) -> int32 overload.
        var source = @"
package Test
class C {
    func M() {
        let g = G((x int32) -> { x + 1 })
    }
}
class G {
    init(c (int32) -> int32) {}
}
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void OverloadResolution_ExplicitReturn_StillInfersReturnType()
    {
        // Guard: an explicit `return expr` continues to pin the value type.
        var source = @"
package Test
class C {
    func M() {
        let g = G((x int32) -> { return x + 1 })
    }
}
class G {
    init(c (int32) -> int32) {}
}
";
        AssertBindsWithoutErrors(source);
    }

    private static void AssertBindsWithoutErrors(string source)
    {
        var paths = new List<string>();
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (!string.IsNullOrEmpty(tpa))
        {
            foreach (var p in tpa.Split(Path.PathSeparator))
            {
                if (!string.IsNullOrWhiteSpace(p) && File.Exists(p))
                {
                    paths.Add(p);
                }
            }
        }

        using var resolver = ReferenceResolver.WithReferences(paths);
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), resolver);
        var program = Binder.BindProgram(globalScope, resolver);
        var diagnostics = globalScope.Diagnostics.AddRange(program.Diagnostics);
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }
}
