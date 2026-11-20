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
    func Null_CarriesACompilerSuggestion() {
        let compilation = Compilation(SyntaxTree.Parse("package P\n\nfunc F() string? -> null\n"))
        let diagnostic = Assert.Single(compilation.GetDiagnostics())
        let suggestion = Assert.Single(diagnostic.Suggestions)
        Assert.Equal("Use 'nil'", suggestion.Message)
        Assert.Equal(Applicability.MachineApplicable, suggestion.Applicability)
        let change = Assert.Single(suggestion.Changes)
        Assert.Equal(diagnostic.Location.Span, change.Span)
        Assert.Equal("nil", change.NewText)
        let fix = Assert.Single(CodeFixService(CodeFixRegistry()).GetFixes(compilation, diagnostic))
        Assert.Equal(CodeFixService.SuggestionProviderId, fix.ProviderId)
        // Severity configuration keeps the suggestions.
        Assert.Single(diagnostic.WithSeverity(DiagnosticSeverity.Warning).Suggestions)
    }

    @Fact
    func SwitchArmArrow_BecomesColon() {
        VerifyFix(
            "package P\n\nfunc F(n int32) string {\n    return switch n {\n        case 0 -> \"zero\" // z\n        default: \"other\"\n    }\n}\n",
            "GS0302",
            "Use ':'",
            Applicability.MachineApplicable,
            "package P\n\nfunc F(n int32) string {\n    return switch n {\n        case 0: \"zero\" // z\n        default: \"other\"\n    }\n}\n"
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
    func LetFieldThroughAReceiver_DoesNotChangeTheReceiver() {
        const source = "package P\n\nclass C {\n    let N int32 = 0\n}\n\nfunc F() {\n    let c = C()\n    c.N = 1\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0127")
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        for fix in service.GetFixes(compilation, target) {
            Assert.DoesNotContain("var c = C()", Assert.Single(service.Apply(fix)).Text.ToString())
        }
    }

    @Fact
    func LetField_WithAReceiverOfTheSameName_HasNoFix() {
        const source = "package P\n\nclass C {\n    let c int32 = 0\n}\n\nfunc F() {\n    let c = C()\n    c.c = 1\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0127")
        Assert.Empty(
            CodeFixService(CodeFixRegistry.CreateDefault()).GetFixes(compilation, target).Where(
                (f CodeFix) -> f.ProviderId == "GSharp.CodeFixes.LetToVar"
            )
        )
    }

    @Fact
    func LogicalWords_BeforeAParenthesizedOperand_AreFixed() {
        for word in[]string{"and", "or"} {
            let source = "package P\n\nfunc F(a bool, b bool) bool {\n    return a " + word + " (b)\n}\n"
            let tree = SyntaxTree.Parse(source)
            let compilation = Compilation(tree)
            let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0130")
            let service = CodeFixService(CodeFixRegistry.CreateDefault())
            let fix = Assert.Single(service.GetFixes(compilation, target))
            let expected = if word == "and" {
                "&&"
            } else {
                "||"
            }
            Assert.Contains("return a " + expected + " (b)\n", Assert.Single(service.Apply(fix)).Text.ToString())
        }
    }

    @Fact
    func NullCoalescingDefault_OnAnAssignment_DefaultsTheResult() {
        const source = "package P\n\nfunc F(y int32?) int32 {\n    var x int32? = nil\n    return x = y\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let diagnostic = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0155" || d.Id == "GS0156")
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        let fallback = service.GetFixes(compilation, diagnostic).Single(
            (f CodeFix) -> f.Title.StartsWith("Provide default", StringComparison.Ordinal)
        )
        Assert.Contains("return ((x = y) ?? 0)", Assert.Single(service.Apply(fallback)).Text.ToString())
    }

    @Fact
    func LogicalWords_BeforeEmptyParentheses_HaveNoFix() {
        for word in[]string{"and", "or", "not"} {
            let prefix = if word == "not" {
                ""
            } else {
                "a "
            }
            let source = "package P\n\nfunc F(a bool) bool {\n    return " + prefix + word + "()\n}\n"
            let tree = SyntaxTree.Parse(source)
            let compilation = Compilation(tree)
            let service = CodeFixService(CodeFixRegistry.CreateDefault())
            for target in compilation.GetDiagnostics().Where((d Diagnostic) -> d.Id == "GS0130" || d.Id == "GS0125") {
                Assert.Empty(
                    service.GetFixes(compilation, target).Where(
                        (f CodeFix) -> f.ProviderId == "GSharp.CodeFixes.LogicalWord"
                    )
                )
            }
        }
    }

    @Fact
    func Not_BeforeANegation_KeepsTwoPrefixOperators() {
        const source = "package P\n\nfunc F(a bool) bool {\n    return not !a\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        let fix = Assert.Single(service.GetFixes(compilation, target))
        let changed = Assert.Single(service.Apply(fix))
        Assert.Contains("return ! !a\n", changed.Text.ToString())
        Assert.Empty(changed.Diagnostics)
    }

    @Fact
    func NewOfAFunctionValue_HasNoFix() {
        const source = "package P\n\nclass C { }\n\nfunc F(make () -> C) C {\n    return new make()\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(CodeFixService(CodeFixRegistry.CreateDefault()).GetFixes(compilation, target))
    }

    @Fact
    func NewOfAnEscapedFunctionValue_HasNoFix() {
        let source = "package P\n\nclass C { }\n\nfunc F(" +
            "$" +
            "make () -> C) C {\n    return new " +
            "$" +
            "make()\n}\n"
        let compilation = Compilation(SyntaxTree.Parse(source))
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
        Assert.Empty(CodeFixService(CodeFixRegistry.CreateDefault()).GetFixes(compilation, target))
    }

    @Fact
    func NewOfATypeAlias_IsRemoved() {
        const source = "package P\n\nclass C { }\n\ntype D = C\n\nfunc F() C {\n    return new D()\n}\n"
        let compilation = Compilation(SyntaxTree.Parse(source))
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0125")
        let fix = Assert.Single(CodeFixService(CodeFixRegistry.CreateDefault()).GetFixes(compilation, target))
        Assert.Contains("return D()", Assert.Single(fix.GetChanges().Documents).GetChangedText().ToString())
    }

    @Fact
    func NullCoalescingDefault_ForANarrowType_IsTyped() {
        const source = "package P\n\nfunc F(x uint8?) uint8 -> x\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let diagnostic = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0155" || d.Id == "GS0156")
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        let fallback = service.GetFixes(compilation, diagnostic).Single(
            (f CodeFix) -> f.Title.StartsWith("Provide default", StringComparison.Ordinal)
        )
        Assert.Contains("(x ?? uint8(0))", Assert.Single(service.Apply(fallback)).Text.ToString())
        Assert.True(DeltaPolicy.NoNewDiagnostics.Accepts(service.ComputeDelta(compilation, fallback)))
    }

    @Fact
    func LogicalWords_WithoutOperands_HaveNoFix() {
        for source in[]string{
            "package P\n\nfunc F() bool {\n    return or\n}\n",
            "package P\n\nfunc G(x bool) bool -> x\n\nfunc F() bool {\n    return G(or)\n}\n",
            "package P\n\nfunc F(a bool) bool {\n    return a and\n}\n"
        } {
            let tree = SyntaxTree.Parse(source)
            let compilation = Compilation(tree)
            let service = CodeFixService(CodeFixRegistry.CreateDefault())
            let words = compilation.GetDiagnostics().Where((d Diagnostic) -> d.Id == "GS0125").ToList()
            Assert.NotEmpty(words)
            for word in words {
                Assert.Empty(
                    service.GetFixes(compilation, word).Where(
                        (f CodeFix) -> f.ProviderId == "GSharp.CodeFixes.LogicalWord"
                    )
                )
            }
        }
    }

    @Fact
    func NullAssertion_OnACompoundExpression_IsParenthesized() {
        const source = "package P\n\nfunc F(a int32?, b int32?) int32 {\n    return a + b\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let diagnostic = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0155" || d.Id == "GS0156")
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        let assertion = service.GetFixes(compilation, diagnostic).Single(
            (f CodeFix) -> f.Title == "Assert non-nil with '!!'"
        )
        let changed = Assert.Single(service.Apply(assertion))
        Assert.Contains("return ((a + b)!!)", changed.Text.ToString())
        Assert.True(DeltaPolicy.NoNewDiagnostics.Accepts(service.ComputeDelta(compilation, assertion)))
    }

    @Fact
    func NarrowingNumericConversion_IsWrapped() {
        VerifyFix(
            "package P\n\nfunc F(n int64) int32 {\n    let m int32 = n // keep\n    return m\n}\n",
            "GS0156",
            "Convert to 'int32'",
            Applicability.MaybeIncorrect,
            "package P\n\nfunc F(n int64) int32 {\n    let m int32 = checked(cast[int32](n)) // keep\n    return m\n}\n"
        )
    }

    @Fact
    func LetField_BareAssignmentInTheSameClass_BecomesVar() {
        // `N = 2` has an implicit receiver; GetSymbolInfo answers `this` (#6126), so the provider
        // looks the field up by the name that GS0127 gives.
        VerifyFix(
            "package P\n\nclass C {\n    let N int32 = 1\n\n    func Set() {\n        N = 2\n    }\n}\n",
            "GS0127",
            "Change 'let' to 'var'",
            Applicability.MaybeIncorrect,
            "package P\n\nclass C {\n    var N int32 = 1\n\n    func Set() {\n        N = 2\n    }\n}\n"
        )
    }

    @Fact
    func NumericConversion_OfAnOutOfRangeValue_Throws() {
        // `var` keeps the value out of constant folding, so the check happens at run time.
        const source = "var n int64 = 4294967296\nlet m int32 = n\nm\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let target = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0156")
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        let fixedText = Assert
            .Single(service.Apply(Assert.Single(service.GetFixes(compilation, target))))
            .Text
            .ToString()
        let result = GSharp.Tests.EmittedOracle.Evaluate(fixedText)
        // The oracle reports the run-time exception also as a synthesized diagnostic.
        Assert.IsType[OverflowException](result.UnhandledException)
        // The unchecked spelling silently gives 0.
        let unchecked = GSharp
            .Tests
            .EmittedOracle
            .Evaluate(fixedText.Replace("checked(cast[int32](n))", "cast[int32](n)"))
        Assert.Null(unchecked.UnhandledException)
        Assert.Equal("0", unchecked.ValueText)
    }

    @Fact
    func NumericConversion_IsDeclinedWhereItWouldChangeTheValueOrNotCompile() {
        for source in[]string{
            // A compound assignment converts the operation's result, not the right operand.
            "package P\n\nfunc F(y int64) int32 {\n    var x int32 = 100\n    x /= y\n    return x\n}\n",
            // The span covers a tuple while the arguments name one element's conversion.
            "package P\n\nfunc F(n int32) {\n    let values = [](int32, uint8){(1, n)}\n}\n",
            // An assignment operand is not a simple operand.
            "package P\n\nfunc F(y int64) int32 {\n    var x int64 = 0\n    return x = y\n}\n",
            // `&^=` is a compound assignment too.
            "package P\n\nfunc F(y int64) int32 {\n    var x int32 = 100\n    x &^= y\n    return x\n}\n",
            // A constant is checked at compile time.
            "package P\n\nconst Big int64 = 300\n\nfunc F() int8 {\n    let a int8 = Big\n    return a\n}\n"
        } {
            let tree = SyntaxTree.Parse(source)
            let compilation = Compilation(tree)
            let service = CodeFixService(CodeFixRegistry.CreateDefault())
            for target in compilation.GetDiagnostics().Where((d Diagnostic) -> d.Id == "GS0156") {
                Assert.Empty(
                    service.GetFixes(compilation, target).Where(
                        (f CodeFix) -> f.ProviderId == "GSharp.CodeFixes.NumericConversion"
                    )
                )
            }
        }
    }

    @Fact
    func NumericConversion_CoversNativeIntegersAndChar() {
        VerifyFix(
            "package P\n\nfunc F(n nint) int32 {\n    let m int32 = n\n    return m\n}\n",
            "GS0156",
            "Convert to 'int32'",
            Applicability.MaybeIncorrect,
            "package P\n\nfunc F(n nint) int32 {\n    let m int32 = checked(cast[int32](n))\n    return m\n}\n"
        )
    }

    @Fact
    func NumericConversion_IsACast_EvenWithAFunctionNamedLikeTheType() {
        VerifyFix(
            "package P\n\nfunc int32(n int64) int32 -> 0\n\nfunc F(n int64) int32 {\n    let m int32 = n\n    return m\n}\n",
            "GS0156",
            "Convert to 'int32'",
            Applicability.MaybeIncorrect,
            "package P\n\nfunc int32(n int64) int32 -> 0\n\nfunc F(n int64) int32 {\n    let m int32 = checked(cast[int32](n))\n    return m\n}\n"
        )
    }

    @Fact
    func NullableValue_InsideAnInterpolationHole_GetsItsFixes() {
        let source = "package P\n\nfunc Use(s string) int32 -> s.Length\n\nfunc F(t string?) string -> \"x " +
            "$" +
            "{Use(t)}\"\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "a.gs"))
        let compilation = Compilation(tree)
        let diagnostic = compilation.GetDiagnostics().First((d Diagnostic) -> d.Id == "GS0154" || d.Id == "GS0155")
        let fixes = CodeFixService(CodeFixRegistry.CreateDefault()).GetFixes(compilation, diagnostic)
        Assert.Contains(fixes, (f CodeFix) -> f.Title == "Assert non-nil with '!!'")
    }

    @Fact
    func NumericConversion_LooksThroughParentheses() {
        VerifyFix(
            "package P\n\nfunc F(n int64) int32 {\n    let m int32 = (n)\n    return m\n}\n",
            "GS0156",
            "Convert to 'int32'",
            Applicability.MaybeIncorrect,
            "package P\n\nfunc F(n int64) int32 {\n    let m int32 = checked(cast[int32]((n)))\n    return m\n}\n"
        )
    }

    @Fact
    func LetSharedField_OfAnInlineStruct_BecomesVar() {
        VerifyFix(
            "package P\n\ninline struct S {\n    shared {\n        let Count int32 = 0\n\n        func Set() {\n            Count = 2\n        }\n    }\n}\n",
            "GS0127",
            "Change 'let' to 'var'",
            Applicability.MaybeIncorrect,
            "package P\n\ninline struct S {\n    shared {\n        var Count int32 = 0\n\n        func Set() {\n            Count = 2\n        }\n    }\n}\n"
        )
    }

    @Fact
    func LetField_OfAnInlineStruct_HasNoFix() {
        const source = "package P\n\ninline struct S {\n    let N int32 = 1\n\n    func Set() {\n        N = 2\n    }\n}\n"
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        for target in compilation.GetDiagnostics().Where((d Diagnostic) -> d.Id == "GS0127") {
            Assert.Empty(
                service.GetFixes(compilation, target).Where((f CodeFix) -> f.ProviderId == "GSharp.CodeFixes.LetToVar")
            )
        }
    }

    @Fact
    func LetField_WithAnEscapedName_BecomesVar() {
        // `$yield` is written with a placeholder: `$` starts an interpolation in a G# string.
        let dollar = "$"
        VerifyFix(
            "package P\n\nclass C {\n    let DOLLARyield int32 = 1\n\n    func Set() {\n        DOLLARyield = 2\n    }\n}\n"
                .Replace("DOLLAR", dollar),
            "GS0127",
            "Change 'let' to 'var'",
            Applicability.MaybeIncorrect,
            "package P\n\nclass C {\n    var DOLLARyield int32 = 1\n\n    func Set() {\n        DOLLARyield = 2\n    }\n}\n"
                .Replace("DOLLAR", dollar)
        )
    }

    @Fact
    func LetField_InAnotherFile_BecomesVar_WithAMultiDocumentFix() {
        let a = SyntaxTree.Parse(SourceText.From("package P\n\npartial class C {\n    let N int32 = 1\n}\n", "a.gs"))
        let b = SyntaxTree.Parse(
            SourceText.From("package P\n\npartial class C {\n    func Set() {\n        N = 2\n    }\n}\n", "b.gs")
        )
        let compilation = Compilation(a, b)
        let target = compilation.GetDiagnostics().Single((d Diagnostic) -> d.Id == "GS0127")
        Assert.Same(b.Text, target.Location.Text)
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        let fix = Assert.Single(service.GetFixes(compilation, target))
        Assert.Equal(Applicability.MaybeIncorrect, fix.Applicability)
        let document = Assert.Single(fix.GetChanges().Documents)
        Assert.Same(a, document.Tree)
        Assert.Equal("package P\n\npartial class C {\n    var N int32 = 1\n}\n", document.GetChangedText().ToString())
        Assert.True(DeltaPolicy.NoNewDiagnostics.Accepts(service.ComputeDelta(compilation, fix)))
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
