// <copyright file="Adr0227BuiltInFixTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0227 D8: golden before/after tests of the built-in fixes. Each fix keeps the comments near
/// the edit, removes its target and passes the default gate (no new diagnostic).
open class Adr0227BuiltInFixTests {
    @Fact
    func Null_BecomesNil() {
        VerifyFix(
            "package P\n\nfunc F() string? {\n    // a\n    return /* b */ null // c\n}\n",
            "GS0273",
            "Use 'nil'",
            Applicability.MachineApplicable,
            "package P\n\nfunc F() string? {\n    // a\n    return /* b */ nil // c\n}\n"
        )
    }

    @Fact
    func NewOfAClass_IsRemoved() {
        VerifyFix(
            "package P\n\nimport System.Text\n\nfunc F() string {\n    let sb = new StringBuilder() // keep\n    return sb.ToString()\n}\n",
            "GS0125",
            "Remove 'new'",
            Applicability.MachineApplicable,
            "package P\n\nimport System.Text\n\nfunc F() string {\n    let sb = StringBuilder() // keep\n    return sb.ToString()\n}\n"
        )
    }

    @Fact
    func NewOfASourceClass_AndOfString_AreRemoved() {
        VerifyFix(
            "package P\n\nclass C { }\n\nfunc F() C {\n    return new C()\n}\n",
            "GS0125",
            "Remove 'new'",
            Applicability.MachineApplicable,
            "package P\n\nclass C { }\n\nfunc F() C {\n    return C()\n}\n"
        )
        VerifyFix(
            "package P\n\nfunc F(chars []char) string {\n    return new string(chars)\n}\n",
            "GS0125",
            "Remove 'new'",
            Applicability.MachineApplicable,
            "package P\n\nfunc F(chars []char) string {\n    return string(chars)\n}\n"
        )
    }

    @Fact
    func NewOfAStruct_OrOfAFunction_HasNoFix() {
        VerifyNoFix("package P\n\nstruct S { var X int32 }\n\nfunc F() S {\n    return new S(1)\n}\n", "GS0125")
        VerifyNoFix(
            "package P\n\nclass C { }\n\nfunc Make() C -> C()\n\nfunc F() C {\n    return new Make()\n}\n",
            "GS0125"
        )
    }

    @Fact
    func LetLocal_AssignedAgain_BecomesVar() {
        VerifyFix(
            "package P\n\nfunc F() int32 {\n    let /* k */ x = 1\n    x = 2\n    return x\n}\n",
            "GS0127",
            "Change 'let' to 'var'",
            Applicability.MachineApplicable,
            "package P\n\nfunc F() int32 {\n    var /* k */ x = 1\n    x = 2\n    return x\n}\n"
        )
    }

    @Fact
    func LetLocal_CompoundAssignment_BecomesVar() {
        VerifyFix(
            "package P\n\nfunc F() int32 {\n    let x = 1\n    x += 2\n    return x\n}\n",
            "GS0127",
            "Change 'let' to 'var'",
            Applicability.MachineApplicable,
            "package P\n\nfunc F() int32 {\n    var x = 1\n    x += 2\n    return x\n}\n"
        )
    }

    @Fact
    func OrAndAnd_BecomeOperators() {
        VerifyFix(
            "package P\n\nfunc F(a bool, b bool) bool {\n    return a or b // x\n}\n",
            "GS0125",
            "Use '||'",
            Applicability.MachineApplicable,
            "package P\n\nfunc F(a bool, b bool) bool {\n    return a || b // x\n}\n"
        )
        VerifyFix(
            "package P\n\nfunc F(a bool, b bool) bool {\n    return a and b\n}\n",
            "GS0125",
            "Use '&&'",
            Applicability.MachineApplicable,
            "package P\n\nfunc F(a bool, b bool) bool {\n    return a && b\n}\n"
        )
    }

    @Fact
    func Not_BecomesBang() {
        VerifyFix(
            "package P\n\nfunc F(a bool) bool {\n    if not a {\n        return false\n    }\n    return true\n}\n",
            "GS0125",
            "Use '!'",
            Applicability.MaybeIncorrect,
            "package P\n\nfunc F(a bool) bool {\n    if !a {\n        return false\n    }\n    return true\n}\n"
        )
    }

    @Fact
    func NotCall_BecomesBang_AndTheGateSeesTheOtherWords() {
        const source = "package P\n\nfunc F(a bool, b bool) bool {\n    if not (a and b) {\n        return false\n    }\n    return true\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "a.gs"))
        let compilation = Compilation(tree)
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        let notDiagnostic = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0130")
        let fix = Assert.Single(service.GetFixes(compilation, notDiagnostic))
        Assert.Equal("Use '!'", fix.Title)
        Assert.Contains("    if !(a and b) {\n", Assert.Single(service.Apply(fix)).Text.ToString())
        let andDiagnostic = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0125")
        let andFix = Assert.Single(service.GetFixes(compilation, andDiagnostic))
        // Replacing `and` also removes the two GS0005 errors that the word caused.
        let delta = service.ComputeDelta(compilation, andFix)
        Assert.True(DeltaPolicy.NoNewDiagnostics.Accepts(delta))
        Assert.Equal(3, delta.Removed.Length)
    }

    @Fact
    func NullConditionalAccess_IsMaybeIncorrect_AndTheGateRejectsItHere() {
        VerifyFix(
            "package P\n\nclass C {\n    var N int32\n}\n\nfunc F(c C?) int32 {\n    return c.N\n}\n",
            "GS0158",
            "Use null-conditional access '?.'",
            Applicability.MaybeIncorrect,
            "package P\n\nclass C {\n    var N int32\n}\n\nfunc F(c C?) int32 {\n    return c?.N\n}\n",
            false,
            false
        )
    }

    @Fact
    func NullableValue_GetsDefaultAndAssertionFixes() {
        const source = "package P\n\nfunc Use(s string) int32 -> s.Length\n\nfunc F(t string?) int32 {\n    return Use(t)\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "a.gs"))
        let compilation = Compilation(tree)
        let diagnostic = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0154" || d.Id == "GS0155")
        let fixes = CodeFixService(CodeFixRegistry.CreateDefault()).GetFixes(compilation, diagnostic)
        Assert.Equal(
            []string{"Provide default with '?? \"\"'", "Assert non-nil with '!!'"},
            fixes.Select((f CodeFix) -> f.Title).ToArray()
        )
        Assert.All(fixes, (f CodeFix) -> Assert.Equal(Applicability.MaybeIncorrect, f.Applicability))
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        Assert.Contains("return Use((t ?? \"\"))", Assert.Single(service.Apply(fixes[0])).Text.ToString())
        Assert.Contains("return Use((t!!))", Assert.Single(service.Apply(fixes[1])).Text.ToString())
    }

    @Fact
    func CompilerDiagnostics_KeepDescriptorAndMessageArguments() {
        let compilation = Compilation(
            SyntaxTree.Parse("package P\n\nfunc F() int32 {\n    let x = 1\n    x = 2\n    return missing\n}\n")
        )
        let diagnostics = compilation.GetDiagnostics()
        Assert.NotEmpty(diagnostics)
        Assert.All(
            diagnostics,
            (d Diagnostic) -> {
                Assert.NotNull(d.Descriptor)
                Assert.Equal(d.Id, d.Descriptor!!.Id)
                Assert.Equal(
                    d.Message,
                    string.Format(d.Descriptor!!.MessageFormat, d.MessageArguments.Cast[object]().ToArray())
                )
            }
        )
        Assert.Equal("x", Assert.Single(diagnostics.Where((d Diagnostic) -> d.Id == "GS0127")).MessageArguments[0])
    }

    private func VerifyFix(
        before string,
        diagnosticId string,
        title string,
        applicability Applicability,
        after string,
        requireClean bool = true,
        gateAccepts bool = true
    ) {
        let tree = SyntaxTree.Parse(SourceText.From(before, "a.gs"))
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == diagnosticId)
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        let fix = Assert.Single(service.GetFixes(compilation, target))
        Assert.Equal(title, fix.Title)
        Assert.Equal(applicability, fix.Applicability)
        let newTree = Assert.Single(service.Apply(fix))
        Assert.Equal(after, newTree.Text.ToString())
        let delta = service.ComputeDelta(compilation, fix)
        Assert.True(delta.TargetRemoved)
        // `c?.N` is `int32?`, so the `?.` fix adds GS0156 here: the gate rejects it.
        Assert.Equal(gateAccepts, DeltaPolicy.NoNewDiagnostics.Accepts(delta))
        if requireClean {
            Assert.Empty(Compilation(newTree).GetDiagnostics().Where((d Diagnostic) -> d.Id == diagnosticId))
        }
    }

    private func VerifyNoFix(source string, diagnosticId string) {
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        let targets = compilation.GetDiagnostics().Where((d Diagnostic) -> d.Id == diagnosticId).ToList()
        Assert.NotEmpty(targets)
        for target in targets {
            Assert.Empty(
                service.GetFixes(compilation, target).Where(
                    (f CodeFix) -> f.ProviderId.StartsWith("GSharp.CodeFixes.DropNew", StringComparison.Ordinal)
                )
            )
        }
    }
}
