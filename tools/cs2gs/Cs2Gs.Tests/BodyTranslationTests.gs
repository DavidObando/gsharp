// <copyright file="BodyTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Step-7 body-translation tests (issue #914, ADR-0115 §B): the recursive
/// statement / expression translator turns C# method/property/constructor bodies
/// into the (cref:Cs2Gs.CodeModel) G# AST. The end-to-end test fully
/// translates the real L1-Console corpus and asserts a clean round-trip with no
/// pending placeholders; the targeted tests cover each construct family.
open class BodyTranslationTests {
    /// The real `L1-Console/Program.cs` translates to complete G# — every
    /// body translated, no `// pending` placeholder, no `body-pending`
    /// diagnostic — and the printed text round-trip-parses. After the T1–T3
    /// canonicalization there are no (cref:TranslationSeverity.Unsupported)
    /// records: the former named-tuple gap now maps to a native positional tuple.
    @Fact
    async func L1Corpus_FullyTranslatesAndRoundTrips() {
        let (unit, context) = await TranslateL1CorpusAsync()
        let printed = GSharpPrinter.Print(unit)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(
            result!!.Success,
            "Translated L1 must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
        )
        Assert.DoesNotContain("// pending", printed)
        Assert.DoesNotContain("// unsupported", printed)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.ConstructKind == "body-pending")
        // T1–T3 leave no Unsupported diagnostic: tuples, immutable fields, and the
        // entry point all have canonical G# forms now.
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// The real `L4-Console/Program.cs` — which exercises exception handling
    /// (custom exception + base chaining, typed catch, finally, re-throw),
    /// Dictionary/HashSet, `using`/`IDisposable`, nullable value types,
    /// and operator overloading — translates to complete canonical G# with no
    /// pending placeholder, no (cref:TranslationSeverity.Unsupported)
    /// record, and the printed text round-trip-parses (ADR-0115 §B).
    @Fact
    async func L4Corpus_FullyTranslatesAndRoundTrips() {
        let (unit, context) = await TranslateConsoleCorpusAsync("L4-Console", "L4-Console.csproj")
        let printed = GSharpPrinter.Print(unit)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(
            result!!.Success,
            "Translated L4 must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
        )
        Assert.DoesNotContain("// pending", printed)
        Assert.DoesNotContain("// unsupported", printed)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.ConstructKind == "body-pending")
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        // The new construct families each surface in the canonical output.
        Assert.Contains("init(sku string, message string) : base(message) {", printed)
        Assert.Contains("func (a Money) operator +(b Money) Money {", printed)
        Assert.Contains("using let log = AuditLog(\"ledger\")", printed)
        Assert.Contains("} catch (ex InsufficientStockException) {", printed)
        Assert.Contains("} finally {", printed)
        Assert.Contains("rethrow", printed)
        Assert.Contains("let available = if _stock.TryGetValue(sku, out qty) {", printed)
        Assert.Contains("threshold ?? 0", printed)
    }

    /// if / else-if / else chains map to nested (cref:IfStatement)
    /// nodes (else-if is an (cref:IfStatement) else branch).
    @Fact
    func IfElseIfElse_TranslatesToNestedIf() {
        let body = GetMethodBody(`
            if (n == 0) { label = "zero"; }
            else if (n == 1) { label = "one"; }
            else { label = "many"; }`, extraLocals: "string label = \"\";")
        Assert.Contains("if n == 0 {", body)
        Assert.Contains("} else if n == 1 {", body)
        Assert.Contains("} else {", body)
    }

    /// C# `while (cond)` maps to the canonical G# `while` form
    /// (spec §For loops and while-style loops).
    @Fact
    func While_TranslatesToWhile() {
        let body = GetMethodBody("while (n < 3) { n++; }")
        Assert.Contains("while n < 3 {", body)
        Assert.Contains("n++", body)
    }

    /// C# C-style `for` maps to the G# three-clause
    /// `for init; cond; incr { }`.
    @Fact
    func CStyleFor_TranslatesToThreeClauseFor() {
        let body = GetMethodBody("for (int i = 1; i <= 3; i++) { n = n + i; }")
        Assert.Contains("for var i = 1; i <= 3; i++ {", body)
    }

    /// C# statement-level discard `_ = expr;` has no G# assignment
    /// target. Effectful RHS values use G#'s native discard declaration.
    @Fact
    func DiscardAssignment_UsesNativeDiscardDeclaration() {
        let body = GetMethodBody("_ = n.ToString();")
        Assert.Contains("let _ = n.ToString()", body)
    }

    /// A C-style `for` with multiple declarators/initializers or
    /// multiple incrementors cannot fit G#'s single-init, single-incrementor
    /// `for`, so it lowers to a block + `while` running every init once up
    /// front and every incrementor at the end of each iteration (issue #914).
    @Fact
    func MultiInitMultiIncrementorFor_LowersToBlockWhile() {
        let body = GetMethodBody("for (int f = 0, start = 0; f < 3; start += f, f++) { n = n + start; }")
        Assert.Contains("var f = 0", body)
        Assert.Contains("var start = 0", body)
        Assert.Contains("while f < 3 {", body)
        Assert.Contains("start += f", body)
        Assert.Contains("f++", body)
        Assert.DoesNotContain("for ", body)
    }

    /// C# `foreach (var x in xs)` maps to the G# `for x in xs`
    /// ((cref:ForInStatement)).
    @Fact
    func Foreach_TranslatesToForIn() {
        let body = GetMethodBody(
            "foreach (var item in items) { n = n + item; }",
            extraLocals: "var items = new System.Collections.Generic.List<int>();"
        )
        Assert.Contains("for item in items {", body)
    }

    /// A C# conditional (ternary) expression maps to the canonical G#
    /// value-producing `if cond { a } else { b }` if-expression (sample
    /// `IfExpression.gs`, ADR-0064).
    @Fact
    func Ternary_TranslatesToIfExpression() {
        let body = GetMethodBody("var label = n > 0 ? 1 : 2;")
        Assert.Contains("let label = if n > 0 { 1 } else { 2 }", body)
    }

    /// C# `try`/`catch (T e)`/`finally` maps to the
    /// canonical G# `try { } catch (e T) { } finally { }` (sample
    /// `Exceptions.gs`).
    @Fact
    func TryCatchFinally_TranslatesToTry() {
        let body = GetMethodBody(`
            try { n = 1; }
            catch (Exception ex) { n = ex.Message.Length; }
            finally { n = 3; }`)
        Assert.Contains("try {", body)
        Assert.Contains("} catch (ex Exception) {", body)
        Assert.Contains("} finally {", body)
    }

    /// ADR-0176 / issue #3897: a C# explicit re-throw `throw;`
    /// maps to G# `rethrow`, which emits `ILOpCode.Rethrow` and keeps
    /// the original throw site. It previously lowered to `throw ex`, the
    /// same exception object with its `StackTrace` reset.
    @Fact
    func Rethrow_TranslatesToRethrowStatement() {
        let body = GetMethodBody(`
            try { n = 1; }
            catch (Exception ex) { n = ex.Message.Length; throw; }`)
        Assert.Contains("} catch (ex Exception) {", body)
        Assert.Contains("rethrow", body)
    }

    /// ADR-0177 gave G# a native `catch ... when`, so a C# filter
    /// maps straight across as one clause instead of being lowered into the
    /// handler body with a rethrow-if-false prologue (the #1724 workaround).
    /// That is not cosmetic: the lowering ran the filter <em>after</em> the
    /// stack had already unwound into the handler, while a native filter runs
    /// in the CLR's first pass.
    @Fact
    func CatchWhen_TranslatesToNativeWhenFilter() {
        let body = GetMethodBody(`
            try { n = 1; }
            catch (Exception ex) when (ex.Message.Length > 0) { n = 2; }`)
        Assert.Contains("} catch (ex Exception) when ex.Message.Length > 0 {", body)
        Assert.DoesNotContain("rethrow", body)
        Assert.DoesNotContain("__caught", body)
    }

    /// A false filter needs no lowering at all now: the CLR simply
    /// never selects the clause, so the exception keeps propagating with its
    /// original throw site intact and the handler body is not entered
    /// (issue #1724, resolved natively by ADR-0177).
    @Fact
    func CatchWhen_FilterFalse_NeedsNoRethrowLowering() {
        let body = GetMethodBody(`
            try { n = 1; }
            catch (Exception ex) when (false) { n = 999; }`)
        Assert.Contains("when false {", body)
        Assert.DoesNotContain("if !false", body)
        Assert.DoesNotContain("rethrow", body)
    }

    /// The catch binder is in scope inside the filter expression, so a
    /// filter that reads it translates verbatim (issue #1724).
    @Fact
    func CatchWhen_FilterReferencesExceptionVariable() {
        let body = GetMethodBody(`
            try { n = 1; }
            catch (InvalidOperationException ex) when (ex.Message == "retry") { n = 2; }`, extraLocals: "")
        Assert.Contains("catch (ex InvalidOperationException) when ex.Message == \"retry\" {", body)
        Assert.DoesNotContain("rethrow", body)
    }

    /// The shape #2235 had to merge into one hand-written dispatcher —
    /// a filtered clause whose later sibling could still receive the same
    /// exception — now emits two ordinary clauses. C#'s "false filter falls
    /// through to the next sibling" is the CLR's rule, so there is nothing left
    /// to reproduce, and no synthetic `__caught` binder is invented
    /// (issue #3897 family 1).
    @Fact
    func FilteredCatch_WithOverlappingLaterSibling_EmitsClauseForClause() {
        let (body, context) = GetMethodBodyAndContext(`
            try { n = 1; }
            catch (InvalidOperationException ex) when (ex.Message.Length > 0) { n = 2; }
            catch (Exception ex2) { n = 3; }`)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("catch (ex InvalidOperationException) when ex.Message.Length > 0 {", body)
        Assert.Contains("catch (ex2 Exception) {", body)
        Assert.DoesNotContain("__caught", body)
        Assert.DoesNotContain(" is InvalidOperationException", body)
        Assert.Contains("n = 2", body)
        Assert.Contains("n = 3", body)
    }

    /// Same shape, framed around the runtime behavior it protects: the
    /// sibling clause must stay reachable when the filter is false. Keeping both
    /// clauses is exactly what makes it reachable — the earlier lowering's
    /// escaping rethrow was what turned it into dead code (issue #2235).
    @Fact
    func FilteredCatch_WithOverlappingLaterSibling_SiblingRemainsReachableNotDeadCode() {
        let (body, context) = GetMethodBodyAndContext(`
            try { n = 1; }
            catch (InvalidOperationException ex) when (false) { n = 2; }
            catch (Exception ex2) { n = 3; }`)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("catch (ex2 Exception) {", body)
        Assert.Contains("n = 3", body)
        Assert.DoesNotContain("rethrow", body)
    }

    /// A filtered catch that is the LAST clause translates the same way
    /// as any other — the old lowering's "is this shape safe?" question no
    /// longer exists, so there is one code path and no diagnostic
    /// (issues #1724, #2235).
    @Fact
    func FilteredCatch_Last_EmitsNativeFilter_NoDiagnostic() {
        let (body, context) = GetMethodBodyAndContext(`
            try { n = 1; }
            catch (ArgumentNullException ex0) { n = 9; }
            catch (InvalidOperationException ex) when (ex.Message.Length > 0) { n = 2; }`)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("catch (ex InvalidOperationException) when ex.Message.Length > 0 {", body)
        Assert.DoesNotContain("rethrow", body)
    }

    /// Sibling types being provably disjoint used to be the precondition
    /// that made rethrow-lowering safe; it is now irrelevant, and the clause
    /// translates identically either way (issue #1724).
    @Fact
    func FilteredCatch_WithDisjointLaterSibling_EmitsNativeFilter_NoDiagnostic() {
        let (body, context) = GetMethodBodyAndContext(`
            try { n = 1; }
            catch (InvalidOperationException ex) when (ex.Message.Length > 0) { n = 2; }
            catch (FormatException ex2) { n = 3; }`)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("catch (ex InvalidOperationException) when ex.Message.Length > 0 {", body)
        Assert.Contains("catch (ex2 FormatException) {", body)
        Assert.DoesNotContain("rethrow", body)
    }

    /// A pre-declared C# `out` argument maps to the legacy
    /// pass-by-address form `&x`; the uninitialised local binds as a
    /// mutable `var x T` (BCL methods reject inline `out var`, so the
    /// pre-declared form is canonical here).
    @Fact
    func PreDeclaredOutArgument_TranslatesToAddressOf() {
        let body = GetMethodBody(`int v;
              d.TryGetValue("a", out v);
              n = v;`, extraLocals: "var d = new System.Collections.Generic.Dictionary<string,int>();")
        Assert.Contains("var v int32", body)
        Assert.Contains("d.TryGetValue(\"a\", out v)", body)
    }

    /// A C# `using` statement maps to a scoped block whose resource
    /// binds as `using let r = ...` (sample `Defer.gs`); a C# 8
    /// `using var` declaration binds the same way at statement scope.
    @Fact
    func UsingStatement_TranslatesToUsingLet() {
        let body = GetMethodBody(`using (var r = new System.IO.MemoryStream()) { n = (int)r.Length; }
              using var s = new System.IO.MemoryStream();
              n = (int)s.Length;`)
        Assert.Contains("using let r = MemoryStream()", body)
        Assert.Contains("using let s = MemoryStream()", body)
    }

    /// A C# null-coalescing operator `??` is preserved (issue #941,
    /// sample `NullCoalescingAssignment.gs`).
    @Fact
    func NullCoalescing_IsPreserved() {
        let body = GetMethodBody("int? maybe = null;\n              n = maybe ?? 0;")
        Assert.Contains("maybe ?? 0", body)
    }

    /// Compound assignment `total += x` is preserved (G# supports
    /// `+=` on numerics, spec §Statements).
    @Fact
    func CompoundAssignment_IsPreserved() {
        let body = GetMethodBody("n += 5;")
        Assert.Contains("n += 5", body)
    }

    /// Increment / decrement statements are preserved.
    @Fact
    func IncrementDecrement_IsPreserved() {
        let body = GetMethodBody("n++; n--;")
        Assert.Contains("n++", body)
        Assert.Contains("n--", body)
    }

    /// Static and instance method calls map to G# invocations / member
    /// access calls.
    @Fact
    func MethodInvocation_TranslatesCalls() {
        let body = GetMethodBody(`
            System.Console.WriteLine(n);
            var s = n.ToString();`)
        Assert.Contains("import System", body)
        Assert.Contains("Console.WriteLine(n)", body)
        Assert.Contains("n.ToString()", body)
    }

    /// C# `new T(args)` maps to the G# construction call
    /// `T(args)`; a generic `new T<U>()` carries bracket type
    /// arguments `T[U]()`.
    @Fact
    func ObjectCreation_TranslatesToConstructionCall() {
        let plain = GetMethodBody("var b = new System.Text.StringBuilder();")
        Assert.Contains("StringBuilder()", plain)
        let generic = GetMethodBody("var xs = new System.Collections.Generic.List<int>();")
        Assert.Contains("List[int32]()", generic)
    }

    /// Member / property access maps to (cref:MemberAccessExpression).
    @Fact
    func MemberAccess_TranslatesDotChain() {
        let body = GetMethodBody(
            "var c = items.Count;",
            extraLocals: "var items = new System.Collections.Generic.List<int>();"
        )
        Assert.Contains("items.Count", body)
    }

    /// Binary and unary operators map straightforwardly, preserving
    /// explicit parentheses.
    @Fact
    func BinaryAndUnary_TranslateOperators() {
        let body = GetMethodBody("n = (n * 3 + 1) % 2; var neg = -n;")
        Assert.Contains("(n * 3 + 1) % 2", body)
        Assert.Contains("-n", body)
    }

    /// String interpolation maps holes to `$ident` / `${expr}`
    /// and escapes a literal `$` to `$$` (ADR-0115 §B.9).
    @Fact
    func StringInterpolation_TranslatesHolesAndDollarEscape() {
        let body = GetMethodBody("var s = $$\"{n} items at $${n} each\";")
        // `{n}` is a bare identifier hole -> `$n`; the literal `$` -> `$$`.
        Assert.Contains("\"$$n items at $$$$$$n each\"", body)
    }

    /// An identifier hole immediately followed by literal text that begins
    /// with an identifier-continuation character (letter/digit/underscore) must use
    /// the braced `${ident}` form so the trailing characters are not absorbed
    /// into the interpolated variable name (regression: `$"{thrdid}_{ticks}"`).
    @Fact
    func StringInterpolation_BracesHoleWhenFollowedByIdentifierChar() {
        let body = GetMethodBody("var s = $$\"{n}_more{n}x{n}.{n} end{n}\";", extraLocals: "var more = 0; var x = 0;")
        // `_`, `x`, follow the hole -> braced; `.`, ` `, and end-of-string do not -> shorthand.
        Assert.Contains("\"$${n}_more$${n}x$$n.$$n end$$n\"", body)
    }

    /// local `var` never reassigned becomes `let`; a reassigned
    /// local becomes `var`; `const` stays `const` (ADR-0115 §B.3,
    /// data-flow driven).
    @Fact
    func LocalBindings_LetVarConst() {
        let body = GetMethodBody(`
            const int k = 8;
            var fixedLocal = 1;
            var movingLocal = 2;
            movingLocal = movingLocal + 1;
            n = fixedLocal + movingLocal + k;`)
        Assert.Contains("const k = 8", body)
        Assert.Contains("let fixedLocal = 1", body)
        Assert.Contains("var movingLocal = 2", body)
    }

    /// A local declared without an initializer keeps its type clause so
    /// the binding names a zero/default value (spec §Bindings).
    @Fact
    func LocalWithoutInitializer_KeepsTypeClause() {
        let body = GetMethodBody(`
            string label;
            label = "x";
            n = label.Length;`)
        Assert.Contains("var label string", body)
    }

    /// A tuple-construction argument translates to a G# tuple literal so
    /// the syntax round-trips even though the named-tuple type itself is an
    /// unsupported step-6 gap.
    @Fact
    func TupleArgument_TranslatesToTupleLiteral() {
        let body = GetMethodBody(
            "sink.Add((1, 2, 3));",
            extraLocals: "var sink = new System.Collections.Generic.List<(int, int, int)>();"
        )
        Assert.Contains("sink.Add((1, 2, 3))", body)
    }

    shared {
        private async func TranslateL1CorpusAsync()(Unit CompilationUnit, Context TranslationContext) {
            return await TranslateConsoleCorpusAsync("L1-Console", "L1-Console.csproj")
        }

        private async func TranslateConsoleCorpusAsync(projectFolder string, projectFile string)(
            Unit CompilationUnit,
            Context TranslationContext
        ) {
            let projectPath string? = ResolveCorpusProject(projectFolder, projectFile)
            let project = await CSharpProjectLoader.LoadProjectAsync(projectPath)
            Assert.True(
                project.BoundWithoutErrors,
                "$projectFolder should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = project.Documents.Single(
                (d LoadedDocument) -> d.FilePath.EndsWith("Program.cs", StringComparison.Ordinal)
            )
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (unit, context)
        }

        private func ResolveCorpusProject(
            projectFolder string,
            projectFile string
        ) string? -> TestFixtureSource.Resolve("tools", "cs2gs", "corpus", projectFolder, projectFile)

        /// Translates a small C# statement snippet (wrapped in a method with an
        /// always-present mutable `int n` local) and returns the printed,
        /// round-trip-validated G# text of the whole compilation unit.
        /// @param statements The C# statements to place in the method body.
        /// @param extraLocals Optional extra C# locals to declare first.
        /// @returns The printed G#.
        private func GetMethodBody(statements string, extraLocals string = "") string -> GetMethodBodyAndContext(
            statements,
            extraLocals
        ).Printed

        /// Same as (cref:GetMethodBody), but also returns the
        /// (cref:TranslationContext) so callers can assert on recorded
        /// (cref:TranslationDiagnostic)s (e.g. the sibling-catch-overlap
        /// diagnostic added for issue #1724's follow-up).
        private func GetMethodBodyAndContext(statements string, extraLocals string = "")(
            Printed string,
            Context TranslationContext
        ) {
            let source = (`
using System;
namespace S
{
    public class C
    {
        public void M()
        {
            var n = 0;
            ` + "$extraLocals" + `
            ` + "$statements" + `
            Use(n);
        }

        private static void Use(int x) { }
    }
}
`)
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Snippet G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return (printed, context)
        }
    }
}
