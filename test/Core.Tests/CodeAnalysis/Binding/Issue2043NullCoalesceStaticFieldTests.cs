// <copyright file="Issue2043NullCoalesceStaticFieldTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2043: a null-coalescing compound assignment (<c>??=</c>) targeting a
/// <c>shared{}</c> (static) field crashed the binder with a
/// <see cref="System.NullReferenceException"/>. <see cref="StatementBinder.TryBuildNullCoalescingReadWrite"/>
/// unconditionally called <c>CaptureReceiver</c> on the bound field access's
/// <c>Receiver</c>, which is <c>null</c> for a static field (there is no
/// instance to spill into a synthetic local) — dereferencing
/// <c>receiver.Type</c> inside <c>CaptureReceiver</c> then NREd. The fix
/// mirrors the existing null-receiver handling already used for property
/// access (<c>propAccess.Receiver == null ? null : CaptureReceiver(...)</c>)
/// and for plain/compound (<c>+=</c>) assignment of static fields in
/// <c>ExpressionBinder.Assignments.cs</c>. These tests pin that a static
/// field <c>??=</c> now binds and evaluates cleanly (no crash, no spurious
/// diagnostics), and that the sibling instance-field case keeps working.
/// </summary>
public class Issue2043NullCoalesceStaticFieldTests
{
    [Fact]
    public void StaticField_NullCoalesceAssign_DoesNotThrowNRE()
    {
        // This is the primary regression test: prior to the fix, evaluating
        // this source threw a NullReferenceException out of the binder
        // (surfaced by gsc as GS9998) instead of returning a clean result.
        var source = @"
class C {
  shared {
    var Field string? = nil
  }
}

C.Field ??= ""default""
C.Field
";

        var exception = Record.Exception(() => Evaluate(source));

        Assert.Null(exception);
    }

    [Fact]
    public void StaticField_NullCoalesceAssign_FiresWhenNil()
    {
        var source = @"
class C {
  shared {
    var Field string? = nil
  }
}

C.Field ??= ""default""
C.Field
";

        var result = Evaluate(source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("default", result.Value);
    }

    [Fact]
    public void StaticField_NullCoalesceAssign_DoesNotFireWhenAlreadySet()
    {
        // The static field is set via a plain assignment first (rather than
        // relying on its declaration initializer, which the tree-walking
        // Evaluator does not eagerly run — a separate, pre-existing
        // limitation unrelated to this issue) so the ??= is exercised against
        // a genuinely non-nil static field.
        var source = @"
class C {
  shared {
    var Field string? = nil
  }
}

C.Field = ""already""
C.Field ??= ""default""
C.Field
";

        var result = Evaluate(source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("already", result.Value);
    }

    [Fact]
    public void InstanceField_NullCoalesceAssign_StillBindsAndEvaluates()
    {
        // Sibling instance-field case: makes sure the static-field fix does
        // not regress the (already-working) instance-receiver path, which
        // spills the instance receiver into a synthetic local via
        // CaptureReceiver.
        var source = @"
class C {
  var Field string? = nil
}

var c C = C{}
c.Field ??= ""default""
c.Field
";

        var result = Evaluate(source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("default", result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
