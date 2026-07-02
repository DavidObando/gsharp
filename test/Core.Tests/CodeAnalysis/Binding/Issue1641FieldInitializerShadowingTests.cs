// <copyright file="Issue1641FieldInitializerShadowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1641: the instance field initializer scan
/// (<c>DeclarationBinder.TryFindInstanceMemberReference</c>) must respect
/// scoping/shadowing. A lambda parameter, nested lambda parameter, or local
/// binding that shares a name with an instance member must not be treated as
/// an illegal instance-member reference (GS0377) — only a name that
/// genuinely resolves to the instance member, unshadowed, may be flagged.
/// </summary>
public class Issue1641FieldInitializerShadowingTests
{
    [Fact]
    public void FieldInitializer_LambdaParamShadowsFieldName_NoGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let Compare (int32) -> bool = (value int32) -> value > 0\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_GenuineInstanceMemberReference_StillReportsGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let Other int32 = value + 1\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_NestedLambdaParamShadowsFieldName_NoGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> (int32) -> int32 = (x int32) -> (value int32) -> value + x\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_LocalLetShadowsFieldName_NoGS0377()
    {
        // A field initializer can only be a bare expression (block
        // expressions are only legal as a lambda/if-expression body), so the
        // local `let` lives inside the lambda's block body.
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> int32 = (x int32) -> {\n" +
            "        let value int32 = 10\n" +
            "        value\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_ReferenceOutsideLambdaScope_StillReportsGS0377()
    {
        // The inner lambda parameter `value` only shadows the field inside
        // its own body; the trailing `+ value` refers to the instance field
        // and must still be rejected.
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> int32 = (x int32) -> {\n" +
            "        let g (int32) -> int32 = (value int32) -> value + 1\n" +
            "        g(3) + value\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics.ToList();
    }
}
