// <copyright file="Issue3920Gsa0002ImportedOperandDispatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Analyzers
import Cs2Gs.Translator.Loading
import GSharp.CodeAnalysis.Analyzers.Testing
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import Xunit
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text

/// ADR-0169 M5, issue #3920: a Roslyn `OperationKind` corresponds to
/// SEVERAL G# bound-node kinds, and the one GSA0002 exists to police is never
/// the one the naive one-to-one map named.
///
/// G# binds `a == b` over operands of an IMPORTED CLR type to
/// `BoundClrBinaryOperatorExpression` (the resolved `op_Equality`),
/// not to `BoundBinaryExpression`; and a call to an imported method such
/// as `object.ReferenceEquals` to `BoundImportedCallExpression`, not
/// to `BoundCallExpression`. Translating
/// `RegisterOperationAction(h, OperationKind.BinaryOperator)` to a single
/// `RegisterBoundNodeAction(h, BoundNodeKind.BinaryExpression)` therefore
/// dispatched the migrated GSA0002 zero times over reflection-`Type`
/// comparisons — which are imported by construction — and the rule reported
/// nothing at all.
///
/// Every assertion here EXECUTES: the real analyzer is translated, compiled by
/// the real G# compiler, loaded, and run through the real
/// (cref:GSharpAnalyzerVerifier) over the translated snippet. The
/// positive and the two negatives share one path, so a rule that stops
/// reporting fails the positive rather than passing the negatives quietly.
class Issue3920Gsa0002ImportedOperandDispatchTests : IDisposable {
    private let workDirectory DirectoryInfo = Directory.CreateTempSubdirectory("cs2gs-gsa0002-dispatch")

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        try {
            workDirectory.Delete(recursive: true)
        } catch (IOException) { }
    }

    /// GSA0002, end to end, positive AND negatives on one path: the translated
    /// rule reports at exactly the three re-placed markers of the positive
    /// snippet — the case that reported NOTHING before the one-to-many kind
    /// expansion — and stays silent over both negatives.
    /// @param markedSnippet The C# snippet with its markers.
    /// @param ids The expected diagnostic ids.
    @Theory
    @MemberData("Gsa0002Cases")
    func TranslatedGsa0002_AgreesWithTheCSharpExpectation(markedSnippet string, ids[]string) {
        let result = SnippetTranslator.Translate(markedSnippet)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Empty(result.UnplacedMarkers)
        let analyzerDll = Adr0169TranslatedAnalyzerHarness.CompileTranslatedAnalyzer(
            workDirectory.FullName,
            "ReflectionTypeComparisonAnalyzer.cs",
            "TranslatedGsa0002"
        )
        let analyzers = GSharpAnalyzerHost.Load([]string{analyzerDll}, out var hostDiagnostics)
        Assert.Empty(hostDiagnostics)
        let analyzer = Assert.Single(analyzers)
        GSharp
            .CodeAnalysis
            .Analyzers
            .Testing
            .GSharpAnalyzerVerifier
            .VerifyAnalyzer(analyzer, result.GsWithMarkers!!, ids)
    }

    /// PR #3968 review, findings 1 and 2 — one fix covers both. A call-site
    /// `ReturnType` read is answered by the call NODE, not by the callee
    /// symbol: the symbol carries the declaration's type, so a constructed
    /// generic call reports the type parameter (measured:
    /// `symbol=T` vs `node=global::System.Int32`), and an imported
    /// generic method closed over a user-defined type reflects a placeholder.
    /// Reading the node sidesteps both without consulting either.
    @Fact
    func TargetMethodReturnType_IsAnsweredByTheCallNode() {
        let (printed, diagnostics) = TranslateAnalyzerSource(ReturnTypeAnalyzerSource)
        Assert.Contains("operation.Type.Name", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("CalledFunction.Type", printed, StringComparison.Ordinal)
        Assert.Contains(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-ANALYZER-SHAPE" && d.Message!!.Contains(
                "TargetMethod.ReturnType",
                StringComparison.Ordinal
            )
        )
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBinds(printed)
    }

    /// PR #3968 review, finding 3, taking the reviewer's "or reject this
    /// mapping" branch. An imported callee has no G# override chain, so a
    /// call-site `OverriddenMethod` would answer null for every call into
    /// metadata — and a member analyzers BRANCH on must not silently say "no".
    /// It is a gap instead. The declaring-symbol surface
    /// (`FunctionSymbol.OverriddenMethod`, which GSA0005 walks) is
    /// untouched.
    @Fact
    func TargetMethodOverriddenMethod_IsALoudGapRatherThanASilentNull() {
        let (_, diagnostics) = TranslateAnalyzerSource(OverriddenMethodAnalyzerSource)
        let gap = Assert.Single(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Equal("CS2GS-GAP", gap.DiagnosticId)
        Assert.Contains("OverriddenMethod", gap.Message, StringComparison.Ordinal)
    }

    /// PR #3968 review, finding 5: an argument's ROLE comes from the parameter
    /// it binds to, never from its position. Named arguments reorder freely, and
    /// `RegisterOperationAction(operationKinds: Kinds, action: H)` put the
    /// indirect array where a positional check expected the handler — so the
    /// guard skipped it and the silent one-to-one fallback survived inside the
    /// change meant to remove it.
    @Fact
    func NamedAndReorderedRegistrationArguments_AreStillGuarded() {
        let (printed, diagnostics) = TranslateAnalyzerSource(NamedReorderedKindsAnalyzerSource)
        let gap = Assert.Single(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Equal("CS2GS-GAP", gap.DiagnosticId)
        Assert.Contains("RegisterOperationAction", gap.Message, StringComparison.Ordinal)
        // The falsifier: the emitted registration really is the incomplete one,
        // so silence here would have been a live bug rather than a theoretical.
        Assert.Contains("Kinds", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ClrBinaryOperatorExpression", printed, StringComparison.Ordinal)
    }

    /// <summary>
    /// <summary>
    /// A registration whose kinds are named indirectly cannot be fanned out,
    /// and a quiet one-to-one fallback would reintroduce #3920 in a shape that
    /// compiles, runs, and reports nothing. It is a loud gap instead: a wrong
    /// answer that announces itself beats a wrong answer that does not.
    /// </summary>
    @Fact
    func IndirectlyNamedOperationKinds_AreALoudGapRatherThanASilentOneToOne() {
        let (printed, diagnostics) = TranslateAnalyzerSource(IndirectKindsAnalyzerSource)
        let gap = Assert.Single(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Equal("CS2GS-GAP", gap.DiagnosticId)
        Assert.Contains("RegisterOperationAction", gap.Message, StringComparison.Ordinal)
        // The falsifier for the guard itself: the emitted registration really
        // is the incomplete one, so silence here would have been a real bug
        // rather than a theoretical one.
        Assert.Contains("RegisterBoundNodeAction(AnalyzeBinary, Kinds)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ClrBinaryOperatorExpression", printed, StringComparison.Ordinal)
    }

    /// The falsifier for the guard's REACH: a kind spelled directly but
    /// carrying no fan-out row still translates through the plain enum rename.
    /// A guard that fired here would turn every unrelated operation-kind
    /// registration into a spurious gap.
    @Fact
    func DirectlyNamedKindWithoutAFanOutRow_IsNotAGap() {
        let (printed, diagnostics) = TranslateAnalyzerSource(DirectUnmappedKindAnalyzerSource)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains("BoundNodeKind.ConversionExpression", printed, StringComparison.Ordinal)
    }

    shared {
        // The real positive snippet from
        // ReflectionTypeComparisonAnalyzerTests.ReportsTypeofReferenceComparisonsInCompilerMetadataNamespaces.
        // All three sites compare an imported System.Type, so all three bind to
        // the imported-operand node shapes.
        private const Gsa0002Positive string = `using System;

namespace GSharp.Core.CodeAnalysis.Binding
{
    class C
    {
        bool EqualsTypeof(Type type) => [|type == typeof(string)|];
        bool NotEqualsTypeof(Type type) => [|typeof(int) != type|];
        bool ReferenceEqualsTypeof(Type type) => [|ReferenceEquals(type, typeof(string))|];
    }
}`

        // The real negative snippet from the same class: symbol comparisons, Type
        // compared to Type (no typeof), null checks, and the two exempt utility
        // types. Every one of these now REACHES the handler — before #3920 it was
        // silent because nothing was dispatched at all.
        private const Gsa0002NegativeExemptions string = `using System;

namespace GSharp.Core.CodeAnalysis.Symbols
{
    class Symbol { }
    class C
    {
        bool Same(Symbol a, Symbol b) => ReferenceEquals(a, b) || a == b;
        bool SameTypes(Type a, Type b) => ReferenceEquals(a, b) || a == b || a != b;
        bool NullCheck(Type a) => a == null || null != a;
    }

    class ClrTypeUtilities
    {
        bool Same(Type a) => ReferenceEquals(a, typeof(string)) || a == typeof(int);
    }

    class TypeIdentityComparer
    {
        bool Same(Type a) => ReferenceEquals(a, typeof(string)) || a == typeof(int);
    }
}`

        // The real negative snippet whose only exemption is the namespace.
        private const Gsa0002NegativeNamespace string = `using System;

namespace GSharp.Core.CodeAnalysis.Syntax
{
    class C
    {
        bool Same(Type a) => ReferenceEquals(a, typeof(string)) || a == typeof(string);
    }
}`

        /// Gets the GSA0002 positive and negative cases.
        /// @returns The theory data.
        func Gsa0002Cases() sequence[[]object] {
            yield[]object{Gsa0002Positive, []string{"GSA0002", "GSA0002", "GSA0002"}}
            yield[]object{Gsa0002NegativeExemptions, Array.Empty[string]()}
            yield[]object{Gsa0002NegativeNamespace, Array.Empty[string]()}
        }

        // A migrated analyzer that reads IInvocationOperation.TargetMethod.ReturnType.
        // Roslyn's TargetMethod is the CONSTRUCTED method, so its ReturnType is the
        // call site's; G#'s callee symbol carries the DECLARATION's, which for a
        // constructed generic call is the type parameter. The read is answered by
        // the call node instead.
        private const ReturnTypeAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ReturnTypeAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST3920A", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterOperationAction(AnalyzeCall, OperationKind.Invocation);

    private static void AnalyzeCall(OperationAnalysisContext context)
    {
        var operation = (IInvocationOperation)context.Operation;
        if (operation.TargetMethod.ReturnType.Name == "Int32")
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax.GetLocation()));
        }
    }
}
`

        // The same shape reaching TargetMethod.OverriddenMethod, which has no honest
        // answer at a call site: an imported callee has no G# override chain.
        private const OverriddenMethodAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OverriddenMethodAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST3920D", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterOperationAction(AnalyzeCall, OperationKind.Invocation);

    private static void AnalyzeCall(OperationAnalysisContext context)
    {
        var operation = (IInvocationOperation)context.Operation;
        if (operation.TargetMethod.OverriddenMethod != null)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax.GetLocation()));
        }
    }
}
`

        // The indirect registration again, but with the arguments NAMED and
        // REORDERED, so a guard keyed on syntactic position never inspects the
        // array at all.
        private const NamedReorderedKindsAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class NamedReorderedAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST3920E", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    private static readonly OperationKind[] Kinds = new[] { OperationKind.BinaryOperator };

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterOperationAction(operationKinds: Kinds, action: AnalyzeBinary);

    private static void AnalyzeBinary(OperationAnalysisContext context)
    {
        var operation = (IBinaryOperation)context.Operation;
        context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax.GetLocation()));
    }
}
`

        // The same registration, with the kinds named INDIRECTLY. cs2gs cannot fan
        // these out, and the one-to-one fallback would emit a registration that
        // binds, runs, and is dispatched zero times over imported code — the exact
        // silence #3920 exists to remove.
        private const IndirectKindsAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class IndirectKindsAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST3920B", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    private static readonly OperationKind[] Kinds = new[] { OperationKind.BinaryOperator };

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterOperationAction(AnalyzeBinary, Kinds);

    private static void AnalyzeBinary(OperationAnalysisContext context)
    {
        var operation = (IBinaryOperation)context.Operation;
        context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax.GetLocation()));
    }
}
`

        // A registration for a kind with no fan-out row, spelled DIRECTLY. The
        // enum rename is the whole answer here, so the indirection guard must not
        // fire: trading a silent wrong answer for a loud wrong one is not a fix.
        private const DirectUnmappedKindAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ConversionAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST3920C", "T", "M", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterOperationAction(AnalyzeConversion, OperationKind.Conversion);

    private static void AnalyzeConversion(OperationAnalysisContext context)
        => context.ReportDiagnostic(Diagnostic.Create(Rule, context.Operation.Syntax.GetLocation()));
}
`

        /// Translates one analyzer source in ADR-0169 analyzer mode.
        /// @param source The C# analyzer source.
        /// @returns The printed G# and the translation diagnostics.
        private func TranslateAnalyzerSource(source string)(
            Printed string,
            Diagnostics IReadOnlyList[TranslationDiagnostic]
        ) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Analyzer.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
            let translator = CSharpToGSharpTranslator(analyzerApiMode: true)
            let document = project.Documents.Single((d LoadedDocument) -> Path.GetFileName(d.FilePath) == "Analyzer.cs")
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            return (printed, context.Diagnostics.ToList())
        }

        /// Binds printed G# against the real GSharp.Core.
        /// @param printed The printed G# source.
        private func AssertBinds(printed string) {
            let tree = SyntaxTree.Parse(SourceText.From(printed, "analyzer.gs"))
            using let resolver = ReferenceResolver.WithRuntimeReferences([]string{typeof(Diagnostic).Assembly.Location})
            let compilation = Compilation(resolver, tree){IsLibrary = true}
            let errors = tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .Select((d Diagnostic) -> (d.Id + ": " + d.Message))
                .ToList()
            Assert.True(errors.Count == 0, string.Join("\n", errors))
        }
    }
}
