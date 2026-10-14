// <copyright file="Issue3359IfLetStatementTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issue #3359: `if (receiver is { } name) { … }` must not spill the
/// scrutinee.
///
/// The general pattern lowering must spill a non-trivial scrutinee into a
/// `let __spillN`, because the pattern reads it more than once (issue
/// #1731). That costs three things at once: the author's chosen binder name is
/// replaced by `__spillN`, every read becomes `__spillN!!`, and the
/// statement gains a brace level to scope the temp. Issue #3359 first answered
/// that with the canonical G# `if let` statement (ADR-0071), which binds
/// the name at its non-null type and evaluates the receiver once by
/// construction.
///
/// ADR-0166 / issue #3409: G# now has native pattern variables, so the same
/// C# is emitted verbatim — `if receiver is { } name { … }`, with any
/// `&&` guard kept in the header, `is not` lowered to
/// `!(… is { } name)`, and the variable leaking past an exiting branch.
/// The tests below assert that form. The `if let` statement remains valid
/// G# and stays the translation fallback for shapes the native path declines
/// (a `var` designation, a reassigned binder, a binder read outside a
/// region G# scopes it to); the printer keeps its code-model sample in
/// `Coverage/GNodeSamples.cs`, and the value-position form keeps its
/// goldens in `Adr0151IfLetExpressionTranslationTests`.
///
/// Measured at ~44 occurrences per 100k lines in dotnet/roslyn and ~186 per 100k
/// in this repository — the largest single slice of spill site <b>S1</b>
/// (issue #3347).
open class Issue3359IfLetStatementTranslationTests {
    // ADR-0166 / issue #3409: the bare non-null pattern is emitted verbatim as
    // a native G# pattern variable.
    @Fact
    func BareNonNullPattern_TranslatesVerbatim_WithNoSpill() {
        let printed = Translate(NodeType + `
public sealed class C
{
    public void M(Node node)
    {
        if (node.StartTag is { } startTag) { System.Console.WriteLine(startTag.X); }
    }
}`)
        Assert.Contains("if node.StartTag is { } startTag {", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        // The three costs the spill imposed, all gone.
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        Assert.Contains("startTag.X", printed, StringComparison.Ordinal)
    }

    // ADR-0166 / issue #3409: the else branch rides on the native `if`
    // unchanged; the pattern variable is simply out of scope there.
    @Fact
    func WithElseBranch_TranslatesVerbatimWithElse() {
        let printed = Translate(NodeType + `
public sealed class C
{
    public void M(Node node)
    {
        if (node.StartTag is { } tag) { System.Console.WriteLine(tag.X); }
        else { System.Console.WriteLine(-1); }
    }
}`)
        Assert.Contains("if node.StartTag is { } tag {", printed, StringComparison.Ordinal)
        Assert.Contains("} else {", printed, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine(-1)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    /// ADR-0166 / issue #3409: a native pattern variable is in scope in the
    /// right operand of `&&`, so the conjoined guard stays in the
    /// `if` header exactly as the author wrote it. (The ADR-0071 `if let`
    /// STATEMENT grammar has no `&& guard` clause, which is why the
    /// earlier lowering had to nest the guard inside the then-branch.)
    @Fact
    func ConjoinedGuard_StaysInTheHeader() {
        let printed = Translate(NodeType + `
public sealed class C
{
    public void M(Node node)
    {
        if (node.StartTag is { } tag && tag.X > 0) { System.Console.WriteLine(tag.X); }
    }
}`)
        Assert.Contains("if node.StartTag is { } tag && tag.X > 0 {", printed, StringComparison.Ordinal)
        // No nested re-test of the guard, no `if let`, no spill.
        Assert.DoesNotContain("if tag.X > 0", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    /// ADR-0166 / issue #3409: with the guard in the header, a single
    /// `else` covers both binding failure and guard failure — the else
    /// branch is no longer duplicated into the bound path.
    @Fact
    func ConjoinedGuardWithElse_KeepsASingleElse() {
        let printed = Translate(NodeType + `
public sealed class C
{
    public void M(Node node)
    {
        if (node.StartTag is { } tag && tag.X > 0) { System.Console.WriteLine(tag.X); }
        else { System.Console.WriteLine(-1); }
    }
}`)
        Assert.Contains("if node.StartTag is { } tag && tag.X > 0 {", printed, StringComparison.Ordinal)
        Assert.Contains("} else {", printed, StringComparison.Ordinal)
        Assert.Equal(1, printed.Split("Console.WriteLine(-1)").Length - 1)
        Assert.DoesNotContain("if tag.X > 0", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    /// A binder READ after an exiting then-branch is legal in C#. ADR-0166 /
    /// issue #3409: G# scopes the variable of `!(x is { } t)` to the
    /// statements after an `if` whose then-branch always exits, so the
    /// negated pattern lowers to `… is not { } tag` and the variable leaks
    /// — no hoisted nullable local, no `== nil` guard.
    @Fact
    func NegatedEarlyExit_UsesNativeNotAndLeaksTheVariable() {
        let printed = Translate(NodeType + `
public sealed class C
{
    public void M(Node node)
    {
        if (node.StartTag is not { } tag) { return; }
        System.Console.WriteLine(tag.X);
    }
}`)
        Assert.Contains("if node.StartTag is not { } tag {", printed, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine(tag", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("== nil", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    /// A trivial scrutinee never spilled in the first place, but the native
    /// pattern variable is still the better rendering — it keeps the binder
    /// name instead of reusing the receiver with a `!!` at each read.
    @Fact
    func TrivialScrutinee_AlsoTranslatesVerbatim() {
        let printed = Translate(`
#nullable enable
public sealed class C
{
    public void M(string? s)
    {
        if (s is { } text) { System.Console.WriteLine(text.Length); }
    }
}`)
        // ADR-0166 / issue #3409: native pattern variable, not `if let text = s`.
        Assert.Contains("if s is { } text {", printed, StringComparison.Ordinal)
        Assert.Contains("text.Length", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
    }

    /// A type-test pattern (`is T t`) used to keep the positive-guard `as`
    /// hoist. ADR-0166 / issue #3409: it is a native declaration pattern now,
    /// emitted verbatim with no `as` cast.
    @Fact
    func TypeTestPattern_TranslatesVerbatim() {
        let printed = Translate(`
public sealed class C
{
    public void M(object o)
    {
        if (o is string s) { System.Console.WriteLine(s.Length); }
    }
}`)
        Assert.Contains("if o is string s {", printed, StringComparison.Ordinal)
        Assert.Contains("s.Length", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("as string", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    /// ADR-0071 requires a NULLABLE initializer — the binding exists to strip the
    /// nullability, and a non-nullable one is GS0296 — so this shape used to take
    /// a scoped binding with the author's name. ADR-0166 / issue #3409: the
    /// native `{ }` pattern is a plain non-nil test accepted over any input
    /// type, so C#'s runtime null test on a non-nullable reference translates
    /// verbatim.
    @Fact
    func NonNullableScrutinee_TranslatesVerbatim() {
        let printed = Translate(`
public sealed class C
{
    public int G(string s)
    {
        if (s is { } text) { return text.Length; }
        return -1;
    }
}`)
        Assert.Contains("if s is { } text {", printed, StringComparison.Ordinal)
        Assert.Contains("return text.Length", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let text = s", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("!= nil", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    shared {
        private const NodeType string = `
public sealed class Node
{
    public Node? StartTag;
    public int X;
}
`

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `#nullable enable
using System;

namespace Demo
{
` + source + `
}
`)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                roundTrip!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
