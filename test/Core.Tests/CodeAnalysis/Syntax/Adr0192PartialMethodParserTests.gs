// <copyright file="Adr0192PartialMethodParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0192 / issue #4301: parser-layer tests for the `partial` contextual
/// modifier on a `func` member. These cover recognition of both parts (the
/// `;`-bodied declaring part and the block-bodied implementing part), the
/// modifier's composition with `async`/`suspend`/`unsafe` in
/// either order, GS0607 for every position a partial member cannot occupy, and
/// — the load-bearing negative — that `partial` remains an ordinary
/// identifier everywhere else.
open class Adr0192PartialMethodParserTests {
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Recognition — both parts, and the modifier's composition
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func DeclaringPart_IsRecognized_WithSemicolonBodyAndNoBlockBody() {
        let method = SingleMethod(`package App
partial class A {
    partial func F(x int32) string;
}
`)
        Assert.True(method.IsPartial)
        Assert.True(method.HasSemicolonBody)
        Assert.Null(method.Body)
        Assert.Equal("partial", method.PartialModifier!!.Text)
    }

    @Fact
    func ImplementingPart_IsRecognized_WithBlockBody() {
        let method = SingleMethod(`package App
partial class A {
    partial func F(x int32) string { return "" }
}
`)
        Assert.True(method.IsPartial)
        Assert.False(method.HasSemicolonBody)
        Assert.NotNull(method.Body)
    }

    @Fact
    func PartialModifier_IsIncludedInTheDeclarationSpan() {
        // Regression guard for the [SyntaxChildIgnore] decision: PartialModifier
        // must be a real child, so the node's span covers the token. If it were
        // ignored, the span would start at `func` and the token would drop out
        // of every tree walk that drives tooling.
        const Source = `package App
partial class A {
    partial func F() int32;
}
`
        let method = SingleMethod(Source)
        let text = SourceText.From(Source)
        Assert.StartsWith("partial", text.ToString(method.Span))
    }

    @Theory
    @InlineData("partial async func F() int32 { return 1 }")
    @InlineData("async partial func F() int32 { return 1 }")
    @InlineData("partial unsafe func F() int32 { return 1 }")
    @InlineData("unsafe partial func F() int32 { return 1 }")
    @InlineData("partial unsafe async func F() int32 { return 1 }")
    @InlineData("public partial func F() int32 { return 1 }")
    func PartialModifier_ComposesWithUnsafeAndColorModifiers_InEitherOrder(member string) {
        let method = SingleMethod((`package App
partial class A {
    ` + "$member" + `
}
`))
        Assert.True(method.IsPartial)
    }

    @Theory
    @MemberData("ModifierRunPermutations")
    func EveryModifierRunPermutation_ParsesAsAPartialInstanceMethod(modifiers string) {
        // Copilot review round, findings 3. Before the shared modifier-run
        // consumer, `async partial unsafe` and `unsafe partial async` — the two
        // orderings that put `partial` BETWEEN the colour modifier and
        // `unsafe` — left a stray token where `func` was expected and cascaded
        // into a dozen recovery diagnostics.
        let source = (`package App
partial class A {
    ` + "$modifiers" + ` func F() int32 { return 1 }
}
`)
        let diagnostics = ParseDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let method = SingleMethod(source)
        Assert.True(method.IsPartial)
        Assert.True(method.IsUnsafe)
        Assert.True(method.IsAsync)
    }

    @Theory
    @MemberData("ModifierRunPermutations")
    func EveryModifierRunPermutation_ParsesAsAPartialStaticMethodInASharedBlock(modifiers string) {
        // Copilot review round, finding 5 — the same root cause inside
        // `shared { }`, which is the path the motivating static
        // `[GeneratedRegex]` shape actually takes.
        let source = (`package App
partial class A {
    shared {
        ` + "$modifiers" + ` func F() int32 { return 1 }
    }
}
`)
        let diagnostics = ParseDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        let tree = Parse(source)
        let type = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let method = type.SharedBlock!!.Methods.Single()
        Assert.True(method.IsPartial)
        Assert.True(method.IsUnsafe)
        Assert.True(method.IsAsync)
    }

    @Theory
    @MemberData("ModifierRunPermutations")
    func EveryModifierRunPermutation_AtTopLevel_ReportsExactlyOneGS0607(modifiers string) {
        // Copilot review round, finding 6. `partial` is invalid on a top-level
        // `func`, but the recovery promise is ONE diagnostic — the whole
        // modifier run must be consumed so the `func` after it still parses.
        // Previously `async partial unsafe func` diagnosed `partial` and then
        // left `unsafe` behind, cascading.
        let source = (`package App

` + "$modifiers" + ` func F() int32 { return 1 }
`)
        let diagnostics = ParseDiagnostics(source)
        Assert.Equal(1, diagnostics.Count((d Diagnostic) -> d.Id == "GS0607"))
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError && d.Id != "GS0607")
        let tree = Parse(source)
        let function = Assert.Single(tree.Root.Members.OfType[FunctionDeclarationSyntax]())
        Assert.Equal("F", function.Identifier.Text)
    }

    @Theory
    @InlineData("prop P int32 { get { return 1 } }")
    @InlineData("event E Action")
    func AccessibilityBeforeAMisplacedPartial_StillReachesTheGS0607RecoveryPath(member string) {
        // Copilot review round, findings 2 and 4. With `public partial prop …`
        // the accessibility lookahead stopped at `partial`, never matched
        // `prop`, and so left `public` unconsumed — which meant the misplaced-
        // `partial` rejection path never ran and the user got a field-declaration
        // cascade instead of the intended GS0607.
        let diagnostics = ParseDiagnostics((`package App
import System

partial class A {
    public partial ` + "$member" + `
}
`))
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0607")
    }

    @Fact
    func AccessibilityBeforeAMisplacedPartialInASharedBlock_StillReachesTheGS0607RecoveryPath() {
        let diagnostics = ParseDiagnostics(`package App

partial class A {
    shared {
        public partial prop P int32 { get { return 1 } }
    }
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0607")
    }

    @Fact
    func AccessibilityBeforeAMisplacedPartialField_ReportsExactlyOneGS0607AndKeepsTheField() {
        // Copilot review round 9: `var` was not in the accessibility
        // lookahead's member-kind list, so `public` stayed current,
        // ParseFieldDeclaration consumed it, and then read `partial` as the
        // field name — a GS0288 cascade with no GS0607.
        let source = `package App

partial class A {
    public partial var x int32 = 1
}
`
        let diagnostics = ParseDiagnostics(source)
        Assert.Equal(1, diagnostics.Count((d Diagnostic) -> d.Id == "GS0607"))
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError && d.Id != "GS0607")
        let type = Parse(source).Root.Members.OfType[StructDeclarationSyntax]().Single()
        let field = Assert.Single(type.Fields)
        Assert.Equal("x", field.Identifier.Text)
        Assert.NotNull(field.AccessibilityModifier)
    }

    @Fact
    func AccessibilityBeforeAMisplacedPartialFieldInASharedBlock_ReportsExactlyOneGS0607() {
        let source = `package App

partial class A {
    shared {
        public partial var x int32 = 1
    }
}
`
        let diagnostics = ParseDiagnostics(source)
        Assert.Equal(1, diagnostics.Count((d Diagnostic) -> d.Id == "GS0607"))
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError && d.Id != "GS0607")
        let type = Parse(source).Root.Members.OfType[StructDeclarationSyntax]().Single()
        let field = Assert.Single(type.SharedBlock!!.Fields)
        Assert.Equal("x", field.Identifier.Text)
        Assert.NotNull(field.AccessibilityModifier)
    }

    @Fact
    func PartialOnFuncInitConstructor_ReportsGS0607() {
        // Copilot review round 9: the modifier-run consumer takes `partial`
        // because the run ends in `func`, but the `func init(...)` branch
        // never looked at it — the constructor was silently accepted.
        let diagnostics = ParseDiagnostics(`package App

partial class A {
    partial func init() { }
}
`)
        Assert.Equal(1, diagnostics.Count((d Diagnostic) -> d.Id == "GS0607"))
    }

    @Fact
    func AccessibilityBeforeAPartialFuncInASharedBlock_IsConsumedAsAMemberModifier() {
        let tree = Parse(`package App

partial class A {
    shared {
        public partial func F() int32;
    }
}
`)
        let type = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let method = type.SharedBlock!!.Methods.Single()
        Assert.True(method.IsPartial)
        Assert.NotNull(method.AccessibilityModifier)
    }

    @Fact
    func PartialModifier_IsRecognizedInsideASharedBlock() {
        // The motivating scenario is static: C#'s
        // `[GeneratedRegex] private static partial Regex Foo();` translates to a
        // `partial func` inside `shared { }`.
        let tree = Parse(`package App
partial class A {
    shared {
        partial func F() int32;
    }
}
`)
        let type = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        let method = type.SharedBlock!!.Methods.Single()
        Assert.True(method.IsPartial)
        Assert.True(method.HasSemicolonBody)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. `partial` stays an ordinary identifier everywhere else (ADR-0144 §A)
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func PartialAsAVariableName_StillParses() {
        let diagnostics = ParseDiagnostics(`package App
import System

let partial = 1
Console.WriteLine(partial)
`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0607")
    }

    @Fact
    func PartialAsAFunctionName_StillParses() {
        let diagnostics = ParseDiagnostics(`package App

func partial() int32 { return 1 }
`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0607")
    }

    @Fact
    func PartialAsAFieldName_InsideAPartialClass_StillParses() {
        // `partial` here heads neither a `func` nor an aggregate keyword, so the
        // lookahead must decline it and leave it to ParseFieldDeclaration as an
        // ordinary field name.
        let diagnostics = ParseDiagnostics(`package App

partial class A {
    var partial int32 = 1
}
`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0607")
    }

    @Fact
    func PartialClass_StillParsesAsAPartialType_NotAMisplacedMemberModifier() {
        // The nested-type path shares the member loop with `partial func`; the
        // probe must yield to TryDetectAggregateDeclarationHead.
        let diagnostics = ParseDiagnostics(`package App

partial class Outer {
    partial class Inner {
        var x int32 = 1
    }
}
`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0607")
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. GS0607 — every position a partial member cannot occupy
    // ─────────────────────────────────────────────────────────────────────────
    @Fact
    func PartialOnATopLevelFunction_ReportsGS0607() {
        let diagnostics = ParseDiagnostics(`package App

partial func F() int32 { return 1 }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0607")
    }

    @Fact
    func PartialOnATopLevelFunction_StillParsesTheFunction() {
        // Anti-cascade: the `func` after the rejected modifier must still parse
        // as a function declaration, so callers of it bind normally and the user
        // sees exactly one error.
        let tree = Parse(`package App

partial func F() int32 { return 1 }
`)
        let function = Assert.Single(tree.Root.Members.OfType[FunctionDeclarationSyntax]())
        Assert.Equal("F", function.Identifier.Text)
    }

    @Fact
    func PartialOnAnInterfaceMethodSignature_ReportsGS0607() {
        let diagnostics = ParseDiagnostics(`package App

interface I {
    partial func F() int32;
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0607")
    }

    @Fact
    func PartialOnAnInterfaceStaticVirtualSlot_ReportsGS0607() {
        let diagnostics = ParseDiagnostics(`package App

interface I {
    shared {
        partial func F() int32;
    }
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0607")
    }

    @Fact
    func PrivatePartialOnAnInterfaceMethodSignature_ReportsExactlyOneGS0607() {
        // Copilot review round 4: `private` is the one accessibility modifier
        // an interface method signature accepts (ADR-0090). The lookahead
        // that recognizes it required `func` immediately after `private`, so
        // `partial` in between stranded `private` for the "unexpected token"
        // catch-all — doubling up on the intended single GS0607.
        let diagnostics = ParseDiagnostics(`package App

interface I {
    private partial func F() int32;
}
`)
        Assert.Equal(1, diagnostics.Count((d Diagnostic) -> d.Id == "GS0607"))
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError && d.Id != "GS0607")
    }

    @Fact
    func PrivatePartialOnAnInterfaceStaticVirtualSlot_ReportsExactlyOneGS0607() {
        let diagnostics = ParseDiagnostics(`package App

interface I {
    shared {
        private partial func F() int32;
    }
}
`)
        Assert.Equal(1, diagnostics.Count((d Diagnostic) -> d.Id == "GS0607"))
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError && d.Id != "GS0607")
    }

    @Fact
    func PrivatePartialFuncOnAnInterface_IsStillParsedAsAPrivateInterfaceMethod_WhenTheEnclosingTypeIsPartial() {
        // Complement: `partial` on an interface MEMBER is always GS0607
        // regardless of whether the interface TYPE is partial (ADR-0144 keeps
        // `partial interface` legal; only its members cannot be partial). This
        // exercises the same `private`-before-`partial` lookahead when the
        // rejection path still needs to recover into a normal `private func`.
        let diagnostics = ParseDiagnostics(`package App

partial interface I {
    private partial func F() int32;
}
`)
        Assert.Equal(1, diagnostics.Count((d Diagnostic) -> d.Id == "GS0607"))
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError && d.Id != "GS0607")
    }

    @Fact
    func PartialInterfaceType_IsStillLegal_OnlyItsMembersAreNot() {
        // ADR-0144 keeps `partial interface` as a legal TYPE; ADR-0192 scopes
        // out only partial MEMBERS of an interface.
        let diagnostics = ParseDiagnostics(`package App

partial interface I {
    func F() int32;
}
`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0607")
    }

    @Fact
    func PartialOnAProperty_ReportsGS0607() {
        // Partial properties are a real C# 13 feature and a natural future
        // extension (ADR-0192 scope limitations), but they are not implemented:
        // the modifier must be rejected precisely rather than fall through to
        // ParseFieldDeclaration as a stray type-clause token.
        let diagnostics = ParseDiagnostics(`package App

partial class A {
    partial prop P int32 { get { return 1 } }
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0607")
    }

    @Fact
    func PartialOnAnEvent_ReportsGS0607() {
        let diagnostics = ParseDiagnostics(`package App
import System

partial class A {
    partial event E Action
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0607")
    }

    @Fact
    func PartialOnASharedBlockField_ReportsGS0607() {
        let diagnostics = ParseDiagnostics(`package App

partial class A {
    shared {
        partial var x int32 = 1
    }
}
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0607")
    }

    @Fact
    func PartialModifier_BeforeAccessibility_IsRejectedTheSameWayUnsafeAlreadyIs() {
        // Copilot review round 3, finding 1: ADR-0192 §A's "every other func
        // modifier in any order" overclaimed. `partial` only joins the
        // order-independent run with `unsafe` and the colour modifiers;
        // accessibility (and `open`/`override`) must still precede that run,
        // exactly as they already had to before this ADR — `unsafe public
        // func` (no `partial` involved at all) cascades in the same way on
        // unmodified `main`. `partial public func` is not a regression this
        // ADR introduces; it is the pre-existing accessibility-must-lead
        // constraint, unchanged.
        let withoutPartial = ParseDiagnostics(`package App
class A {
    unsafe public func F() int32 { return 1 }
}
`)
        let withPartial = ParseDiagnostics(`package App
partial class A {
    partial public func F() int32 { return 1 }
}
`)
        Assert.Contains(withoutPartial, (d Diagnostic) -> d.Id == "GS0288")
        Assert.Contains(withPartial, (d Diagnostic) -> d.Id == "GS0288")
        Assert.Contains(withPartial, (d Diagnostic) -> d.Id == "GS0607")
    }

    shared {
        /// Gets all six orderings of the `partial` / colour / `unsafe`
        /// modifier run. ADR-0192 §A advertises every one as legal, so every one is
        /// tested at every call site rather than the two or three a review happened
        /// to name.
        /// @returns The permutation data.
        func ModifierRunPermutations() sequence[[]object] {
            yield[]object{"partial async unsafe"}
            yield[]object{"partial unsafe async"}
            yield[]object{"async partial unsafe"}
            yield[]object{"async unsafe partial"}
            yield[]object{"unsafe partial async"}
            yield[]object{"unsafe async partial"}
        }

        private func Parse(source string) SyntaxTree -> SyntaxTree.Parse(SourceText.From(source, "Test.gs"))

        private func ParseDiagnostics(source string) IReadOnlyList[Diagnostic] -> Parse(source).Diagnostics.ToArray()

        private func SingleMethod(source string) FunctionDeclarationSyntax {
            let tree = Parse(source)
            let type = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
            return type.Methods.Single()
        }
    }
}
