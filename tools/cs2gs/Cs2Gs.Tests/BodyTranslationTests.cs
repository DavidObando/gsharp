// <copyright file="BodyTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Step-7 body-translation tests (issue #914, ADR-0115 §B): the recursive
/// statement / expression translator turns C# method/property/constructor bodies
/// into the <see cref="Cs2Gs.CodeModel"/> G# AST. The end-to-end test fully
/// translates the real L1-Console corpus and asserts a clean round-trip with no
/// pending placeholders; the targeted tests cover each construct family.
/// </summary>
public class BodyTranslationTests
{
    /// <summary>
    /// The real <c>L1-Console/Program.cs</c> translates to complete G# — every
    /// body translated, no <c>// pending</c> placeholder, no <c>body-pending</c>
    /// diagnostic — and the printed text round-trip-parses. After the T1–T3
    /// canonicalization there are no <see cref="TranslationSeverity.Unsupported"/>
    /// records: the former named-tuple gap now maps to a native positional tuple.
    /// </summary>
    [Fact]
    public async Task L1Corpus_FullyTranslatesAndRoundTrips()
    {
        (CompilationUnit unit, TranslationContext context) = await TranslateL1CorpusAsync();
        string printed = GSharpPrinter.Print(unit);

        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated L1 must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);

        Assert.DoesNotContain("// pending", printed);
        Assert.DoesNotContain("// unsupported", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.ConstructKind == "body-pending");

        // T1–T3 leave no Unsupported diagnostic: tuples, immutable fields, and the
        // entry point all have canonical G# forms now.
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// The real <c>L4-Console/Program.cs</c> — which exercises exception handling
    /// (custom exception + base chaining, typed catch, finally, re-throw),
    /// Dictionary/HashSet, <c>using</c>/<c>IDisposable</c>, nullable value types,
    /// and operator overloading — translates to complete canonical G# with no
    /// pending placeholder, no <see cref="TranslationSeverity.Unsupported"/>
    /// record, and the printed text round-trip-parses (ADR-0115 §B).
    /// </summary>
    [Fact]
    public async Task L4Corpus_FullyTranslatesAndRoundTrips()
    {
        (CompilationUnit unit, TranslationContext context) = await TranslateConsoleCorpusAsync("L4-Console", "L4-Console.csproj");
        string printed = GSharpPrinter.Print(unit);

        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated L4 must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);

        Assert.DoesNotContain("// pending", printed);
        Assert.DoesNotContain("// unsupported", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.ConstructKind == "body-pending");
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);

        // The new construct families each surface in the canonical output.
        Assert.Contains("init(sku string, message string) : base(message) {", printed);
        Assert.Contains("func (a Money) operator +(b Money) Money {", printed);
        Assert.Contains("using let log = AuditLog(\"ledger\")", printed);
        Assert.Contains("} catch (ex InsufficientStockException) {", printed);
        Assert.Contains("} finally {", printed);
        Assert.Contains("throw ex", printed);
        Assert.Contains("let available = if _stock.TryGetValue(sku, &qty) {", printed);
        Assert.Contains("threshold ?? 0", printed);
    }

    /// <summary>if / else-if / else chains map to nested <see cref="IfStatement"/>
    /// nodes (else-if is an <see cref="IfStatement"/> else branch).</summary>
    [Fact]
    public void IfElseIfElse_TranslatesToNestedIf()
    {
        string body = GetMethodBody(@"
            if (n == 0) { label = ""zero""; }
            else if (n == 1) { label = ""one""; }
            else { label = ""many""; }",
            extraLocals: "string label = \"\";");

        Assert.Contains("if n == 0 {", body);
        Assert.Contains("} else if n == 1 {", body);
        Assert.Contains("} else {", body);
    }

    /// <summary>C# <c>while (cond)</c> maps to the canonical G# <c>while</c> form
    /// (spec §For loops and while-style loops).</summary>
    [Fact]
    public void While_TranslatesToWhile()
    {
        string body = GetMethodBody("while (n < 3) { n++; }");
        Assert.Contains("while n < 3 {", body);
        Assert.Contains("n++", body);
    }

    /// <summary>C# C-style <c>for</c> maps to the G# three-clause
    /// <c>for init; cond; incr { }</c>.</summary>
    [Fact]
    public void CStyleFor_TranslatesToThreeClauseFor()
    {
        string body = GetMethodBody("for (int i = 1; i <= 3; i++) { n = n + i; }");
        Assert.Contains("for var i = 1; i <= 3; i++ {", body);
    }

    /// <summary>C# statement-level discard <c>_ = expr;</c> has no G# discard target
    /// (<c>_ = e</c> → GS0125), so it lowers to a bare expression statement of the
    /// RHS (issue #914).</summary>
    [Fact]
    public void DiscardAssignment_EmitsBareRightHandSide()
    {
        string body = GetMethodBody("_ = n.ToString();");
        Assert.Contains("n.ToString()", body);
        Assert.DoesNotContain("_ =", body);
    }

    /// <summary>A C-style <c>for</c> with multiple declarators/initializers or
    /// multiple incrementors cannot fit G#'s single-init, single-incrementor
    /// <c>for</c>, so it lowers to a block + <c>while</c> running every init once up
    /// front and every incrementor at the end of each iteration (issue #914).</summary>
    [Fact]
    public void MultiInitMultiIncrementorFor_LowersToBlockWhile()
    {
        string body = GetMethodBody(
            "for (int f = 0, start = 0; f < 3; start += f, f++) { n = n + start; }");

        Assert.Contains("var f = 0", body);
        Assert.Contains("var start = 0", body);
        Assert.Contains("while f < 3 {", body);
        Assert.Contains("start += f", body);
        Assert.Contains("f++", body);
        Assert.DoesNotContain("for ", body);
    }

    /// <summary>C# <c>foreach (var x in xs)</c> maps to the G# <c>for x in xs</c>
    /// (<see cref="ForInStatement"/>).</summary>
    [Fact]
    public void Foreach_TranslatesToForIn()
    {
        string body = GetMethodBody(
            "foreach (var item in items) { n = n + item; }",
            extraLocals: "var items = new System.Collections.Generic.List<int>();");
        Assert.Contains("for item in items {", body);
    }

    /// <summary>A C# conditional (ternary) expression maps to the canonical G#
    /// value-producing <c>if cond { a } else { b }</c> if-expression (sample
    /// <c>IfExpression.gs</c>, ADR-0064).</summary>
    [Fact]
    public void Ternary_TranslatesToIfExpression()
    {
        string body = GetMethodBody("var label = n > 0 ? 1 : 2;");
        Assert.Contains("let label = if n > 0 { 1 } else { 2 }", body);
    }

    /// <summary>C# <c>try</c>/<c>catch (T e)</c>/<c>finally</c> maps to the
    /// canonical G# <c>try { } catch (e T) { } finally { }</c> (sample
    /// <c>Exceptions.gs</c>).</summary>
    [Fact]
    public void TryCatchFinally_TranslatesToTry()
    {
        string body = GetMethodBody(@"
            try { n = 1; }
            catch (Exception ex) { n = ex.Message.Length; }
            finally { n = 3; }");
        Assert.Contains("try {", body);
        Assert.Contains("} catch (ex Exception) {", body);
        Assert.Contains("} finally {", body);
    }

    /// <summary>A C# explicit re-throw <c>throw;</c> in a named catch maps to
    /// re-throwing the caught binder (<c>throw ex</c>); G# has no bare
    /// <c>throw</c> form.</summary>
    [Fact]
    public void Rethrow_TranslatesToThrowCaughtVariable()
    {
        string body = GetMethodBody(@"
            try { n = 1; }
            catch (Exception ex) { n = ex.Message.Length; throw; }");
        Assert.Contains("} catch (ex Exception) {", body);
        Assert.Contains("throw ex", body);
    }

    /// <summary>G# has no native <c>catch ... when (filter)</c>; a filtered catch
    /// must lower to a rethrow-if-false prologue so the filter is not silently
    /// dropped (issue #1724): the caught exception must still propagate when the
    /// filter is false.</summary>
    [Fact]
    public void CatchWhen_LowersToRethrowIfFilterFalse()
    {
        string body = GetMethodBody(@"
            try { n = 1; }
            catch (Exception ex) when (ex.Message.Length > 0) { n = 2; }");

        Assert.Contains("} catch (ex Exception) {", body);
        int catchIndex = body.IndexOf("} catch (ex Exception) {", StringComparison.Ordinal);
        int ifIndex = body.IndexOf("if !(ex.Message.Length > 0) {", StringComparison.Ordinal);
        int rethrowIndex = body.IndexOf("throw ex", StringComparison.Ordinal);
        int assignIndex = body.IndexOf("n = 2", StringComparison.Ordinal);

        Assert.True(ifIndex > catchIndex, "filter check must be inside the catch body.");
        Assert.True(rethrowIndex > ifIndex, "rethrow must be inside the filter's if-branch.");
        Assert.True(assignIndex > rethrowIndex, "original catch body must run after the filter check.");
    }

    /// <summary>The filter's rethrow-lowering must not swallow the exception at
    /// runtime: when the filter is false, the translated G# actually propagates
    /// the exception out of the whole <c>try</c> instead of continuing to the
    /// original catch body (issue #1724).</summary>
    [Fact]
    public void CatchWhen_FilterFalse_PropagatesInsteadOfRunningBody()
    {
        string body = GetMethodBody(@"
            try { n = 1; }
            catch (Exception ex) when (false) { n = 999; }");

        Assert.Contains("if !false {", body);
        Assert.Contains("throw ex", body);
        Assert.DoesNotContain("999", body.Substring(0, body.IndexOf("if !false", StringComparison.Ordinal)));
    }

    /// <summary>A filter that only reads the caught exception variable (no other
    /// state) still translates: the binder is in scope for the filter expression
    /// (issue #1724).</summary>
    [Fact]
    public void CatchWhen_FilterReferencesExceptionVariable()
    {
        string body = GetMethodBody(@"
            try { n = 1; }
            catch (InvalidOperationException ex) when (ex.Message == ""retry"") { n = 2; }",
            extraLocals: "");

        Assert.Contains("if !(ex.Message == \"retry\") {", body);
        Assert.Contains("throw ex", body);
    }

    /// <summary>A filtered catch whose later sibling could still receive the
    /// same exception (here, a plain <c>Exception</c> catch-all after a filtered
    /// <c>InvalidOperationException</c>) is NOT rethrow-lowered: in C#, a false
    /// filter falls through to the later sibling instead of leaving the
    /// <c>try</c>, and the per-catch <c>throw ex</c> prologue cannot reproduce
    /// that fall-through (it would make the exception escape the whole
    /// <c>try</c>, silently skipping the sibling — the exact bug class issue
    /// #1724 exists to kill). The translator reports it as unsupported instead
    /// of emitting the wrong control flow.</summary>
    [Fact]
    public void FilteredCatch_WithOverlappingLaterSibling_ReportsUnsupportedInsteadOfRethrowLowering()
    {
        (string body, TranslationContext context) = GetMethodBodyAndContext(@"
            try { n = 1; }
            catch (InvalidOperationException ex) when (ex.Message.Length > 0) { n = 2; }
            catch (Exception ex2) { n = 3; }");

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported
                && d.Message.Contains("later sibling", StringComparison.OrdinalIgnoreCase));

        // No rethrow prologue was fabricated for the unsafe shape: the filter
        // condition text must not appear as a synthesized "if !(...)" guard.
        Assert.DoesNotContain("if !(ex.Message.Length > 0)", body);

        int firstCatch = body.IndexOf("} catch (ex InvalidOperationException) {", StringComparison.Ordinal);
        int secondCatch = body.IndexOf("} catch (ex2 Exception) {", StringComparison.Ordinal);
        Assert.True(firstCatch >= 0 && secondCatch > firstCatch);
    }

    /// <summary>Same divergent shape as above, framed around the actual runtime
    /// behavior it protects: with the filter false, C# falls through to the
    /// <c>Exception</c> sibling and runs its body — the sibling catch is never
    /// dead code, so the translator must not treat it as unreachable via a
    /// silent rethrow-escape. This is captured as the unsupported diagnostic
    /// (issue #1724 follow-up); no G# "faithful" lowering exists yet.</summary>
    [Fact]
    public void FilteredCatch_WithOverlappingLaterSibling_SiblingRemainsReachableNotDeadCode()
    {
        (string body, TranslationContext context) = GetMethodBodyAndContext(@"
            try { n = 1; }
            catch (InvalidOperationException ex) when (false) { n = 2; }
            catch (Exception ex2) { n = 3; }");

        Assert.Contains(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);

        // The sibling's body is preserved verbatim in the output — it is never
        // silently made unreachable by a fabricated "throw ex" escape.
        Assert.Contains("n = 3", body);
        int secondCatch = body.IndexOf("} catch (ex2 Exception) {", StringComparison.Ordinal);
        Assert.True(secondCatch >= 0);
        Assert.DoesNotContain("throw ex", body.Substring(0, secondCatch));
    }

    /// <summary>A filtered catch that is the LAST clause in the try is a SAFE
    /// shape: there is no later sibling to diverge from, so rethrow-lowering
    /// still applies and no diagnostic is recorded (issue #1724).</summary>
    [Fact]
    public void FilteredCatch_Last_StillRethrowLowers_NoDiagnostic()
    {
        (string body, TranslationContext context) = GetMethodBodyAndContext(@"
            try { n = 1; }
            catch (ArgumentNullException ex0) { n = 9; }
            catch (InvalidOperationException ex) when (ex.Message.Length > 0) { n = 2; }");

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("if !(ex.Message.Length > 0) {", body);
        Assert.Contains("throw ex", body);
    }

    /// <summary>A filtered catch followed only by sibling catches of provably
    /// disjoint exception types (unrelated classes, neither a super/subtype of
    /// the other) is a SAFE shape: no runtime exception object can match both,
    /// so the false-filter case can never actually need to fall through to that
    /// sibling, and rethrow-lowering remains correct with no diagnostic.</summary>
    [Fact]
    public void FilteredCatch_WithDisjointLaterSibling_StillRethrowLowers_NoDiagnostic()
    {
        (string body, TranslationContext context) = GetMethodBodyAndContext(@"
            try { n = 1; }
            catch (InvalidOperationException ex) when (ex.Message.Length > 0) { n = 2; }
            catch (FormatException ex2) { n = 3; }");

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("if !(ex.Message.Length > 0) {", body);
        Assert.Contains("throw ex", body);
    }

    /// <summary>A pre-declared C# <c>out</c> argument maps to the legacy
    /// pass-by-address form <c>&amp;x</c>; the uninitialised local binds as a
    /// mutable <c>var x T</c> (BCL methods reject inline <c>out var</c>, so the
    /// pre-declared form is canonical here).</summary>
    [Fact]
    public void PreDeclaredOutArgument_TranslatesToAddressOf()
    {
        string body = GetMethodBody(
            @"int v;
              d.TryGetValue(""a"", out v);
              n = v;",
            extraLocals: "var d = new System.Collections.Generic.Dictionary<string,int>();");
        Assert.Contains("var v int32", body);
        Assert.Contains("d.TryGetValue(\"a\", &v)", body);
    }

    /// <summary>A C# <c>using</c> statement maps to a scoped block whose resource
    /// binds as <c>using let r = ...</c> (sample <c>Defer.gs</c>); a C# 8
    /// <c>using var</c> declaration binds the same way at statement scope.</summary>
    [Fact]
    public void UsingStatement_TranslatesToUsingLet()
    {
        string body = GetMethodBody(
            @"using (var r = new System.IO.MemoryStream()) { n = (int)r.Length; }
              using var s = new System.IO.MemoryStream();
              n = (int)s.Length;");
        Assert.Contains("using let r = MemoryStream()", body);
        Assert.Contains("using let s = MemoryStream()", body);
    }

    /// <summary>A C# null-coalescing operator <c>??</c> is preserved (issue #941,
    /// sample <c>NullCoalescingAssignment.gs</c>).</summary>
    [Fact]
    public void NullCoalescing_IsPreserved()
    {
        string body = GetMethodBody(
            @"int? maybe = null;
              n = maybe ?? 0;");
        Assert.Contains("maybe ?? 0", body);
    }

    /// <summary>Compound assignment <c>total += x</c> is preserved (G# supports
    /// <c>+=</c> on numerics, spec §Statements).</summary>
    [Fact]
    public void CompoundAssignment_IsPreserved()
    {
        string body = GetMethodBody("n += 5;");
        Assert.Contains("n += 5", body);
    }

    /// <summary>Increment / decrement statements are preserved.</summary>
    [Fact]
    public void IncrementDecrement_IsPreserved()
    {
        string body = GetMethodBody("n++; n--;");
        Assert.Contains("n++", body);
        Assert.Contains("n--", body);
    }

    /// <summary>Static and instance method calls map to G# invocations / member
    /// access calls.</summary>
    [Fact]
    public void MethodInvocation_TranslatesCalls()
    {
        string body = GetMethodBody(@"
            System.Console.WriteLine(n);
            var s = n.ToString();");
        Assert.Contains("System.Console.WriteLine(n)", body);
        Assert.Contains("n.ToString()", body);
    }

    /// <summary>C# <c>new T(args)</c> maps to the G# construction call
    /// <c>T(args)</c>; a generic <c>new T&lt;U&gt;()</c> carries bracket type
    /// arguments <c>T[U]()</c>.</summary>
    [Fact]
    public void ObjectCreation_TranslatesToConstructionCall()
    {
        string plain = GetMethodBody(@"var b = new System.Text.StringBuilder();");
        Assert.Contains("StringBuilder()", plain);

        string generic = GetMethodBody(
            "var xs = new System.Collections.Generic.List<int>();");
        Assert.Contains("List[int32]()", generic);
    }

    /// <summary>Member / property access maps to <see cref="MemberAccessExpression"/>.</summary>
    [Fact]
    public void MemberAccess_TranslatesDotChain()
    {
        string body = GetMethodBody(
            "var c = items.Count;",
            extraLocals: "var items = new System.Collections.Generic.List<int>();");
        Assert.Contains("items.Count", body);
    }

    /// <summary>Binary and unary operators map straightforwardly, preserving
    /// explicit parentheses.</summary>
    [Fact]
    public void BinaryAndUnary_TranslateOperators()
    {
        string body = GetMethodBody("n = (n * 3 + 1) % 2; var neg = -n;");
        Assert.Contains("(n * 3 + 1) % 2", body);
        Assert.Contains("-n", body);
    }

    /// <summary>String interpolation maps holes to <c>$ident</c> / <c>${expr}</c>
    /// and escapes a literal <c>$</c> to <c>$$</c> (ADR-0115 §B.9).</summary>
    [Fact]
    public void StringInterpolation_TranslatesHolesAndDollarEscape()
    {
        string body = GetMethodBody(
            "var s = $\"{n} items at ${n} each\";");

        // `{n}` is a bare identifier hole -> `$n`; the literal `$` -> `$$`.
        Assert.Contains("\"$n items at $$$n each\"", body);
    }

    /// <summary>An identifier hole immediately followed by literal text that begins
    /// with an identifier-continuation character (letter/digit/underscore) must use
    /// the braced <c>${ident}</c> form so the trailing characters are not absorbed
    /// into the interpolated variable name (regression: <c>$"{thrdid}_{ticks}"</c>).</summary>
    [Fact]
    public void StringInterpolation_BracesHoleWhenFollowedByIdentifierChar()
    {
        string body = GetMethodBody(
            "var s = $\"{n}_more{n}x{n}.{n} end{n}\";",
            extraLocals: "var more = 0; var x = 0;");

        // `_`, `x`, follow the hole -> braced; `.`, ` `, and end-of-string do not -> shorthand.
        Assert.Contains("\"${n}_more${n}x$n.$n end$n\"", body);
    }

    /// <summary>local <c>var</c> never reassigned becomes <c>let</c>; a reassigned
    /// local becomes <c>var</c>; <c>const</c> stays <c>const</c> (ADR-0115 §B.3,
    /// data-flow driven).</summary>
    [Fact]
    public void LocalBindings_LetVarConst()
    {
        string body = GetMethodBody(@"
            const int k = 8;
            var fixedLocal = 1;
            var movingLocal = 2;
            movingLocal = movingLocal + 1;
            n = fixedLocal + movingLocal + k;");

        Assert.Contains("const k = 8", body);
        Assert.Contains("let fixedLocal = 1", body);
        Assert.Contains("var movingLocal = 2", body);
    }

    /// <summary>A local declared without an initializer keeps its type clause so
    /// the binding names a zero/default value (spec §Bindings).</summary>
    [Fact]
    public void LocalWithoutInitializer_KeepsTypeClause()
    {
        string body = GetMethodBody(@"
            string label;
            label = ""x"";
            n = label.Length;");
        Assert.Contains("var label string", body);
    }

    /// <summary>A tuple-construction argument translates to a G# tuple literal so
    /// the syntax round-trips even though the named-tuple type itself is an
    /// unsupported step-6 gap.</summary>
    [Fact]
    public void TupleArgument_TranslatesToTupleLiteral()
    {
        string body = GetMethodBody(
            "sink.Add((1, 2, 3));",
            extraLocals: "var sink = new System.Collections.Generic.List<(int, int, int)>();");
        Assert.Contains("sink.Add((1, 2, 3))", body);
    }

    private static async Task<(CompilationUnit Unit, TranslationContext Context)> TranslateL1CorpusAsync()
    {
        return await TranslateConsoleCorpusAsync("L1-Console", "L1-Console.csproj");
    }

    private static async Task<(CompilationUnit Unit, TranslationContext Context)> TranslateConsoleCorpusAsync(string projectFolder, string projectFile)
    {
        string projectPath = ResolveCorpusProject(projectFolder, projectFile);
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(projectPath);

        Assert.True(
            project.BoundWithoutErrors,
            $"{projectFolder} should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = project.Documents.Single(d => d.FilePath.EndsWith("Program.cs", StringComparison.Ordinal));
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context);
    }

    private static string ResolveCorpusProject(string projectFolder, string projectFile)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            string candidate = Path.Combine(dir.FullName, "tools", "cs2gs", "corpus", projectFolder, projectFile);
            if (File.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        throw new FileNotFoundException(
            $"Could not locate corpus project '{projectFolder}/{projectFile}' above {AppContext.BaseDirectory}.");
    }

    /// <summary>
    /// Translates a small C# statement snippet (wrapped in a method with an
    /// always-present mutable <c>int n</c> local) and returns the printed,
    /// round-trip-validated G# text of the whole compilation unit.
    /// </summary>
    /// <param name="statements">The C# statements to place in the method body.</param>
    /// <param name="extraLocals">Optional extra C# locals to declare first.</param>
    /// <returns>The printed G#.</returns>
    private static string GetMethodBody(string statements, string extraLocals = "")
        => GetMethodBodyAndContext(statements, extraLocals).Printed;

    /// <summary>
    /// Same as <see cref="GetMethodBody"/>, but also returns the
    /// <see cref="TranslationContext"/> so callers can assert on recorded
    /// <see cref="TranslationDiagnostic"/>s (e.g. the sibling-catch-overlap
    /// diagnostic added for issue #1724's follow-up).
    /// </summary>
    private static (string Printed, TranslationContext Context) GetMethodBodyAndContext(string statements, string extraLocals = "")
    {
        string source = $@"
using System;
namespace S
{{
    public class C
    {{
        public void M()
        {{
            var n = 0;
            {extraLocals}
            {statements}
            Use(n);
        }}

        private static void Use(int x) {{ }}
    }}
}}
";
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Snippet G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return (printed, context);
    }
}
