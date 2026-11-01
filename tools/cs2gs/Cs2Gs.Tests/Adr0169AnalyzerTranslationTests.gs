// <copyright file="Adr0169AnalyzerTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Analyzers
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Xunit
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Text
import System.Text.RegularExpressions

/// ADR-0169 / docs/cs2gs-analyzer-translation.md: analyzer translation mode
/// rewrites Roslyn analyzer code to the G# analyzer API — attribute swap,
/// base-type and context types, SyntaxKind values, node-member renames,
/// GetLocation → Location, name-token idioms — and lowers comparisons against
/// members with no G# counterpart to constants with CS2GS-ANALYZER-SHAPE
/// review warnings. Unmapped Roslyn APIs fail loudly, never silently.
open class Adr0169AnalyzerTranslationTests {
    @Fact
    func MiniAnalyzer_TranslatesToGsAnalyzerApi() {
        let (printed, diagnostics) = TranslateAnalyzer(MiniAnalyzerSource)
        Assert.Contains("import GSharp.Core.CodeAnalysis.Analyzers", printed, StringComparison.Ordinal)
        Assert.Contains("GSharpDiagnosticAnalyzer", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("LanguageNames", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Microsoft.CodeAnalysis", printed, StringComparison.Ordinal)
        Assert.Contains("SyntaxKind.IndexExpression", printed, StringComparison.Ordinal)
        Assert.Contains("IndexExpressionSyntax", printed, StringComparison.Ordinal)
        Assert.Contains("AccessorExpressionSyntax", printed, StringComparison.Ordinal)
        Assert.Contains(".Target", printed, StringComparison.Ordinal)
        Assert.Contains("GetLastToken().Text", printed, StringComparison.Ordinal)
        Assert.Contains(".Location", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("GetLocation", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func AssignmentLeftIdiom_RewritesToWriteNodeParentKindCheck() {
        let (printed, diagnostics) = TranslateAnalyzer(`
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class LeftCheckAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static bool IsAssignmentLeftSide(ExpressionSyntax expression)
    {
        var current = (SyntaxNode)expression;
        while (current.Parent is ParenthesizedExpressionSyntax)
        {
            current = current.Parent;
        }

        return current.Parent is AssignmentExpressionSyntax assignment && assignment.Left == current;
    }
}
`)
        Assert.Contains("SyntaxKind.MemberIndexAssignmentExpression", printed, StringComparison.Ordinal)
        Assert.Contains("SyntaxKind.CompoundIndexAssignmentExpression", printed, StringComparison.Ordinal)
        Assert.Contains("SyntaxKind.MemberFieldAssignmentExpression", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(".Left", printed, StringComparison.Ordinal)
        // Issue #4356: the C# is a pattern TEST on `current.Parent` (a nil parent
        // just fails it), so the synthesized `.Kind` read is null-conditional —
        // not `!!`, and not a bare `.Kind` through a `SyntaxNode?` receiver,
        // which bound only through gsc's old member-lookup carve-out.
        Assert.Contains(
            ".Parent?.Kind == SyntaxKind.MemberIndexAssignmentExpression",
            printed,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain(".Parent.Kind", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(".Parent!!.Kind", printed, StringComparison.Ordinal)
        Assert.Contains(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-ANALYZER-SHAPE" && d.Message!!.Contains(
                "write-node parent-kind check",
                StringComparison.Ordinal
            )
        )
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func SymbolActionAnalyzer_TranslatesContainmentAndGenericIdioms() {
        // The mechanical subset of GSA0003: symbol actions, containment,
        // ToDisplayString, and generic-instantiation queries.
        let (printed, diagnostics) = TranslateAnalyzer(`
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class StaticCacheAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST0003", "Title", "Message {0}", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSymbolAction(AnalyzeField, SymbolKind.Field);
    }

    private static void AnalyzeField(SymbolAnalysisContext context)
    {
        var field = (IFieldSymbol)context.Symbol;
        if (!field.IsStatic || field.ContainingNamespace.ToDisplayString() != "App.Emit")
        {
            return;
        }

        if (field.Type is INamedTypeSymbol namedType
            && namedType.TypeArguments.Length == 2
            && namedType.TypeArguments[0].ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) == "global::System.Type")
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, field.Locations[0], namedType.TypeArguments[0].Name));
        }
    }
}
`)
        Assert.Contains("RegisterSymbolAction", printed, StringComparison.Ordinal)
        Assert.Contains("SymbolKind.Field", printed, StringComparison.Ordinal)
        Assert.Contains("FieldSymbol", printed, StringComparison.Ordinal)
        Assert.Contains("ConstructedTypeArguments", printed, StringComparison.Ordinal)
        Assert.Contains("DisplayFormat.FullyQualified", printed, StringComparison.Ordinal)
        // INamespaceSymbol.ToDisplayString() dropped: ContainingNamespace IS the string.
        Assert.Contains("field.ContainingNamespace != \"App.Emit\"", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    /// Issue #4612: the analyzer bridge asserts an analyzer value that is
    /// `T?` only in G# where a lambda result must be non-null. In a runtime
    /// lambda that `!!` can throw and is reported; gsc erases it in an
    /// expression tree, so there it is not.
    @Fact
    func AnalyzerLambdaBridge_IsReportedOnlyOutsideExpressionTrees() {
        let (printed, diagnostics) = TranslateAnalyzer(`
using System;
using System.Collections.Immutable;
using System.Linq.Expressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class SyntaxAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST0009", "Title", "Message", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    private static readonly Func<IOperation, SyntaxNode> RuntimeSyntax = op => op.Syntax;

    private static readonly Expression<Func<IOperation, SyntaxNode>> TreeSyntax = op => op.Syntax;

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
    }
}
`)
        let sites = diagnostics.Where(
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
            .ToList()
        let site = Assert.Single(sites)
        Assert.Equal(16, site.Location!!.GetLineSpan().StartLinePosition.Line + 1)
        Assert.StartsWith(
            "kind=delegate-result | target=Func<IOperation, SyntaxNode>.Invoke(IOperation)",
            site.Message,
            StringComparison.Ordinal
        )
        Assert.Contains("RuntimeSyntax", printed, StringComparison.Ordinal)
    }

    @Fact
    func AnalyzerTupleArrayBridge_ResolvesItsArrayStore() {
        let source = `using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class SyntaxAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;
    public override void Initialize(AnalysisContext context) { }
    public static (SyntaxNode, int)[] Values(IOperation op) => new (SyntaxNode, int)[] { (op.Syntax, 1) };
}`
        let (printed, diagnostics) = TranslateAnalyzer(source)
        Assert.Contains("op.Syntax!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(
            diagnostics,
            (
                diagnostic TranslationDiagnostic
            ) -> diagnostic.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
        Assert.Equal(source.IndexOf("op.Syntax", StringComparison.Ordinal), site.Location!!.SourceSpan.Start)
        Assert.StartsWith(
            "kind=array-element | target=(SyntaxNode, int)[] | slot-type=SyntaxNode",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func OperationActionAnalyzer_TranslatesToBoundNodeApi() {
        // The mechanical subset of GSA0002: operation actions become
        // bound-node actions; operation members map onto BoundBinaryExpression.
        let (printed, diagnostics) = TranslateAnalyzer(`
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class BinaryComparisonAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST0002", "Title", "Message", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterOperationAction(AnalyzeBinary, OperationKind.BinaryOperator);
    }

    private static void AnalyzeBinary(OperationAnalysisContext context)
    {
        var operation = (IBinaryOperation)context.Operation;
        if (operation.OperatorKind != BinaryOperatorKind.Equals)
        {
            return;
        }

        var left = UnwrapConversion(operation.LeftOperand);
        if (left.Kind == OperationKind.TypeOf)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax.GetLocation()));
        }
    }

    private static IOperation UnwrapConversion(IOperation operation)
    {
        while (operation is IConversionOperation conversion)
        {
            operation = conversion.Operand;
        }

        return operation;
    }
}
`)
        Assert.Contains("RegisterBoundNodeAction", printed, StringComparison.Ordinal)
        // Issue #3920: the registration names EVERY bound-node kind the Roslyn
        // operation reaches, and the handler casts to the shared base — an
        // `==` over imported operands is a ClrBinaryOperatorExpression, so
        // naming BinaryExpression alone dispatched the rule zero times over
        // exactly the code it exists for.
        Assert.Contains("BoundNodeKind.BinaryExpression", printed, StringComparison.Ordinal)
        Assert.Contains("BoundNodeKind.ClrBinaryOperatorExpression", printed, StringComparison.Ordinal)
        Assert.Contains("cast[BoundBinaryOperationExpression]", printed, StringComparison.Ordinal)
        // `Op` lives only on BoundBinaryExpression; the base normalizes both
        // provenances onto BinaryOperatorKind.
        Assert.DoesNotContain(".Op.Kind", printed, StringComparison.Ordinal)
        Assert.Contains(".BinaryOperatorKind != BoundBinaryOperatorKind.Equals", printed, StringComparison.Ordinal)
        Assert.Contains("BoundNodeKind.TypeOfExpression", printed, StringComparison.Ordinal)
        Assert.Contains("BoundConversionExpression", printed, StringComparison.Ordinal)
        Assert.Contains("conversion.Expression", printed, StringComparison.Ordinal)
        // Issue #4356: Roslyn's IOperation.Syntax is non-null, but G#'s
        // BoundNode.Syntax is `SyntaxNode?`, so `.GetLocation()`'s rewrite to
        // `.Location` dereferences a stated-nullable receiver and asserts it.
        Assert.Contains("operation.Syntax!!.Location", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func OperationBlockSurface_TranslatesToBoundBodyApi() {
        // Issue #4436: the rows the ADR-0193 funnel analyzers use that the
        // funnel-surface parity tests do not reach — child/descendant walks,
        // the operation-kind reads, IIsTypeOperation.ValueOperand,
        // IMethodSymbol.MethodKind and the reference operations' Instance.
        let (printed, diagnostics) = TranslateAnalyzer(`
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class BlockSurfaceAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4436", "Title", "Message", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterOperationBlockAction(AnalyzeBlock);
        context.RegisterOperationAction(
            AnalyzeReference,
            OperationKind.MethodReference,
            OperationKind.PropertyReference,
            OperationKind.LocalReference,
            OperationKind.SimpleAssignment,
            OperationKind.VariableDeclarator);
        context.RegisterOperationAction(AnalyzeIsType, OperationKind.IsType);
    }

    private static void AnalyzeBlock(OperationBlockAnalysisContext context)
    {
        if (context.OwningSymbol is IMethodSymbol method && method.MethodKind == MethodKind.AnonymousFunction)
        {
            return;
        }

        foreach (IOperation block in context.OperationBlocks)
        {
            int children = block.ChildOperations.Count();
            int all = block.Descendants().Count();
            if (children > all)
            {
                context.ReportDiagnostic(Diagnostic.Create(Rule, block.Syntax.GetLocation()));
            }
        }
    }

    private static void AnalyzeReference(OperationAnalysisContext context)
    {
        if (context.Operation is IMethodReferenceOperation methodReference && methodReference.Instance == null)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, context.Operation.Syntax.GetLocation()));
        }
        else if (context.Operation is IPropertyReferenceOperation propertyReference && propertyReference.Instance == null)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, context.Operation.Syntax.GetLocation()));
        }
        else if (context.Operation.Kind == OperationKind.LocalReference)
        {
            return;
        }
    }

    private static void AnalyzeIsType(OperationAnalysisContext context)
    {
        var operation = (IIsTypeOperation)context.Operation;
        if (operation.ValueOperand.Kind == OperationKind.TypeOf)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax.GetLocation()));
        }
    }
}
`)
        Assert.Contains("RegisterBoundBodyAction", printed, StringComparison.Ordinal)
        Assert.Contains("BoundBodyAnalysisContext", printed, StringComparison.Ordinal)
        Assert.Contains(".Bodies", printed, StringComparison.Ordinal)
        Assert.Contains(".ChildNodes", printed, StringComparison.Ordinal)
        Assert.Contains(".Descendants()", printed, StringComparison.Ordinal)
        Assert.Contains("MethodKind.AnonymousFunction", printed, StringComparison.Ordinal)
        // One Roslyn reference kind fans out to both provenances.
        Assert.Contains("BoundNodeKind.MethodGroupExpression", printed, StringComparison.Ordinal)
        Assert.Contains("BoundNodeKind.ClrMethodGroupExpression", printed, StringComparison.Ordinal)
        Assert.Contains("BoundNodeKind.PropertyAccessExpression", printed, StringComparison.Ordinal)
        Assert.Contains("BoundNodeKind.ClrPropertyAccessExpression", printed, StringComparison.Ordinal)
        Assert.Contains("BoundMethodReferenceOperationExpression", printed, StringComparison.Ordinal)
        Assert.Contains("BoundPropertyReferenceOperationExpression", printed, StringComparison.Ordinal)
        Assert.Contains(".Instance", printed, StringComparison.Ordinal)
        Assert.Contains("BoundNodeKind.IsExpression", printed, StringComparison.Ordinal)
        // IIsTypeOperation.ValueOperand is BoundIsExpression.Expression.
        Assert.DoesNotContain("ValueOperand", printed, StringComparison.Ordinal)
        Assert.Contains("BoundIsExpression", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    /// Issue #5582: a `var` capture in a property subpattern has the G# type of the member that it reads.
    /// `IIsTypeOperation.TypeOperand` is non-null in Roslyn, but its G# member `BoundIsExpression.TypeOperand`
    /// is `TypeSymbol?`, so a dereference of the capture keeps its `!!` in the switch-arm and `is` forms.
    @Fact
    func TypeOperandVarCapture_KeepsTheMappedMembersNullability() {
        let (printed, diagnostics) = TranslateAnalyzer(`
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class TypeOperandAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST5582", "Title", "Message", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterOperationAction(AnalyzeIsType, OperationKind.IsType);
    }

    private static void AnalyzeIsType(OperationAnalysisContext context)
    {
        var operation = (IIsTypeOperation)context.Operation;
        string armName = operation switch { { TypeOperand: var t } => t.Name };
        string isName = operation is { TypeOperand: var u } ? u.Name : "";
        if (armName.Length + isName.Length == 0)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax.GetLocation()));
        }
    }
}
`)
        Assert.Contains("case { TypeOperand: var t }: t!!.Name", printed, StringComparison.Ordinal)
        Assert.Contains("if operation is { TypeOperand: var u } { u!!.Name }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func OperationRegistrationWrapper_ReservesCtxAgainstLiftedHandler() {
        let (printed, diagnostics) = TranslateAnalyzer(`
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class CtxAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TESTCTX1", "Title", "Message", "Testing", DiagnosticSeverity.Warning, true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterOperationAction(ctx, OperationKind.IsType);
        static void ctx(OperationAnalysisContext value) => Other<int>(value);
        static void Other<T>(OperationAnalysisContext value) => ctx(value);
    }
}`)
        Assert.Contains("func ctx(", printed, StringComparison.Ordinal)
        Assert.Contains("ctx_2 BoundNodeAnalysisContext", printed, StringComparison.Ordinal)
        Assert.Contains("ctx(ctx_2)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func SyntaxRegistrationWrapper_ReservesCtxAgainstLiftedHandler() {
        let (printed, diagnostics) = TranslateAnalyzer(`
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class CtxAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TESTCTX2", "Title", "Message", "Testing", DiagnosticSeverity.Warning, true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSyntaxNodeAction(ctx, SyntaxKind.ConditionalAccessExpression);
        static void ctx(SyntaxNodeAnalysisContext value) => Other<int>(value);
        static void Other<T>(SyntaxNodeAnalysisContext value) => ctx(value);
    }
}`)
        Assert.Contains("func ctx(", printed, StringComparison.Ordinal)
        Assert.Contains("ctx_2 SyntaxNodeAnalysisContext", printed, StringComparison.Ordinal)
        Assert.Contains("ctx(ctx_2)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func OperationRegistrationWrappers_ReserveVisibleSourceHandlerNames() {
        let (printed, diagnostics) = TranslateAnalyzer(`
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class CtxAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TESTCTX3", "Title", "Message", "Testing", DiagnosticSeverity.Warning, true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterOperationAction(Analyze, OperationKind.IsType);
        var ctx_2 = (OperationAnalysisContext value) => Analyze(value);
        context.RegisterOperationAction(ctx_2, OperationKind.PropertyReference);

        static void Analyze(OperationAnalysisContext value)
        {
        }
    }
}`)
        Assert.Contains("ctx BoundNodeAnalysisContext", printed, StringComparison.Ordinal)
        Assert.Contains("ctx_3 BoundNodeAnalysisContext", printed, StringComparison.Ordinal)
        Assert.Contains("ctx_2(ctx_3)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func SpecialTypeComparison_AssertsTheNilableContainingTypeReceiver() {
        // Issue #4287: `x.SpecialType != SpecialType.System_Object` is
        // rewritten to a CALL, `x.ToDisplayString(DisplayFormat.FullyQualified)
        // != "global::System.Object"`. `method.ContainingType` is `T?` on the
        // G# analyzer API, and gsc reports GS0159 for an instance call on a
        // stated `T?` receiver, so the synthesized receiver needs the same `!!`
        // a member read through it gets. This is GSA0002's own shape; it took
        // the hot-core translation guard red.
        let (printed, diagnostics) = TranslateAnalyzer(`
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ObjectEqualsAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST4287", "Title", "Message", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterOperationAction(Analyze, OperationKind.Invocation);
    }

    private static void Analyze(OperationAnalysisContext context)
    {
        var operation = (IInvocationOperation)context.Operation;
        if (operation.Arguments.Length != 2
            || operation.TargetMethod.ContainingType.SpecialType != SpecialType.System_Object)
        {
            return;
        }

        context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax.GetLocation()));
    }
}
`)
        Assert.Contains(
            ".ContainingType!!.ToDisplayString(DisplayFormat.FullyQualified) != \"global::System.Object\"",
            printed,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func NamespaceSymbolParameter_MapsToNullableStringWithoutAssert() {
        // Roslyn annotates INamespaceSymbol non-nullable even though
        // ContainingNamespace can be null; G#'s counterpart is honestly
        // `string?`. A null-tolerant helper taking INamespaceSymbol must keep
        // a nullable parameter — otherwise every ContainingNamespace argument
        // gets bridged with `!!`, a runtime NRE the C# could not produce (the
        // migrated EmitCacheKeyRemapScopeAnalyzer crash).
        let (printed, diagnostics) = TranslateAnalyzer(`
#nullable enable
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class NamespaceHelperAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST0007", "Title", "Message {0}", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSymbolAction(AnalyzeField, SymbolKind.Field);
    }

    private static void AnalyzeField(SymbolAnalysisContext context)
    {
        var field = (IFieldSymbol)context.Symbol;
        AnalyzeCacheMember(context, field, field.Name);
    }

    private static void AnalyzeCacheMember(SymbolAnalysisContext context, ISymbol member, string memberName)
    {
        if (IsEmitNamespace(member.ContainingNamespace))
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, member.Locations[0], memberName));
        }
    }

    private static bool IsEmitNamespace(INamespaceSymbol namespaceSymbol)
    {
        var name = namespaceSymbol?.ToDisplayString();
        return name == "App.Emit";
    }
}
`)
        Assert.Contains("namespaceSymbol string?", printed, StringComparison.Ordinal)
        Assert.Contains("IsEmitNamespace(member.ContainingNamespace)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ContainingNamespace!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func SemanticModelAnalyzer_TranslatesDeclarationAndOverrideIdioms() {
        // The mechanical subset of GSA0005: GetDeclaredSymbol/GetSymbolInfo,
        // the override chain, declaring-syntax access, ancestor walks, and
        // symbol-identity sets.
        let (printed, diagnostics) = TranslateAnalyzer(`
using System.Collections.Generic;
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OverrideAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST0005", "Title", "Message", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSyntaxNodeAction(AnalyzeMethod, SyntaxKind.MethodDeclaration);
    }

    private static void AnalyzeMethod(SyntaxNodeAnalysisContext context)
    {
        var declaration = (MethodDeclarationSyntax)context.Node;
        var symbol = context.SemanticModel.GetDeclaredSymbol(declaration) as IMethodSymbol;
        if (symbol == null || symbol.OverriddenMethod == null)
        {
            return;
        }

        var seen = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        seen.Add(symbol);

        foreach (var reference in symbol.OverriddenMethod.DeclaringSyntaxReferences)
        {
            var baseNode = reference.GetSyntax();
            var baseMethod = baseNode.FirstAncestorOrSelf<MethodDeclarationSyntax>();
            if (baseMethod != null)
            {
                context.ReportDiagnostic(Diagnostic.Create(Rule, declaration.GetLocation()));
            }
        }
    }
}
`)
        Assert.Contains("SyntaxKind.FunctionDeclaration", printed, StringComparison.Ordinal)
        Assert.Contains("FunctionDeclarationSyntax", printed, StringComparison.Ordinal)
        Assert.Contains("GetDeclaredSymbol", printed, StringComparison.Ordinal)
        Assert.Contains("as FunctionSymbol", printed, StringComparison.Ordinal)
        Assert.Contains("OverriddenMethod", printed, StringComparison.Ordinal)
        Assert.Contains("DeclaringSyntaxNodes", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("GetSyntax", printed, StringComparison.Ordinal)
        Assert.Contains("FirstAncestorOrSelf[FunctionDeclarationSyntax]", printed, StringComparison.Ordinal)
        Assert.Contains("SymbolEqualityComparer.Default", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func ModifiersOverrideCheck_TranslatesToIsOverride() {
        // Issue #3536 (GSA0005 groundwork): G# has no Roslyn-style modifier
        // token list, only discrete typed modifier properties.
        let (printed, diagnostics) = TranslateAnalyzer(`
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OverrideCheckAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.MethodDeclaration);
    }

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        var declaration = (MethodDeclarationSyntax)context.Node;
        if (!declaration.Modifiers.Any(SyntaxKind.OverrideKeyword))
        {
            return;
        }
    }
}
`)
        Assert.Contains("declaration.IsOverride", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Modifiers", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains(diagnostics, (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-ANALYZER-SHAPE")
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func ModifiersOverrideCheck_DoesNotMatchLookalikeMember() {
        // Copilot review of #3556: the 'OverrideKeyword' idiom must resolve
        // the argument to the real Microsoft.CodeAnalysis.CSharp.SyntaxKind
        // enum field, not just match on spelling — otherwise a user-defined
        // 'OverrideKeyword' member of type SyntaxKind but a different value
        // would be silently rewritten to '.IsOverride' too.
        let (printed, diagnostics) = TranslateAnalyzer(`
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

public static class Helpers
{
    public const SyntaxKind OverrideKeyword = SyntaxKind.PartialKeyword;
}

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class LookalikeOverrideCheckAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.MethodDeclaration);
    }

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        var declaration = (MethodDeclarationSyntax)context.Node;
        if (!declaration.Modifiers.Any(Helpers.OverrideKeyword))
        {
            return;
        }
    }
}
`)
        Assert.DoesNotContain("IsOverride", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-ANALYZER-SHAPE" && d.Message!!.Contains(
                "IsOverride",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func ArgumentListAndParameterList_DropToDirectMembers() {
        // Issue #3536 (GSA0005 groundwork): G#'s CallExpressionSyntax and
        // FunctionDeclarationSyntax expose Arguments/Parameters directly —
        // there is no ArgumentListSyntax/ParameterListSyntax wrapper, and call
        // arguments are bare expressions with no ArgumentSyntax wrapper.
        let (printed, diagnostics) = TranslateAnalyzer(`
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ArgumentShapeAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.MethodDeclaration);
    }

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        var declaration = (MethodDeclarationSyntax)context.Node;
        if (declaration.ParameterList.Parameters.Count != 1)
        {
            return;
        }

        string parameterName = declaration.ParameterList.Parameters[0].Identifier.ValueText;
        foreach (var invocation in declaration.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            bool passesParameter = invocation.ArgumentList.Arguments.Any(argument =>
                argument.Expression is IdentifierNameSyntax identifier && identifier.Identifier.ValueText == parameterName);
            _ = passesParameter;
        }
    }
}
`)
        Assert.Contains("declaration.Parameters", printed, StringComparison.Ordinal)
        // The printer's statement-level width budget (issue #3470) wraps this
        // particular chain across lines, so "invocation.Arguments" is not
        // contiguous in the output; assert the pieces independently instead.
        Assert.Contains("invocation", printed, StringComparison.Ordinal)
        Assert.Contains(".Arguments", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ParameterList", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ArgumentList", printed, StringComparison.Ordinal)
        // Issue #4356: Roslyn's ParameterSyntax.Identifier is a SyntaxToken
        // struct, G#'s is `SyntaxToken?` — dereferencing it asserts.
        Assert.Contains("declaration.Parameters[0].Identifier!!.Text", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func PropertyPatternOverRetargetedNullableMember_TakesTheNativePattern() {
        // Issue #4356: ParameterSyntax.Identifier is a SyntaxToken struct in
        // Roslyn but `SyntaxToken?` on the G# analyzer API. A nested property
        // pattern over it must take G#'s native pattern (one read, nil-safe),
        // not the boolean lowering, which would treat the struct as non-nil
        // and emit a bare `parameter.Identifier.Text`.
        let (printed, diagnostics) = TranslateAnalyzer(`
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ParameterNameAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static bool FirstIsNamedX(MethodDeclarationSyntax declaration)
    {
        var parameter = declaration.ParameterList.Parameters[0];
        return parameter is { Identifier: { Text: "x" } };
    }
}
`)
        Assert.Contains("parameter is { Identifier: { Text: \"x\" } }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(".Identifier.Text", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    /// Issue #4356: the fallback paths (a quoted lambda, a pattern that must
    /// leave the native form because it reassigns its binder) decide
    /// nullability from the EMITTED G# type, not Roslyn's.
    /// `ParameterSyntax.Identifier` is a Roslyn `SyntaxToken` struct
    /// but `SyntaxToken?` on the G# analyzer API, so each of these
    /// shapes used to print a bare `.Identifier.Text` chain that bound
    /// only through gsc's member-lookup carve-out for stated-nullable chains.
    @Fact
    func RetargetedNullableMember_InFallbackPaths_IsGuardedOrAsserted() {
        let (printed, diagnostics) = TranslateAnalyzer(`
using System;
using System.Linq.Expressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class FallbackShapesAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static Expression<Func<MethodDeclarationSyntax, string>> QuotedFirstName()
        => m => m.ParameterList.Parameters[0].Identifier.Text;

    private static string ExtendedWithReassignedBinder(MethodDeclarationSyntax declaration)
    {
        var parameter = declaration.ParameterList.Parameters[0];
        if (parameter is { Identifier.Text: var text })
        {
            text = text + "!";
            return text;
        }

        return "";
    }

    private static bool NestedWithReassignedBinder(MethodDeclarationSyntax declaration)
    {
        var parameter = declaration.ParameterList.Parameters[0];
        if (parameter is { Identifier: { Text: "x" } token })
        {
            var copy = token;
            token = copy;
            return token.Text == "x";
        }

        return false;
    }
}
`)
        let flat = Regex.Replace(printed, "\\s+", " ")
        Assert.Contains("Identifier!!.Text", flat, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func RetargetedNullableMember_ThroughInferredLocal_IsAsserted() {
        // Issue #4356: `var token = parameter.Identifier` emits an untyped
        // `let`, which G# infers as `SyntaxToken?` although Roslyn types the
        // local as the SyntaxToken struct. The local's later dereference,
        // plain and inside a quoted lambda, must assert it like the direct read.
        let (printed, diagnostics) = TranslateAnalyzer(`
using System;
using System.Linq.Expressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class InferredLocalAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static string FirstName(MethodDeclarationSyntax declaration)
    {
        var token = declaration.ParameterList.Parameters[0].Identifier;
        var alias = token;
        return alias.Text;
    }

    // A long alias chain: no fixed depth may cut it short.
    private static string LongChain(MethodDeclarationSyntax declaration)
    {
        var a0 = declaration.ParameterList.Parameters[0].Identifier;
        var a1 = a0; var a2 = a1; var a3 = a2; var a4 = a3; var a5 = a4;
        var a6 = a5; var a7 = a6; var a8 = a7; var a9 = a8; var a10 = a9;
        var a11 = a10; var a12 = a11;
        return a12.Text;
    }

    // A captured inferred local read inside a quoted lambda.
    private static Expression<Func<string>> QuotedFirstName(MethodDeclarationSyntax declaration)
    {
        var token = declaration.ParameterList.Parameters[0].Identifier;
        return () => token.Text;
    }
}
`)
        let flat = Regex.Replace(printed, "\\s+", " ")
        Assert.Contains("return alias!!.Text", flat, StringComparison.Ordinal)
        Assert.Contains("return a12!!.Text", flat, StringComparison.Ordinal)
        Assert.Contains("-> token!!.Text", flat, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func RetargetedNullableMember_ThroughComposedInitializers_IsAsserted() {
        // Issue #4356: a local's G# type is inferred from its whole initializer,
        // so a conditional, `??` or switch expression over analyzer-mapped
        // `SyntaxToken?` members yields a `SyntaxToken?` local too — including
        // one captured by a quoted lambda.
        let (printed, diagnostics) = TranslateAnalyzer(`
using System;
using System.Linq.Expressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ComposedInitializerAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static string Conditional(MethodDeclarationSyntax declaration, bool first)
    {
        var chosen = first
            ? declaration.ParameterList.Parameters[0].Identifier
            : declaration.ParameterList.Parameters[1].Identifier;
        return chosen.Text;
    }

    private static string Coalesced(MethodDeclarationSyntax declaration, SyntaxToken? preferred)
    {
        var picked = preferred ?? declaration.ParameterList.Parameters[0].Identifier;
        return picked.Text;
    }

    private static string Switched(MethodDeclarationSyntax declaration, int which)
    {
        var selected = which switch
        {
            0 => declaration.ParameterList.Parameters[0].Identifier,
            _ => declaration.ParameterList.Parameters[1].Identifier,
        };
        return selected.Text;
    }

    private static Expression<Func<string>> Quoted(MethodDeclarationSyntax declaration, bool first)
    {
        var chosen = first
            ? declaration.ParameterList.Parameters[0].Identifier
            : declaration.ParameterList.Parameters[1].Identifier;
        return () => chosen.Text;
    }
}
`)
        let flat = Regex.Replace(printed, "\\s+", " ")
        Assert.Contains("return chosen!!.Text", flat, StringComparison.Ordinal)
        Assert.Contains("return picked!!.Text", flat, StringComparison.Ordinal)
        Assert.Contains("return selected!!.Text", flat, StringComparison.Ordinal)
        Assert.Contains("-> chosen!!.Text", flat, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func RetargetedNullableMember_ThroughEveryBindingShape_BindsWithoutCarveOut() {
        // Issue #4356: a local's emitted G# nullability is recorded where cs2gs
        // emits it, and an unhooked binding shape of a type that can be `T?`
        // on the G# side defaults to nullable. Every shape below binds a
        // SyntaxToken that is `SyntaxToken?` in G#, so each dereference must
        // assert — deconstruction, `out var`, `foreach` and a pattern designation.
        let (printed, diagnostics) = TranslateAnalyzer(`
using System;
using System.Collections.Generic;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class BindingShapesAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static string Deconstructed(MethodDeclarationSyntax declaration)
    {
        (var token, var count) = (declaration.ParameterList.Parameters[0].Identifier, 0);
        return token.Text + count;
    }

    private static bool TryFirst(MethodDeclarationSyntax declaration, out SyntaxToken first)
    {
        first = declaration.ParameterList.Parameters[0].Identifier;
        return true;
    }

    private static string OutVar(MethodDeclarationSyntax declaration)
        => TryFirst(declaration, out var first) ? first.Text : "";

    private static string Each(MethodDeclarationSyntax declaration)
    {
        var names = new List<string>();
        foreach (var token in new[] { declaration.ParameterList.Parameters[0].Identifier })
        {
            names.Add(token.Text);
        }

        return string.Join(",", names);
    }

    private static string Designated(MethodDeclarationSyntax declaration)
        => declaration.ParameterList.Parameters[0].Identifier is var token ? token.Text : "";
}
`)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func RetargetedNullableMember_AtEveryNonNullSink_BindsWithoutCarveOut() {
        // Issue #4356: every position that consumes a value as non-null must
        // bridge a `T?`-only-in-G# analyzer value: a cast operand, an argument
        // to a non-null parameter, a return, a conditional branch, a tuple
        // element, a lambda result, a string concatenation and an
        // interpolation. Receivers and local initializers are covered above.
        let (printed, diagnostics) = TranslateAnalyzer(`
using System;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class SinkAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static string Use(SyntaxToken token) => token.Text;

    private static SyntaxToken Cast(MethodDeclarationSyntax d) => (SyntaxToken)d.ParameterList.Parameters[0].Identifier;

    private static string Argument(MethodDeclarationSyntax d) => Use(d.ParameterList.Parameters[0].Identifier);

    private static SyntaxToken Returned(MethodDeclarationSyntax d)
    {
        return d.ParameterList.Parameters[0].Identifier;
    }

    private static SyntaxToken Branch(MethodDeclarationSyntax d, bool first)
        => first ? d.ParameterList.Parameters[0].Identifier : d.ParameterList.Parameters[1].Identifier;

    private static (SyntaxToken Token, int Index) Tupled(MethodDeclarationSyntax d)
        => (d.ParameterList.Parameters[0].Identifier, 0);

    private static Func<MethodDeclarationSyntax, SyntaxToken> Lambda()
        => d => d.ParameterList.Parameters[0].Identifier;

    private static string Concatenated(MethodDeclarationSyntax d)
        => "p:" + d.ParameterList.Parameters[0].Identifier;

    private static string Interpolated(MethodDeclarationSyntax d)
        => $"p:{d.ParameterList.Parameters[0].Identifier}";
}
`)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func RetargetedNullableMember_IntoNullableEffectiveTargets_IsNotAsserted() {
        // Issue #4356: the bridge asserts only where the EFFECTIVE target is
        // certainly non-null. An async lambda into `Func<Task<SyntaxNode?>>`
        // (effective result `SyntaxNode?`, not the non-null Task envelope), a
        // nullable parameter, a nullable cast and a generic `T` parameter all
        // accept nil, so the value must pass through without `!!`; asserting
        // would turn a legal nil into a runtime failure.
        let (printed, diagnostics) = TranslateAnalyzer(`
using System;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class NullableTargetsAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static Func<Task<SyntaxNode?>> Async(IOperation operation)
        => async () => operation.Syntax;

    private static bool TakesNullable(SyntaxNode? node) => node == null;

    private static bool Argument(IOperation operation) => TakesNullable(operation.Syntax);

    private static SyntaxNode? Cast(IOperation operation) => (SyntaxNode?)operation.Syntax;

    private static T Identity<T>(T value) => value;

    private static SyntaxNode? Generic(IOperation operation) => Identity(operation.Syntax);
}
`)
        let flat = Regex.Replace(printed, "\\s+", " ")
        Assert.DoesNotContain("operation.Syntax!!", flat, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func RetargetedNullableMember_IntoPromotedOrNullableParamsTarget_IsNotAsserted() {
        // Issue #4356: an argument target is judged by its EMITTED type. A
        // parameter cs2gs promotes to `T?` (its body tests it against null)
        // and an expanded `params SyntaxNode?[]` element both accept nil, so the
        // mapped `operation.Syntax` must pass through without `!!` — asserting
        // turns a legal nil into a throw. A `params SyntaxNode[]` element is
        // non-null, so there it IS asserted.
        let (printed, diagnostics) = TranslateAnalyzer(`
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ArgumentTargetsAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static bool Promoted(SyntaxNode node) => node == null;

    private static int TakeNullable(params SyntaxNode?[] values) => values.Length;

    private static int TakeNonNull(params SyntaxNode[] values) => values.Length;

    private static bool PassPromoted(IOperation operation) => Promoted(operation.Syntax);

    private static int PassNullableParams(IOperation operation) => TakeNullable(operation.Syntax);

    private static int PassNonNullParams(IOperation operation) => TakeNonNull(operation.Syntax);
}
`)
        let flat = Regex.Replace(printed, "\\s+", " ")
        Assert.Contains("Promoted(operation.Syntax)", flat, StringComparison.Ordinal)
        Assert.Contains("TakeNullable(operation.Syntax)", flat, StringComparison.Ordinal)
        Assert.Contains("TakeNonNull(operation.Syntax!!)", flat, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func RetargetedNullableMember_IntoGenericTargets_AssertsOnlyExplicitNonNull() {
        // Issue #4356: a generic target G# RE-INFERS from the emitted argument
        // (inferred `Identity(x)`, inferred `params T[]`) takes the value's own
        // `T?`, so asserting would be wrong. With EXPLICIT type arguments
        // (`Identity<SyntaxNode>(x)`) the substituted non-null parameter is the
        // real target, so the value IS asserted.
        let (printed, diagnostics) = TranslateAnalyzer(`
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class GenericTargetsAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static T Identity<T>(T value) => value;

    private static int Count<T>(params T[] values) => values.Length;

    private static SyntaxNode Explicit(IOperation operation) => Identity<SyntaxNode>(operation.Syntax);

    private static SyntaxNode? Inferred(IOperation operation) => Identity(operation.Syntax);

    private static int InferredParams(IOperation operation) => Count(operation.Syntax, operation.Syntax);
}
`)
        let flat = Regex.Replace(printed, "\\s+", " ")
        Assert.Contains("Identity[SyntaxNode](operation.Syntax!!)", flat, StringComparison.Ordinal)
        Assert.Contains("-> Identity(operation.Syntax)", flat, StringComparison.Ordinal)
        Assert.Contains("Count(operation.Syntax, operation.Syntax)", flat, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func DesignationIdentifier_RetargetedToNullableBindingIdentifier_IsAsserted() {
        // Issue #4356: SingleVariableDesignationSyntax.Identifier (a Roslyn
        // SyntaxToken struct) maps to PatternSyntax.BindingIdentifier, which G#
        // declares `SyntaxToken?`. The walk filters to non-nil tokens, but a
        // filter proves nothing to the G# binder about a property read, so the
        // dereference asserts — as the same read on a Roslyn-annotated `T?`
        // member would.
        let (printed, diagnostics) = TranslateAnalyzer(`
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class DesignationAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static HashSet<string> Designations(SyntaxNode node)
    {
        var names = new HashSet<string>();
        foreach (var designation in node.DescendantNodesAndSelf().OfType<SingleVariableDesignationSyntax>())
        {
            names.Add(designation.Identifier.Text);
        }

        return names;
    }
}
`)
        Assert.Contains("designation.BindingIdentifier!!.Text", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func ArgumentListAndParameterList_OtherAccesses_StayLoud() {
        // Copilot review of #3556: only the '.ArgumentList.Arguments' and
        // '.ParameterList.Parameters' chains have a faithful G# counterpart.
        // Any other wrapper access (e.g. '.Span') must NOT be collapsed to
        // the receiver — that would silently observe a different node
        // ('invocation.Span' instead of 'invocation.ArgumentList.Span') — so
        // it stays untranslated and fails loudly at bind time instead.
        let (printed, diagnostics) = TranslateAnalyzer(`
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ArgumentListSpanAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.InvocationExpression);
        context.RegisterSyntaxNodeAction(AnalyzeMethod, SyntaxKind.MethodDeclaration);
    }

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        var invocation = (InvocationExpressionSyntax)context.Node;
        var span = invocation.ArgumentList.Span;
        _ = span;
    }

    private static void AnalyzeMethod(SyntaxNodeAnalysisContext context)
    {
        var declaration = (MethodDeclarationSyntax)context.Node;
        var span = declaration.ParameterList.Span;
        _ = span;
    }
}
`)
        Assert.Contains(".ArgumentList", printed, StringComparison.Ordinal)
        Assert.Contains(".ParameterList", printed, StringComparison.Ordinal)
        let trees = []GSharp
            .Core
            .CodeAnalysis
            .Syntax
            .SyntaxTree{GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(printed, "argparamspan.gs"))}
        using let resolver = ReferenceResolver.WithRuntimeReferences(
            []string{typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location}
        )
        let compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, trees){IsLibrary = true}
        let translationIsLoud = diagnostics.Any(
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        ) ||
            trees.Any((t GSharp.Core.CodeAnalysis.Syntax.SyntaxTree) -> !t.Diagnostics.IsEmpty) ||
            compilation
            .GlobalScope
            .Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Any((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
        Assert.True(translationIsLoud, `ArgumentList/ParameterList access other than .Arguments/.Parameters should fail loudly, not silently observe a different node:
` + printed)
    }

    @Fact
    func ArgumentListIdiom_RestrictedToInvocationReceiver_OtherMappedReceiversStayLoud() {
        // Copilot review of #3556: the '.ArgumentList.Arguments' drop must
        // only fire for an InvocationExpressionSyntax receiver.
        // ElementAccessExpressionSyntax and ObjectCreationExpressionSyntax
        // each independently declare their own same-named ArgumentList
        // property, and — unlike the '.Span' case in the test above — BOTH
        // receiver types themselves DO have a mapped G# counterpart
        // (IndexExpressionSyntax with Indices; ObjectCreationExpressionSyntax
        // with a nested Target call), so nothing else here would otherwise
        // flag the mismatch: dropping the wrapper for them would silently
        // reference a nonexistent 'Arguments' member on an
        // otherwise-cleanly-translated receiver. Both must stay untranslated
        // (identity 'ArgumentList') and fail loudly only at bind time.
        let (printed, diagnostics) = TranslateAnalyzer(`
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class OtherArgumentListReceiversAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSyntaxNodeAction(AnalyzeElementAccess, SyntaxKind.ElementAccessExpression);
        context.RegisterSyntaxNodeAction(AnalyzeObjectCreation, SyntaxKind.ObjectCreationExpression);
    }

    private static void AnalyzeElementAccess(SyntaxNodeAnalysisContext context)
    {
        var elementAccess = (ElementAccessExpressionSyntax)context.Node;
        int count = elementAccess.ArgumentList.Arguments.Count;
        _ = count;
    }

    private static void AnalyzeObjectCreation(SyntaxNodeAnalysisContext context)
    {
        var objectCreation = (ObjectCreationExpressionSyntax)context.Node;
        int count = objectCreation.ArgumentList.Arguments.Count;
        _ = count;
    }
}
`)
        Assert.Contains("elementAccess.ArgumentList", printed, StringComparison.Ordinal)
        Assert.Contains("objectCreation.ArgumentList", printed, StringComparison.Ordinal)
        let trees = []GSharp
            .Core
            .CodeAnalysis
            .Syntax
            .SyntaxTree{
            GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(printed, "otherargumentlist.gs"))
        }
        using let resolver = ReferenceResolver.WithRuntimeReferences(
            []string{typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location}
        )
        let compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, trees){IsLibrary = true}
        let translationIsLoud = diagnostics.Any(
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        ) ||
            trees.Any((t GSharp.Core.CodeAnalysis.Syntax.SyntaxTree) -> !t.Diagnostics.IsEmpty) ||
            compilation
            .GlobalScope
            .Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Any((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
        Assert.True(translationIsLoud, `ElementAccessExpressionSyntax/ObjectCreationExpressionSyntax '.ArgumentList' reads should fail loudly, not silently reference a nonexistent 'Arguments' member:
` + printed)
    }

    @Fact
    func PatternSyntaxParameter_TranslatesExactly() {
        // Issue #3536 (GSA0005 groundwork): Roslyn's PatternSyntax and G#'s
        // PatternSyntax share both name and namespace-only-rewrite shape.
        let (printed, diagnostics) = TranslateAnalyzer(`
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Generic;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class PatternWalkAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static void Describe(PatternSyntax pattern, HashSet<string> reads)
    {
        reads.Add(pattern.ToString());
    }
}
`)
        Assert.Contains("PatternSyntax", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func BaseCallCheck_TranslatesToParentBaseClassCallCheck() {
        // Issue #3536 (GSA0005 groundwork): G# gives base.M(...) its own
        // BaseClassCallExpressionSyntax node wrapping an ordinary call, rather
        // than a member access on a base receiver, so the C# base-call
        // detection idiom rewrites to a parent-kind check on the call itself.
        let (printed, diagnostics) = TranslateAnalyzer(`
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class BaseCallAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static bool IsBaseCall(InvocationExpressionSyntax invocation)
        => invocation.Expression is MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax };
}
`)
        Assert.Contains(".Parent is BaseClassCallExpressionSyntax", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("BaseExpressionSyntax", printed, StringComparison.Ordinal)
        Assert.Contains(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-ANALYZER-SHAPE" && d.Message!!.Contains(
                "Base-call detection idiom",
                StringComparison.Ordinal
            )
        )
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func SwitchLabelWalk_TranslatesToCasesWhereNotDefault() {
        // Issue #3536 (GSA0005 groundwork): G# switch cases carry one pattern
        // each with no section/label nesting and no default-arm or
        // pattern-label subtype. Roslyn's OfType<CasePatternSwitchLabelSyntax>()
        // excludes both the default arm AND plain constant labels (Copilot
        // review of #3556: `!c.IsDefault` alone would wrongly keep constant
        // labels too), so the walk rewrites to
        // Cases.Where(c => !c.IsDefault && (c.Guard != nil || c.Value is not
        // ConstantPatternSyntax)) — a guarded constant (`case 5 when b:`) is
        // still a Roslyn CasePatternSwitchLabelSyntax, kept via the Guard check.
        let (printed, diagnostics) = TranslateAnalyzer(`
using System.Linq;
using System.Collections.Generic;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class SwitchWalkAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static void CollectLabels(SwitchStatementSyntax switchStatement, List<string> reads)
    {
        foreach (var label in switchStatement.Sections.SelectMany(section => section.Labels).OfType<CasePatternSwitchLabelSyntax>())
        {
            reads.Add(label.ToString());
        }
    }
}
`)
        Assert.Contains(".Cases", printed, StringComparison.Ordinal)
        Assert.Contains(".Where(", printed, StringComparison.Ordinal)
        Assert.Contains(".IsDefault", printed, StringComparison.Ordinal)
        Assert.Contains(".Guard", printed, StringComparison.Ordinal)
        Assert.Contains("ConstantPatternSyntax", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("SelectMany", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Sections", printed, StringComparison.Ordinal)
        Assert.Contains(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-ANALYZER-SHAPE" && d.Message!!.Contains(
                "Cases.Where",
                StringComparison.Ordinal
            )
        )
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printed)
    }

    @Fact
    func SwitchLabelWalk_FilterPredicate_KeepsOnlyPatternLabelsAgainstRealGsCases() {
        // Copilot review of #3556: prove the actual filter predicate
        // ('!c.IsDefault && (c.Guard != nil || c.Value is not
        // ConstantPatternSyntax)') against real GSharp.Core.CodeAnalysis
        // SwitchCaseSyntax nodes parsed from a switch with all four label
        // kinds cs2gs's own translation can produce on the ANALYZED-code
        // side: a plain constant label (Roslyn CaseSwitchLabelSyntax, no
        // pattern-label counterpart), a guarded constant label (still a
        // Roslyn CasePatternSwitchLabelSyntax, since 'when' forces
        // pattern-label parsing), a real pattern label, and 'default'. Only
        // the guarded-constant and pattern arms should survive — a plain
        // '!IsDefault' filter would wrongly keep the plain constant arm too.
        let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(`
func Run(v object) string {
    switch v {
        case 1 {
            return "plain-constant"
        }
        case 1 when true {
            return "guarded-constant"
        }
        case string s {
            return "pattern"
        }
        default {
            return "default"
        }
    }
}
`, "switchfilter.gs"))
        Assert.Empty(tree.Diagnostics)
        let switchStatement = tree.Root.DescendantNodes().OfType[SwitchStatementSyntax]().Single()
        let Keep = func (c SwitchCaseSyntax) bool {
            return !c.IsDefault && (c.Guard != nil || !(c.Value is ConstantPatternSyntax))
        }
        let kept = switchStatement.Cases.Where(Keep).ToList()
        Assert.Equal(2, kept.Count)
        Assert.All(kept, (c SwitchCaseSyntax) -> Assert.False(c.IsDefault))
        Assert.Contains(kept, (c SwitchCaseSyntax) -> c.Guard != nil && c.Value is ConstantPatternSyntax)
        Assert.Contains(kept, (c SwitchCaseSyntax) -> c.Guard == nil && !(c.Value is ConstantPatternSyntax))
        Assert.DoesNotContain(kept, (c SwitchCaseSyntax) -> c.Guard == nil && c.Value is ConstantPatternSyntax)
    }

    @Fact
    func RealGsa0001Source_TranslatesWithReviewWarningsOnly() {
        // The real GSA0001 file end-to-end: everything maps or lowers, the
        // divergences surface as CS2GS-ANALYZER-SHAPE review warnings, and
        // the output binds against GSharp.Core.
        let realSource = FrozenCompilerSnapshots.Analyzer("StructFieldDefsReadAnalyzer.cs")
        let descriptors = `
using Microsoft.CodeAnalysis;

namespace GSharp.InternalAnalyzers;

public static class DiagnosticDescriptors
{
    public static readonly DiagnosticDescriptor StructFieldDefsRead = new(
        "GSA0001", "Title", "Message", "GSharp.InternalAnalyzers", DiagnosticSeverity.Warning, isEnabledByDefault: true);
}
`
        let (printedByFile, diagnostics) = TranslateAnalyzerProject(
            ("StructFieldDefsReadAnalyzer.cs", realSource),
            ("DiagnosticDescriptors.cs", descriptors)
        )
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        Assert.Contains(diagnostics, (d TranslationDiagnostic) -> d.DiagnosticId == "CS2GS-ANALYZER-SHAPE")
        let analyzer = printedByFile["StructFieldDefsReadAnalyzer.cs"]
        Assert.Contains("GSharpDiagnosticAnalyzer", analyzer, StringComparison.Ordinal)
        Assert.Contains("SyntaxKind.IndexExpression", analyzer, StringComparison.Ordinal)
        AssertBindsAgainstGsCore(printedByFile.Values.ToArray())
    }

    @Theory
    @InlineData("StrongStaticReflectionCacheAnalyzer.cs")
    @InlineData("ReflectionTypeComparisonAnalyzer.cs")
    @InlineData("EmitCacheKeyRemapScopeAnalyzer.cs")
    @InlineData("RewriterClonePreservationAnalyzer.cs")
    func RealAnalyzerSources_TranslateWithReviewWarningsOnly(fileName string) {
        let realSource = FrozenCompilerSnapshots.Analyzer(fileName)
        let descriptors = `
using Microsoft.CodeAnalysis;

namespace GSharp.InternalAnalyzers;

public static class DiagnosticDescriptors
{
    public static readonly DiagnosticDescriptor StructFieldDefsRead = new(
        "GSA0001", "T", "M", "GSharp.InternalAnalyzers", DiagnosticSeverity.Warning, isEnabledByDefault: true);
    public static readonly DiagnosticDescriptor ReflectionTypeReferenceComparison = new(
        "GSA0002", "T", "M", "GSharp.InternalAnalyzers", DiagnosticSeverity.Warning, isEnabledByDefault: true);
    public static readonly DiagnosticDescriptor StrongStaticReflectionCache = new(
        "GSA0003", "T", "M {0}", "GSharp.InternalAnalyzers", DiagnosticSeverity.Warning, isEnabledByDefault: true);
    public static readonly DiagnosticDescriptor EmitCacheKeyMissingRemapScope = new(
        "GSA0004", "T", "M {0}", "GSharp.InternalAnalyzers", DiagnosticSeverity.Warning, isEnabledByDefault: true);
    public static readonly DiagnosticDescriptor RewriterCloneDropsMember = new(
        "GSA0005", "T", "M {0} {1} {2} {3}", "GSharp.InternalAnalyzers", DiagnosticSeverity.Warning, isEnabledByDefault: true);
}
`
        let (printedByFile, diagnostics) = TranslateAnalyzerProject(
            (fileName, realSource),
            ("DiagnosticDescriptors.cs", descriptors)
        )
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
        AssertBindsAgainstGsCore(printedByFile.Values.ToArray())
        if fileName == "RewriterClonePreservationAnalyzer.cs" {
            let printed = printedByFile[fileName]
            Assert.Contains(".GetConstructors()", printed, StringComparison.Ordinal)
            Assert.Contains("candidate.Name == \".ctor\"", printed, StringComparison.Ordinal)
            Assert.Contains("parameter.HasExplicitDefaultValue", printed, StringComparison.Ordinal)
            Assert.Contains("pattern.BindingIdentifier != nil", printed, StringComparison.Ordinal)
            Assert.Contains("type.NameIdentifier", printed, StringComparison.Ordinal)
            Assert.Contains("creation.Identifier.Text == nodeTypeName", printed, StringComparison.Ordinal)
            // Issue #4173 round 3: this analyzer has TWO real sites that used to
            // silently over-match a null-conditional hop (the tier-1 shared-node
            // bug) — a nested subpattern designator (here) and a switch-case
            // label (below) — both now carry the IsNullConditional: false
            // discriminator that makes the rewrite sound.
            Assert.Contains(
                "Parent: AccessorExpressionSyntax { IsNullConditional: false } access",
                printed,
                StringComparison.Ordinal
            )
            Assert.Contains(
                "case access is AccessorExpressionSyntax { IsNullConditional: false } when",
                printed,
                StringComparison.Ordinal
            )
        }
    }

    @Fact
    func ReadableAlias_ReservesLateAnalyzerSubstitutionNamespace() {
        let fixturePath = typeof(System.Text.Location).Assembly.Location
        let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixturePath))
            .ToArray()
        let (printedByFile, diagnostics) = TranslateAnalyzerProject(references, ("Analyzer.cs", `
using System.Collections.Immutable;

namespace Sample;

[Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer(Microsoft.CodeAnalysis.LanguageNames.CSharp)]
public sealed class CollisionAnalyzer : Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer
{
    private static readonly Microsoft.CodeAnalysis.DiagnosticDescriptor Rule = new(
        "TEST3466", "Title", "Message", "Testing",
        Microsoft.CodeAnalysis.DiagnosticSeverity.Warning,
        isEnabledByDefault: true);

    public override ImmutableArray<Microsoft.CodeAnalysis.DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(Rule);

    public override void Initialize(Microsoft.CodeAnalysis.Diagnostics.AnalysisContext context)
    {
    }

    public static System.Text.Location CreateLocation() =>
        new System.Text.Location();

    private static Microsoft.CodeAnalysis.Location PreserveLocation(
        Microsoft.CodeAnalysis.Location location) => location;
}

public sealed class Location
{
}
`))
        let printed = printedByFile["Analyzer.cs"]
        Assert.Contains("import TextLocation_2 = System.Text.Location", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("import TextLocation = System.Text.Location", printed, StringComparison.Ordinal)
        Assert.Contains("import GSharp.Core.CodeAnalysis.Text", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        AssertBindsAgainstGsCore([]string{fixturePath}, printedByFile.Values.ToArray())
    }

    @Fact
    func UnmappedRoslynApi_ReportsLoudGap() {
        let (_, diagnostics) = TranslateAnalyzer(`
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class UsesUnmappedApi : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
        CSharpParseOptions options = CSharpParseOptions.Default;
        _ = options;
    }
}
`)
        Assert.Contains(
            diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "no G# analyzer-API mapping",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func NonAnalyzerProject_LeavesRoslynApisUntouched() {
        // Without analyzer mode, Microsoft.CodeAnalysis usage passes through
        // as ordinary imported CLR types (the pre-ADR-0169 behavior).
        let project = LoadAnalyzerProject(`
using Microsoft.CodeAnalysis;

namespace Sample;

public static class NotAnAnalyzer
{
    public static string Describe(SyntaxNode node) => node.ToString();
}
`)
        Assert.False(AnalyzerProjectDetector.IsAnalyzerProject(project.Compilation))
        let translator = CSharpToGSharpTranslator()
        let document = project.Documents.Single((d LoadedDocument) -> Path.GetFileName(d.FilePath) != "GlobalUsings.cs")
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
        Assert.Contains("import Microsoft.CodeAnalysis", printed, StringComparison.Ordinal)
    }

    @Fact
    func Detector_RecognizesAnalyzerProjects() {
        Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(LoadAnalyzerProject(MiniAnalyzerSource).Compilation))
    }

    shared {
        private const MiniAnalyzerSource string = `
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class MiniAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TEST0001",
        "Title",
        "Message",
        "Testing",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ElementAccessExpression);
    }

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        var access = (ElementAccessExpressionSyntax)context.Node;
        if (access.Expression is MemberAccessExpressionSyntax memberAccess
            && memberAccess.Name.Identifier.ValueText == "Cache")
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, access.GetLocation()));
        }
    }
}
`

        private func TranslateAnalyzer(source string)(
            Printed string,
            Diagnostics IReadOnlyList[TranslationDiagnostic]
        ) {
            let (printedByFile, diagnostics) = TranslateAnalyzerProject(("Analyzer.cs", source))
            return (printedByFile.Values.Single(), diagnostics)
        }

        private func TranslateAnalyzerProject(sources ...(FileName string, Source string))(
            PrintedByFile IReadOnlyDictionary[string, string],
            Diagnostics IReadOnlyList[TranslationDiagnostic]
        ) -> TranslateAnalyzerProject(nil, sources)

        private func TranslateAnalyzerProject(
            references IReadOnlyList[MetadataReference]?,
            sources ...(FileName string, Source string)
        )(PrintedByFile IReadOnlyDictionary[string, string], Diagnostics IReadOnlyList[TranslationDiagnostic]) {
            let project = LoadAnalyzerProject(sources, references)
            Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(project.Compilation))
            let translator = CSharpToGSharpTranslator(analyzerApiMode: true)
            let printedByFile = Dictionary[string, string](StringComparer.Ordinal)
            let diagnostics = List[TranslationDiagnostic]()
            for document in project.Documents.Where(
                (d LoadedDocument) -> Path.GetFileName(d.FilePath) != "GlobalUsings.cs"
            ) {
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                let unit = translator.TranslateDocument(document, context)
                printedByFile[Path.GetFileName(document.FilePath)] = GSharpPrinter.Print(unit)
                diagnostics.AddRange(context.Diagnostics)
            }
            return (printedByFile, diagnostics)
        }

        private func FindRepoRoot() string -> TestFixtureSource.Root

        private func LoadAnalyzerProject(source string) LoadedCSharpProject -> LoadAnalyzerProject(
            [](string, source string){("Analyzer.cs", source)}
        )

        private func LoadAnalyzerProject(
            sources[](FileName string, Source string)
        ) LoadedCSharpProject -> LoadAnalyzerProject(sources, references: nil)

        private func LoadAnalyzerProject(
            sources[](FileName string, Source string),
            references IReadOnlyList[MetadataReference]?
        ) LoadedCSharpProject {
            // The test host's trusted platform assemblies include the restored
            // Microsoft.CodeAnalysis packages, so the default reference set works.
            let project = CSharpProjectLoader.LoadInMemory(sources, references)
            Assert.True(
                project.BoundWithoutErrors,
                "Analyzer snippet should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            return project
        }

        private func AssertBindsAgainstGsCore(printedSources ...string) -> AssertBindsAgainstGsCore(nil, printedSources)

        private func AssertBindsAgainstGsCore(
            additionalReferencePaths IReadOnlyList[string]?,
            printedSources ...string
        ) {
            for printed in printedSources {
                // Issue #3734 (found by GS0547): a translated analyzer's references
                // have all been retargeted onto the G# analyzer API, so it must
                // import the G# namespaces ONLY. A synthesized import used to
                // record the C# symbol's own namespace verbatim, adding
                // `import Microsoft.CodeAnalysis[.CSharp]` alongside the
                // `GSharp.Core.CodeAnalysis[.Syntax]` the code was translated onto
                // — and since both export `DiagnosticDescriptor`, `Diagnostic` and
                // `SyntaxKind`, every bare use of those names bound whichever
                // import came first. Asserted for every fixture rather than in one
                // test, because the residue depends on which references a given
                // analyzer shortens.
                Assert.DoesNotContain("import Microsoft.", printed, StringComparison.Ordinal)
            }
            let trees = printedSources.Select(
                (printed string, index int32) -> {
                    let tree = GSharp
                        .Core
                        .CodeAnalysis
                        .Syntax
                        .SyntaxTree
                        .Parse(SourceText.From(printed, "analyzer$index.gs"))
                    Assert.True(
                        tree.Diagnostics.IsEmpty,
                        "Translated analyzer should parse cleanly:\n" + string.Join(
                            "\n",
                            tree.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)
                        ) +
                            `
---
` +
                            printed
                    )
                    return tree
                }
            )
                .ToArray()
            let referencePaths = []string{typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location}.Concat(
                additionalReferencePaths ?? Array.Empty[string]()
            )
                .Distinct(StringComparer.OrdinalIgnoreCase)
            using let resolver = ReferenceResolver.WithRuntimeReferences(referencePaths)
            let compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, trees){IsLibrary = true}
            let errors = compilation
                .GlobalScope
                .Diagnostics
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                .ToList()
            Assert.True(
                errors.Count == 0,
                "Translated analyzer should bind against GSharp.Core:\n" + string.Join(
                    "\n",
                    errors.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)
                ) +
                    `
---
` +
                    string.Join(`
=====
`, printedSources)
            )
        }
    }
}
