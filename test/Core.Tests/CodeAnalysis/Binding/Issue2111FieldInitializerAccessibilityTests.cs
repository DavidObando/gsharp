// <copyright file="Issue2111FieldInitializerAccessibilityTests.cs" company="GSharp">
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
/// Issue #2111: a static field/property initializer inside a <c>shared { }</c>
/// block is bound outside any function body, so no "current type" was
/// established for the accessibility gate
/// (<see cref="AccessibilityChecker.IsAccessible"/>). As a result a
/// <c>private</c> member of the ENCLOSING type accessed through a type-qualified
/// receiver (<c>Type.Member</c>) or a constructor call (<c>Type()</c>) was
/// wrongly rejected with GS0472 — even though an unqualified call in the same
/// initializer, and both access forms from a <c>shared</c> function body,
/// already worked. The fix threads the enclosing type through the accessibility
/// context while binding field/property initializers.
/// </summary>
public class Issue2111FieldInitializerAccessibilityTests
{
    [Fact]
    public void SharedFieldInitializer_QualifiedPrivateStaticCall_NoGS0472()
    {
        var source = @"
class ApplEnv {
    shared {
        let OSVersion int32 = ApplEnv.GetOsVersion()
        private func GetOsVersion() int32 {
            return 42
        }
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void SharedFieldInitializer_PrivateConstructorCall_NoGS0472()
    {
        var source = @"
class Logging {
    private init() {
    }
    shared {
        private let Instance Logging = Logging()
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void SharedFieldInitializer_UnqualifiedPrivateStaticCall_NoGS0472()
    {
        var source = @"
class ApplEnv2 {
    shared {
        let OSVersion int32 = GetOsVersion()
        private func GetOsVersion() int32 {
            return 42
        }
    }
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0472");
    }

    [Fact]
    public void ExternalCode_QualifiedPrivateStaticCallInInitializer_StillReportsGS0472()
    {
        var source = @"
class Foo {
    shared {
        private func Secret() int32 {
            return 42
        }
    }
}

class Bar {
    shared {
        let Value int32 = Foo.Secret()
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0472");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
