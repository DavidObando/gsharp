// <copyright file="Issue1641FieldInitializerShadowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1641: the instance field initializer scan
/// (`DeclarationBinder.TryFindInstanceMemberReference`) must respect
/// scoping/shadowing. A lambda parameter, nested lambda parameter, or local
/// binding that shares a name with an instance member must not be treated as
/// an illegal instance-member reference (GS0377) — only a name that
/// genuinely resolves to the instance member, unshadowed, may be flagged.
open class Issue1641FieldInitializerShadowingTests {
    @Fact
    func FieldInitializer_LambdaParamShadowsFieldName_NoGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let Compare (int32) -> bool = (value int32) -> value > 0\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_GenuineInstanceMemberReference_StillReportsGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let Other int32 = value + 1\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_NestedLambdaParamShadowsFieldName_NoGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> (int32) -> int32 = (x int32) -> (value int32) -> value + x\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_LocalLetShadowsFieldName_NoGS0377() {
        // A field initializer can only be a bare expression (block
        // expressions are only legal as a lambda/if-expression body), so the
        // local `let` lives inside the lambda's block body.
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> int32 = (x int32) -> {\n" +
            "        let value int32 = 10\n" +
            "        value\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_ReferenceOutsideLambdaScope_StillReportsGS0377() {
        // The inner lambda parameter `value` only shadows the field inside
        // its own body; the trailing `+ value` refers to the instance field
        // and must still be rejected.
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> int32 = (x int32) -> {\n" +
            "        let g (int32) -> int32 = (value int32) -> value + 1\n" +
            "        g(3) + value\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_CatchVariableShadowsMemberName_NoGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> int32 = (x int32) -> {\n" +
            "        try {\n" +
            "            x\n" +
            "        } catch (value Exception) {\n" +
            "            value.Message.Length\n" +
            "        }\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_CatchClause_GenuineMemberReferenceInTryBlock_StillReportsGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> int32 = (x int32) -> {\n" +
            "        try {\n" +
            "            value\n" +
            "        } catch (e Exception) {\n" +
            "            x\n" +
            "        }\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_ForRangeVariableShadowsMemberName_NoGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F ([]int32) -> int32 = (xs []int32) -> {\n" +
            "        var total int32 = 0\n" +
            "        for value in xs {\n" +
            "            total = total + value\n" +
            "        }\n" +
            "        total\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_ForRangeBody_GenuineMemberReference_StillReportsGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F ([]int32) -> int32 = (xs []int32) -> {\n" +
            "        var total int32 = 0\n" +
            "        for v in xs {\n" +
            "            total = total + value\n" +
            "        }\n" +
            "        total\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_ForEllipsisVariableShadowsMemberName_NoGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> int32 = (x int32) -> {\n" +
            "        var total int32 = 0\n" +
            "        for value in 0 ... x {\n" +
            "            total = total + value\n" +
            "        }\n" +
            "        total\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_ForEllipsisBody_GenuineMemberReference_StillReportsGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (int32) -> int32 = (x int32) -> {\n" +
            "        var total int32 = 0\n" +
            "        for i in 0 ... x {\n" +
            "            total = total + value\n" +
            "        }\n" +
            "        total\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_AwaitForRangeVariableShadowsMemberName_NoGS0377() {
        const source = "import System.Linq\n" +
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
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_AwaitForRangeBody_GenuineMemberReference_StillReportsGS0377() {
        const source = "import System.Linq\n" +
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
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_IfLetBindingShadowsMemberName_NoGS0377InThenBranch() {
        // `if let` is a statement (not an if-expression), so its branches
        // use `return` rather than a trailing value.
        const source = "package p\n" +
            "class C {\n" +
            "    let value string? = nil\n" +
            "    let F (string?) -> int32 = (s string?) -> {\n" +
            "        if let value = s {\n" +
            "            return value.Length\n" +
            "        }\n" +
            "        return 0\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_IfLetElseBranch_GenuineMemberReference_StillReportsGS0377() {
        // The `if let` binding is not visible in the else branch, so a
        // reference to the member name there is a genuine, unshadowed
        // instance-member access and must still be flagged.
        const source = "package p\n" +
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
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_WhileLetBindingShadowsMemberNameOnlyInBody() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value string? = nil\n" +
            "    let F (string?) -> int32 = (s string?) -> {\n" +
            "        while let value = s {\n" +
            "            return value.Length\n" +
            "        }\n" +
            "        return 0\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_WhileLetBody_GenuineMemberReferenceStillReportsGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (string?) -> int32 = (s string?) -> {\n" +
            "        while let text = s {\n" +
            "            return value\n" +
            "        }\n" +
            "        return 0\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_GuardLetBindingShadowsMemberName_NoGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value string? = nil\n" +
            "    let F (string?) -> int32 = (s string?) -> {\n" +
            "        guard let value = s else {\n" +
            "            return 0\n" +
            "        }\n" +
            "        return value.Length\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_GuardLetTail_GenuineMemberReference_StillReportsGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let text string? = nil\n" +
            "    let F (string?) -> int32 = (s string?) -> {\n" +
            "        guard let x = s else {\n" +
            "            return 0\n" +
            "        }\n" +
            "        return value\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_TupleDeconstructionShadowsMemberName_NoGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F ((int32, int32)) -> int32 = (p (int32, int32)) -> {\n" +
            "        let (value, y) = p\n" +
            "        value + y\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_TupleDeconstructionTail_GenuineMemberReference_StillReportsGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F ((int32, int32)) -> int32 = (p (int32, int32)) -> {\n" +
            "        let (a, b) = p\n" +
            "        a + b + value\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_NamedDeconstructionShadowsMemberName_NoGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F ((int32, int32)) -> int32 = (p (int32, int32)) -> {\n" +
            "        let { Item1 = value } = p\n" +
            "        value\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_NamedDeconstructionTail_GenuineMemberReference_StillReportsGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F ((int32, int32)) -> int32 = (p (int32, int32)) -> {\n" +
            "        let { Item1 = a } = p\n" +
            "        a + value\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_SwitchTypePatternCaptureShadowsMemberName_NoGS0377() {
        // A `switch` arm's type-pattern capture (e.g. `case value is int32:`)
        // is the only capture-producing pattern form G# supports (there is no
        // C#-style `expr is T name` capture at expression level); the capture
        // is visible in the guard/result of its own arm only.
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (object) -> int32 = (o object) -> {\n" +
            "        switch o {\n" +
            "            case value is int32: value\n" +
            "            default: 0\n" +
            "        }\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    @Fact
    func FieldInitializer_SwitchArm_GenuineMemberReference_StillReportsGS0377() {
        const source = "package p\n" +
            "class C {\n" +
            "    let value int32 = 5\n" +
            "    let F (object) -> int32 = (o object) -> {\n" +
            "        switch o {\n" +
            "            case x is int32: value\n" +
            "            default: 0\n" +
            "        }\n" +
            "    }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0377")
    }

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics.ToList()
        }
    }
}
