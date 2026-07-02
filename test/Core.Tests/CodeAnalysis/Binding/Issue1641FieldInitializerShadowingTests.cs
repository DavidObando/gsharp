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

    [Fact]
    public void FieldInitializer_CatchVariableShadowsMemberName_NoGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> int32 = (x int32) -> {\n" +
            "        try {\n" +
            "            x\n" +
            "        } catch (value Exception) {\n" +
            "            value.Message.Length\n" +
            "        }\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_CatchClause_GenuineMemberReferenceInTryBlock_StillReportsGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> int32 = (x int32) -> {\n" +
            "        try {\n" +
            "            value\n" +
            "        } catch (e Exception) {\n" +
            "            x\n" +
            "        }\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_ForRangeVariableShadowsMemberName_NoGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F ([]int32) -> int32 = (xs []int32) -> {\n" +
            "        var total int32 = 0\n" +
            "        for value in xs {\n" +
            "            total = total + value\n" +
            "        }\n" +
            "        total\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_ForRangeBody_GenuineMemberReference_StillReportsGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F ([]int32) -> int32 = (xs []int32) -> {\n" +
            "        var total int32 = 0\n" +
            "        for v in xs {\n" +
            "            total = total + value\n" +
            "        }\n" +
            "        total\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_ForEllipsisVariableShadowsMemberName_NoGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> int32 = (x int32) -> {\n" +
            "        var total int32 = 0\n" +
            "        for value in 0 ... x {\n" +
            "            total = total + value\n" +
            "        }\n" +
            "        total\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_ForEllipsisBody_GenuineMemberReference_StillReportsGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> int32 = (x int32) -> {\n" +
            "        var total int32 = 0\n" +
            "        for i in 0 ... x {\n" +
            "            total = total + value\n" +
            "        }\n" +
            "        total\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_AwaitForRangeVariableShadowsMemberName_NoGS0377()
    {
        const string source =
            "import System.Linq\n" +
            "import GSharp.Core.Tests.CodeAnalysis.Binding\n" +
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F async () -> int32 = async () -> {\n" +
            "        var total int32 = 0\n" +
            "        await for value in AsyncStreamFixture.Counts() {\n" +
            "            total = total + value\n" +
            "        }\n" +
            "        total\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_AwaitForRangeBody_GenuineMemberReference_StillReportsGS0377()
    {
        const string source =
            "import System.Linq\n" +
            "import GSharp.Core.Tests.CodeAnalysis.Binding\n" +
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F async () -> int32 = async () -> {\n" +
            "        var total int32 = 0\n" +
            "        await for v in AsyncStreamFixture.Counts() {\n" +
            "            total = total + value\n" +
            "        }\n" +
            "        total\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_IfLetBindingShadowsMemberName_NoGS0377InThenBranch()
    {
        // `if let` is a statement (not an if-expression), so its branches
        // use `return` rather than a trailing value.
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value string? = nil\n" +
            "    let F (string?) -> int32 = (s string?) -> {\n" +
            "        if let value = s {\n" +
            "            return value.Length\n" +
            "        }\n" +
            "        return 0\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_IfLetElseBranch_GenuineMemberReference_StillReportsGS0377()
    {
        // The `if let` binding is not visible in the else branch, so a
        // reference to the member name there is a genuine, unshadowed
        // instance-member access and must still be flagged.
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let text string? = nil\n" +
            "    let F (string?) -> int32 = (s string?) -> {\n" +
            "        if let value = s {\n" +
            "            return 0\n" +
            "        } else {\n" +
            "            return value\n" +
            "        }\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_GuardLetBindingShadowsMemberName_NoGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value string? = nil\n" +
            "    let F (string?) -> int32 = (s string?) -> {\n" +
            "        guard let value = s else {\n" +
            "            return 0\n" +
            "        }\n" +
            "        return value.Length\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_GuardLetTail_GenuineMemberReference_StillReportsGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let text string? = nil\n" +
            "    let F (string?) -> int32 = (s string?) -> {\n" +
            "        guard let x = s else {\n" +
            "            return 0\n" +
            "        }\n" +
            "        return value\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_TupleDeconstructionShadowsMemberName_NoGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F ((int32, int32)) -> int32 = (p (int32, int32)) -> {\n" +
            "        let (value, y) = p\n" +
            "        value + y\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_TupleDeconstructionTail_GenuineMemberReference_StillReportsGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F ((int32, int32)) -> int32 = (p (int32, int32)) -> {\n" +
            "        let (a, b) = p\n" +
            "        a + b + value\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_NamedDeconstructionShadowsMemberName_NoGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F ((int32, int32)) -> int32 = (p (int32, int32)) -> {\n" +
            "        let { Item1 = value } = p\n" +
            "        value\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_NamedDeconstructionTail_GenuineMemberReference_StillReportsGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F ((int32, int32)) -> int32 = (p (int32, int32)) -> {\n" +
            "        let { Item1 = a } = p\n" +
            "        a + value\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_SwitchTypePatternCaptureShadowsMemberName_NoGS0377()
    {
        // A `switch` arm's type-pattern capture (e.g. `case value is int32:`)
        // is the only capture-producing pattern form G# supports (there is no
        // C#-style `expr is T name` capture at expression level); the capture
        // is visible in the guard/result of its own arm only.
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (object) -> int32 = (o object) -> {\n" +
            "        switch o {\n" +
            "            case value is int32: value\n" +
            "            default: 0\n" +
            "        }\n" +
            "    }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void FieldInitializer_SwitchArm_GenuineMemberReference_StillReportsGS0377()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (object) -> int32 = (o object) -> {\n" +
            "        switch o {\n" +
            "            case x is int32: value\n" +
            "            default: 0\n" +
            "        }\n" +
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
