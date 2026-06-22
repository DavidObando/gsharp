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
    /// diagnostic — and the printed text round-trip-parses. The only
    /// <see cref="TranslationSeverity.Unsupported"/> records are the pre-existing
    /// named-tuple gaps from step 6 (the element type of <c>_items</c>).
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

        // Every remaining Unsupported diagnostic is the known named-tuple gap.
        Assert.All(
            context.Diagnostics.Where(d => d.Severity == TranslationSeverity.Unsupported),
            d => Assert.Contains("value-tuple", d.Message));
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
        string projectPath = ResolveCorpusProject("L1-Console", "L1-Console.csproj");
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(projectPath);

        Assert.True(
            project.BoundWithoutErrors,
            "L1-Console should bind with no C# errors: " +
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
        return printed;
    }
}
