// <copyright file="Adr0169AnalyzerTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Analyzers;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0169 / docs/cs2gs-analyzer-translation.md: analyzer translation mode
/// rewrites Roslyn analyzer code to the G# analyzer API — attribute swap,
/// base-type and context types, SyntaxKind values, node-member renames,
/// GetLocation → Location, name-token idioms — and lowers comparisons against
/// members with no G# counterpart to constants with CS2GS-ANALYZER-SHAPE
/// review warnings. Unmapped Roslyn APIs fail loudly, never silently.
/// </summary>
public class Adr0169AnalyzerTranslationTests
{
    private const string MiniAnalyzerSource = @"
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
        ""TEST0001"",
        ""Title"",
        ""Message"",
        ""Testing"",
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
            && memberAccess.Name.Identifier.ValueText == ""Cache"")
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, access.GetLocation()));
        }
    }
}
";

    [Fact]
    public void MiniAnalyzer_TranslatesToGsAnalyzerApi()
    {
        var (printed, diagnostics) = TranslateAnalyzer(MiniAnalyzerSource);

        Assert.Contains("import GSharp.Core.CodeAnalysis.Analyzers", printed, StringComparison.Ordinal);
        Assert.Contains("GSharpDiagnosticAnalyzer", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("LanguageNames", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Microsoft.CodeAnalysis", printed, StringComparison.Ordinal);
        Assert.Contains("SyntaxKind.IndexExpression", printed, StringComparison.Ordinal);
        Assert.Contains("IndexExpressionSyntax", printed, StringComparison.Ordinal);
        Assert.Contains("AccessorExpressionSyntax", printed, StringComparison.Ordinal);
        Assert.Contains(".Target", printed, StringComparison.Ordinal);
        Assert.Contains("GetLastToken().Text", printed, StringComparison.Ordinal);
        Assert.Contains(".Location", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("GetLocation", printed, StringComparison.Ordinal);

        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void AssignmentLeftIdiom_RewritesToWriteNodeParentKindCheck()
    {
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
");

        Assert.Contains("SyntaxKind.MemberIndexAssignmentExpression", printed, StringComparison.Ordinal);
        Assert.Contains("SyntaxKind.CompoundIndexAssignmentExpression", printed, StringComparison.Ordinal);
        Assert.Contains("SyntaxKind.MemberFieldAssignmentExpression", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(".Left", printed, StringComparison.Ordinal);
        Assert.Contains(diagnostics, d => d.DiagnosticId == "CS2GS-ANALYZER-SHAPE"
            && d.Message.Contains("write-node parent-kind check", StringComparison.Ordinal));
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void SymbolActionAnalyzer_TranslatesContainmentAndGenericIdioms()
    {
        // The mechanical subset of GSA0003: symbol actions, containment,
        // ToDisplayString, and generic-instantiation queries.
        var (printed, diagnostics) = TranslateAnalyzer(@"
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class StaticCacheAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        ""TEST0003"", ""Title"", ""Message {0}"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSymbolAction(AnalyzeField, SymbolKind.Field);
    }

    private static void AnalyzeField(SymbolAnalysisContext context)
    {
        var field = (IFieldSymbol)context.Symbol;
        if (!field.IsStatic || field.ContainingNamespace.ToDisplayString() != ""App.Emit"")
        {
            return;
        }

        if (field.Type is INamedTypeSymbol namedType
            && namedType.TypeArguments.Length == 2
            && namedType.TypeArguments[0].ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) == ""global::System.Type"")
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, field.Locations[0], namedType.TypeArguments[0].Name));
        }
    }
}
");

        Assert.Contains("RegisterSymbolAction", printed, StringComparison.Ordinal);
        Assert.Contains("SymbolKind.Field", printed, StringComparison.Ordinal);
        Assert.Contains("FieldSymbol", printed, StringComparison.Ordinal);
        Assert.Contains("ConstructedTypeArguments", printed, StringComparison.Ordinal);
        Assert.Contains("DisplayFormat.FullyQualified", printed, StringComparison.Ordinal);

        // INamespaceSymbol.ToDisplayString() dropped: ContainingNamespace IS the string.
        Assert.Contains("field.ContainingNamespace != \"App.Emit\"", printed, StringComparison.Ordinal);

        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void OperationActionAnalyzer_TranslatesToBoundNodeApi()
    {
        // The mechanical subset of GSA0002: operation actions become
        // bound-node actions; operation members map onto BoundBinaryExpression.
        var (printed, diagnostics) = TranslateAnalyzer(@"
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class BinaryComparisonAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        ""TEST0002"", ""Title"", ""Message"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
");

        Assert.Contains("RegisterBoundNodeAction", printed, StringComparison.Ordinal);
        Assert.Contains("BoundNodeKind.BinaryExpression", printed, StringComparison.Ordinal);
        Assert.Contains("BoundBinaryExpression", printed, StringComparison.Ordinal);
        Assert.Contains(".Op.Kind", printed, StringComparison.Ordinal);
        Assert.Contains("BoundBinaryOperatorKind.Equals", printed, StringComparison.Ordinal);
        Assert.Contains("BoundNodeKind.TypeOfExpression", printed, StringComparison.Ordinal);
        Assert.Contains("BoundConversionExpression", printed, StringComparison.Ordinal);
        Assert.Contains("conversion.Expression", printed, StringComparison.Ordinal);

        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void SemanticModelAnalyzer_TranslatesDeclarationAndOverrideIdioms()
    {
        // The mechanical subset of GSA0005: GetDeclaredSymbol/GetSymbolInfo,
        // the override chain, declaring-syntax access, ancestor walks, and
        // symbol-identity sets.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
        ""TEST0005"", ""Title"", ""Message"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
");

        Assert.Contains("SyntaxKind.FunctionDeclaration", printed, StringComparison.Ordinal);
        Assert.Contains("FunctionDeclarationSyntax", printed, StringComparison.Ordinal);
        Assert.Contains("GetDeclaredSymbol", printed, StringComparison.Ordinal);
        Assert.Contains("as FunctionSymbol", printed, StringComparison.Ordinal);
        Assert.Contains("OverriddenMethod", printed, StringComparison.Ordinal);
        Assert.Contains("DeclaringSyntaxNodes", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("GetSyntax", printed, StringComparison.Ordinal);
        Assert.Contains("FirstAncestorOrSelf[FunctionDeclarationSyntax]", printed, StringComparison.Ordinal);
        Assert.Contains("SymbolEqualityComparer.Default", printed, StringComparison.Ordinal);

        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void ModifiersOverrideCheck_TranslatesToIsOverride()
    {
        // Issue #3536 (GSA0005 groundwork): G# has no Roslyn-style modifier
        // token list, only discrete typed modifier properties.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
");

        Assert.Contains("declaration.IsOverride", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Modifiers", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains(diagnostics, d => d.DiagnosticId == "CS2GS-ANALYZER-SHAPE");
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void ArgumentListAndParameterList_DropToDirectMembers()
    {
        // Issue #3536 (GSA0005 groundwork): G#'s CallExpressionSyntax and
        // FunctionDeclarationSyntax expose Arguments/Parameters directly —
        // there is no ArgumentListSyntax/ParameterListSyntax wrapper, and call
        // arguments are bare expressions with no ArgumentSyntax wrapper.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
");

        Assert.Contains("declaration.Parameters", printed, StringComparison.Ordinal);

        // The printer's statement-level width budget (issue #3470) wraps this
        // particular chain across lines, so "invocation.Arguments" is not
        // contiguous in the output; assert the pieces independently instead.
        Assert.Contains("invocation", printed, StringComparison.Ordinal);
        Assert.Contains(".Arguments", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ParameterList", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ArgumentList", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void PatternSyntaxParameter_TranslatesExactly()
    {
        // Issue #3536 (GSA0005 groundwork): Roslyn's PatternSyntax and G#'s
        // PatternSyntax share both name and namespace-only-rewrite shape.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
");

        Assert.Contains("PatternSyntax", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void BaseCallCheck_TranslatesToParentBaseClassCallCheck()
    {
        // Issue #3536 (GSA0005 groundwork): G# gives base.M(...) its own
        // BaseClassCallExpressionSyntax node wrapping an ordinary call, rather
        // than a member access on a base receiver, so the C# base-call
        // detection idiom rewrites to a parent-kind check on the call itself.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
");

        Assert.Contains(".Parent is BaseClassCallExpressionSyntax", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("BaseExpressionSyntax", printed, StringComparison.Ordinal);
        Assert.Contains(diagnostics, d => d.DiagnosticId == "CS2GS-ANALYZER-SHAPE"
            && d.Message.Contains("Base-call detection idiom", StringComparison.Ordinal));
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void SwitchLabelWalk_TranslatesToCasesWhereNotDefault()
    {
        // Issue #3536 (GSA0005 groundwork): G# switch cases carry one pattern
        // each with no section/label nesting and no default-arm subtype, so
        // the Sections.SelectMany(s => s.Labels).OfType<CasePatternSwitchLabelSyntax>()
        // walk rewrites to a direct Cases.Where(c => !c.IsDefault) walk.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
");

        Assert.Contains(".Cases", printed, StringComparison.Ordinal);
        Assert.Contains(".Where(", printed, StringComparison.Ordinal);
        Assert.Contains(".IsDefault", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("SelectMany", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Sections", printed, StringComparison.Ordinal);
        Assert.Contains(diagnostics, d => d.DiagnosticId == "CS2GS-ANALYZER-SHAPE"
            && d.Message.Contains("Cases.Where", StringComparison.Ordinal));
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void RealGsa0001Source_TranslatesWithReviewWarningsOnly()
    {
        // The real GSA0001 file end-to-end: everything maps or lowers, the
        // divergences surface as CS2GS-ANALYZER-SHAPE review warnings, and
        // the output binds against GSharp.Core.
        string realSource = File.ReadAllText(Path.Combine(
            FindRepoRoot(),
            "src", "Analyzers", "InternalAnalyzers", "StructFieldDefsReadAnalyzer.cs"));
        string descriptors = @"
using Microsoft.CodeAnalysis;

namespace GSharp.InternalAnalyzers;

public static class DiagnosticDescriptors
{
    public static readonly DiagnosticDescriptor StructFieldDefsRead = new(
        ""GSA0001"", ""Title"", ""Message"", ""GSharp.InternalAnalyzers"", DiagnosticSeverity.Warning, isEnabledByDefault: true);
}
";

        var (printedByFile, diagnostics) = TranslateAnalyzerProject(
            ("StructFieldDefsReadAnalyzer.cs", realSource),
            ("DiagnosticDescriptors.cs", descriptors));

        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains(diagnostics, d => d.DiagnosticId == "CS2GS-ANALYZER-SHAPE");

        string analyzer = printedByFile["StructFieldDefsReadAnalyzer.cs"];
        Assert.Contains("GSharpDiagnosticAnalyzer", analyzer, StringComparison.Ordinal);
        Assert.Contains("SyntaxKind.IndexExpression", analyzer, StringComparison.Ordinal);
        AssertBindsAgainstGsCore(printedByFile.Values.ToArray());
    }

    [Theory]
    [InlineData("StrongStaticReflectionCacheAnalyzer.cs")]
    [InlineData("ReflectionTypeComparisonAnalyzer.cs")]
    [InlineData("EmitCacheKeyRemapScopeAnalyzer.cs")]
    public void RealAnalyzerSources_TranslateWithReviewWarningsOnly(string fileName)
    {
        string realSource = File.ReadAllText(Path.Combine(
            FindRepoRoot(), "src", "Analyzers", "InternalAnalyzers", fileName));
        string descriptors = @"
using Microsoft.CodeAnalysis;

namespace GSharp.InternalAnalyzers;

public static class DiagnosticDescriptors
{
    public static readonly DiagnosticDescriptor StructFieldDefsRead = new(
        ""GSA0001"", ""T"", ""M"", ""GSharp.InternalAnalyzers"", DiagnosticSeverity.Warning, isEnabledByDefault: true);
    public static readonly DiagnosticDescriptor ReflectionTypeReferenceComparison = new(
        ""GSA0002"", ""T"", ""M"", ""GSharp.InternalAnalyzers"", DiagnosticSeverity.Warning, isEnabledByDefault: true);
    public static readonly DiagnosticDescriptor StrongStaticReflectionCache = new(
        ""GSA0003"", ""T"", ""M {0}"", ""GSharp.InternalAnalyzers"", DiagnosticSeverity.Warning, isEnabledByDefault: true);
    public static readonly DiagnosticDescriptor EmitCacheKeyMissingRemapScope = new(
        ""GSA0004"", ""T"", ""M {0}"", ""GSharp.InternalAnalyzers"", DiagnosticSeverity.Warning, isEnabledByDefault: true);
}
";

        var (printedByFile, diagnostics) = TranslateAnalyzerProject(
            (fileName, realSource),
            ("DiagnosticDescriptors.cs", descriptors));

        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printedByFile.Values.ToArray());
    }

    [Fact]
    public void RealGsa0005Source_FailsLoudly_NeverSilently()
    {
        // GSA0005 pattern-matches deeply C#-specific syntax shapes (switch
        // sections, subpatterns, designations); its migration requires the
        // reviewed adaptation the design doc predicts. This ratchet pins the
        // honest behavior: translation is LOUD — either a translation gap or
        // a round-trip binder failure — never a silently wrong analyzer.
        string realSource = File.ReadAllText(Path.Combine(
            FindRepoRoot(), "src", "Analyzers", "InternalAnalyzers", "RewriterClonePreservationAnalyzer.cs"));
        string descriptors = @"
using Microsoft.CodeAnalysis;

namespace GSharp.InternalAnalyzers;

public static class DiagnosticDescriptors
{
    public static readonly DiagnosticDescriptor RewriterCloneDropsMember = new(
        ""GSA0005"", ""T"", ""M {0} {1} {2} {3}"", ""GSharp.InternalAnalyzers"", DiagnosticSeverity.Warning, isEnabledByDefault: true);
}
";

        var (printedByFile, diagnostics) = TranslateAnalyzerProject(
            ("RewriterClonePreservationAnalyzer.cs", realSource),
            ("DiagnosticDescriptors.cs", descriptors));

        bool translationIsLoud = diagnostics.Any(d => d.Severity == TranslationSeverity.Unsupported);
        if (!translationIsLoud)
        {
            var trees = printedByFile.Values
                .Select(printed => GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
                    GSharp.Core.CodeAnalysis.Text.SourceText.From(printed, "gsa0005.gs")))
                .ToArray();
            using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(
                new[] { typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location });
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, trees) { IsLibrary = true };
            translationIsLoud = trees.Any(t => !t.Diagnostics.IsEmpty)
                || compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics).Any(d => d.IsError);
        }

        Assert.True(
            translationIsLoud,
            "GSA0005 translated AND bound cleanly — promote it into RealAnalyzerSources_TranslateWithReviewWarningsOnly and delete this ratchet.");
    }

    [Fact]
    public void ReadableAlias_ReservesLateAnalyzerSubstitutionNamespace()
    {
        string fixturePath = typeof(System.Text.Location).Assembly.Location;
        IReadOnlyList<MetadataReference> references = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(fixturePath))
            .ToArray();
        var (printedByFile, diagnostics) = TranslateAnalyzerProject(
            references,
            ("Analyzer.cs", @"
using System.Collections.Immutable;

namespace Sample;

[Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer(Microsoft.CodeAnalysis.LanguageNames.CSharp)]
public sealed class CollisionAnalyzer : Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer
{
    private static readonly Microsoft.CodeAnalysis.DiagnosticDescriptor Rule = new(
        ""TEST3466"", ""Title"", ""Message"", ""Testing"",
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
"));

        string printed = printedByFile["Analyzer.cs"];
        Assert.Contains(
            "import TextLocation_2 = System.Text.Location",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "import TextLocation = System.Text.Location",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "import GSharp.Core.CodeAnalysis.Text",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(
            new[] { fixturePath },
            printedByFile.Values.ToArray());
    }

    [Fact]
    public void UnmappedRoslynApi_ReportsLoudGap()
    {
        var (_, diagnostics) = TranslateAnalyzer(@"
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
");

        Assert.Contains(diagnostics, d => d.Severity == TranslationSeverity.Unsupported
            && d.Message.Contains("no G# analyzer-API mapping", StringComparison.Ordinal));
    }

    [Fact]
    public void NonAnalyzerProject_LeavesRoslynApisUntouched()
    {
        // Without analyzer mode, Microsoft.CodeAnalysis usage passes through
        // as ordinary imported CLR types (the pre-ADR-0169 behavior).
        LoadedCSharpProject project = LoadAnalyzerProject(@"
using Microsoft.CodeAnalysis;

namespace Sample;

public static class NotAnAnalyzer
{
    public static string Describe(SyntaxNode node) => node.ToString();
}
");
        Assert.False(AnalyzerProjectDetector.IsAnalyzerProject(project.Compilation));

        var translator = new CSharpToGSharpTranslator();
        LoadedDocument document = project.Documents.Single(d => Path.GetFileName(d.FilePath) != "GlobalUsings.cs");
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(translator.TranslateDocument(document, context));

        Assert.Contains("import Microsoft.CodeAnalysis", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void Detector_RecognizesAnalyzerProjects()
    {
        Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(LoadAnalyzerProject(MiniAnalyzerSource).Compilation));
    }

    private static (string Printed, IReadOnlyList<TranslationDiagnostic> Diagnostics) TranslateAnalyzer(string source)
    {
        var (printedByFile, diagnostics) = TranslateAnalyzerProject(("Analyzer.cs", source));
        return (printedByFile.Values.Single(), diagnostics);
    }

    private static (IReadOnlyDictionary<string, string> PrintedByFile, IReadOnlyList<TranslationDiagnostic> Diagnostics) TranslateAnalyzerProject(
        params (string FileName, string Source)[] sources)
        => TranslateAnalyzerProject(null, sources);

    private static (IReadOnlyDictionary<string, string> PrintedByFile, IReadOnlyList<TranslationDiagnostic> Diagnostics) TranslateAnalyzerProject(
        IReadOnlyList<MetadataReference> references,
        params (string FileName, string Source)[] sources)
    {
        LoadedCSharpProject project = LoadAnalyzerProject(sources, references);
        Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(project.Compilation));

        var translator = new CSharpToGSharpTranslator(analyzerApiMode: true);
        var printedByFile = new Dictionary<string, string>(StringComparer.Ordinal);
        var diagnostics = new List<TranslationDiagnostic>();
        foreach (LoadedDocument document in project.Documents.Where(d => Path.GetFileName(d.FilePath) != "GlobalUsings.cs"))
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            CompilationUnit unit = translator.TranslateDocument(document, context);
            printedByFile[Path.GetFileName(document.FilePath)] = GSharpPrinter.Print(unit);
            diagnostics.AddRange(context.Diagnostics);
        }

        return (printedByFile, diagnostics);
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "nuget.config")) &&
                File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        return null;
    }

    private static LoadedCSharpProject LoadAnalyzerProject(string source)
        => LoadAnalyzerProject(new[] { ("Analyzer.cs", source) });

    private static LoadedCSharpProject LoadAnalyzerProject((string FileName, string Source)[] sources)
        => LoadAnalyzerProject(sources, references: null);

    private static LoadedCSharpProject LoadAnalyzerProject(
        (string FileName, string Source)[] sources,
        IReadOnlyList<MetadataReference> references)
    {
        // The test host's trusted platform assemblies include the restored
        // Microsoft.CodeAnalysis packages, so the default reference set works.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(sources, references);
        Assert.True(
            project.BoundWithoutErrors,
            "Analyzer snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }

    private static void AssertBindsAgainstGsCore(params string[] printedSources)
        => AssertBindsAgainstGsCore(null, printedSources);

    private static void AssertBindsAgainstGsCore(
        IReadOnlyList<string> additionalReferencePaths,
        params string[] printedSources)
    {
        var trees = printedSources.Select((printed, index) =>
        {
            var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
                GSharp.Core.CodeAnalysis.Text.SourceText.From(printed, $"analyzer{index}.gs"));
            Assert.True(
                tree.Diagnostics.IsEmpty,
                "Translated analyzer should parse cleanly:\n" + string.Join("\n", tree.Diagnostics.Select(d => d.Message)) + "\n---\n" + printed);
            return tree;
        }).ToArray();

        IEnumerable<string> referencePaths =
            new[] { typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location }
                .Concat(additionalReferencePaths ?? Array.Empty<string>())
                .Distinct(StringComparer.OrdinalIgnoreCase);
        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(referencePaths);
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, trees)
        {
            IsLibrary = true,
        };
        var errors = compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToList();
        Assert.True(
            errors.Count == 0,
            "Translated analyzer should bind against GSharp.Core:\n" + string.Join("\n", errors.Select(d => d.Message)) + "\n---\n" + string.Join("\n=====\n", printedSources));
    }
}
