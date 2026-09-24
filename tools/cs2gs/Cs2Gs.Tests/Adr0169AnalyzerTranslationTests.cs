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

        // Issue #4356: the C# is a pattern TEST on `current.Parent` (a nil parent
        // just fails it), so the synthesized `.Kind` read is null-conditional —
        // not `!!`, and not a bare `.Kind` through a `SyntaxNode?` receiver,
        // which bound only through gsc's old member-lookup carve-out.
        Assert.Contains(".Parent?.Kind == SyntaxKind.MemberIndexAssignmentExpression", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(".Parent.Kind", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(".Parent!!.Kind", printed, StringComparison.Ordinal);
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

        // Issue #3920: the registration names EVERY bound-node kind the Roslyn
        // operation reaches, and the handler casts to the shared base — an
        // `==` over imported operands is a ClrBinaryOperatorExpression, so
        // naming BinaryExpression alone dispatched the rule zero times over
        // exactly the code it exists for.
        Assert.Contains("BoundNodeKind.BinaryExpression", printed, StringComparison.Ordinal);
        Assert.Contains("BoundNodeKind.ClrBinaryOperatorExpression", printed, StringComparison.Ordinal);
        Assert.Contains("cast[BoundBinaryOperationExpression]", printed, StringComparison.Ordinal);

        // `Op` lives only on BoundBinaryExpression; the base normalizes both
        // provenances onto BinaryOperatorKind.
        Assert.DoesNotContain(".Op.Kind", printed, StringComparison.Ordinal);
        Assert.Contains(".BinaryOperatorKind != BoundBinaryOperatorKind.Equals", printed, StringComparison.Ordinal);
        Assert.Contains("BoundNodeKind.TypeOfExpression", printed, StringComparison.Ordinal);
        Assert.Contains("BoundConversionExpression", printed, StringComparison.Ordinal);
        Assert.Contains("conversion.Expression", printed, StringComparison.Ordinal);

        // Issue #4356: Roslyn's IOperation.Syntax is non-null, but G#'s
        // BoundNode.Syntax is `SyntaxNode?`, so `.GetLocation()`'s rewrite to
        // `.Location` dereferences a stated-nullable receiver and asserts it.
        Assert.Contains("operation.Syntax!!.Location", printed, StringComparison.Ordinal);

        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void NamespaceSymbolParameter_MapsToNullableStringWithoutAssert()
    {
        // Roslyn annotates INamespaceSymbol non-nullable even though
        // ContainingNamespace can be null; G#'s counterpart is honestly
        // `string?`. A null-tolerant helper taking INamespaceSymbol must keep
        // a nullable parameter — otherwise every ContainingNamespace argument
        // gets bridged with `!!`, a runtime NRE the C# could not produce (the
        // migrated EmitCacheKeyRemapScopeAnalyzer crash).
        var (printed, diagnostics) = TranslateAnalyzer(@"
#nullable enable
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class NamespaceHelperAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        ""TEST0007"", ""Title"", ""Message {0}"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

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
        return name == ""App.Emit"";
    }
}
");

        Assert.Contains("namespaceSymbol string?", printed, StringComparison.Ordinal);
        Assert.Contains("IsEmitNamespace(member.ContainingNamespace)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ContainingNamespace!!", printed, StringComparison.Ordinal);

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
    public void ModifiersOverrideCheck_DoesNotMatchLookalikeMember()
    {
        // Copilot review of #3556: the 'OverrideKeyword' idiom must resolve
        // the argument to the real Microsoft.CodeAnalysis.CSharp.SyntaxKind
        // enum field, not just match on spelling — otherwise a user-defined
        // 'OverrideKeyword' member of type SyntaxKind but a different value
        // would be silently rewritten to '.IsOverride' too.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
");

        Assert.DoesNotContain("IsOverride", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.DiagnosticId == "CS2GS-ANALYZER-SHAPE"
            && d.Message.Contains("IsOverride", StringComparison.Ordinal));
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

        // Issue #4356: Roslyn's ParameterSyntax.Identifier is a SyntaxToken
        // struct, G#'s is `SyntaxToken?` — dereferencing it asserts.
        Assert.Contains("declaration.Parameters[0].Identifier!!.Text", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void PropertyPatternOverRetargetedNullableMember_TakesTheNativePattern()
    {
        // Issue #4356: ParameterSyntax.Identifier is a SyntaxToken struct in
        // Roslyn but `SyntaxToken?` on the G# analyzer API. A nested property
        // pattern over it must take G#'s native pattern (one read, nil-safe),
        // not the boolean lowering, which would treat the struct as non-nil
        // and emit a bare `parameter.Identifier.Text`.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
        return parameter is { Identifier: { Text: ""x"" } };
    }
}
");

        Assert.Contains("parameter is { Identifier: { Text: \"x\" } }", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(".Identifier.Text", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    /// <summary>
    /// Issue #4356: the fallback paths (a quoted lambda, a pattern that must
    /// leave the native form because it reassigns its binder) decide
    /// nullability from the EMITTED G# type, not Roslyn's.
    /// <c>ParameterSyntax.Identifier</c> is a Roslyn <c>SyntaxToken</c> struct
    /// but <c>SyntaxToken?</c> on the G# analyzer API, so each of these
    /// shapes used to print a bare <c>.Identifier.Text</c> chain that bound
    /// only through gsc's member-lookup carve-out for stated-nullable chains.
    /// </summary>
    [Fact]
    public void RetargetedNullableMember_InFallbackPaths_IsGuardedOrAsserted()
    {
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
            text = text + ""!"";
            return text;
        }

        return """";
    }

    private static bool NestedWithReassignedBinder(MethodDeclarationSyntax declaration)
    {
        var parameter = declaration.ParameterList.Parameters[0];
        if (parameter is { Identifier: { Text: ""x"" } token })
        {
            var copy = token;
            token = copy;
            return token.Text == ""x"";
        }

        return false;
    }
}
");

        string flat = System.Text.RegularExpressions.Regex.Replace(printed, @"\s+", " ");
        Assert.Contains("Identifier!!.Text", flat, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void RetargetedNullableMember_ThroughInferredLocal_IsAsserted()
    {
        // Issue #4356: `var token = parameter.Identifier` emits an untyped
        // `let`, which G# infers as `SyntaxToken?` although Roslyn types the
        // local as the SyntaxToken struct. The local's later dereference,
        // plain and inside a quoted lambda, must assert it like the direct read.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
");

        string flat = System.Text.RegularExpressions.Regex.Replace(printed, @"\s+", " ");
        Assert.Contains("return alias!!.Text", flat, StringComparison.Ordinal);
        Assert.Contains("return a12!!.Text", flat, StringComparison.Ordinal);
        Assert.Contains("-> token!!.Text", flat, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void RetargetedNullableMember_ThroughComposedInitializers_IsAsserted()
    {
        // Issue #4356: a local's G# type is inferred from its whole initializer,
        // so a conditional, `??` or switch expression over analyzer-mapped
        // `SyntaxToken?` members yields a `SyntaxToken?` local too — including
        // one captured by a quoted lambda.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
");

        string flat = System.Text.RegularExpressions.Regex.Replace(printed, @"\s+", " ");
        Assert.Contains("return chosen!!.Text", flat, StringComparison.Ordinal);
        Assert.Contains("return picked!!.Text", flat, StringComparison.Ordinal);
        Assert.Contains("return selected!!.Text", flat, StringComparison.Ordinal);
        Assert.Contains("-> chosen!!.Text", flat, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void RetargetedNullableMember_ThroughEveryBindingShape_BindsWithoutCarveOut()
    {
        // Issue #4356: a local's emitted G# nullability is recorded where cs2gs
        // emits it, and an unhooked binding shape of a type that can be `T?`
        // on the G# side defaults to nullable. Every shape below binds a
        // SyntaxToken that is `SyntaxToken?` in G#, so each dereference must
        // assert — deconstruction, `out var`, `foreach` and a pattern designation.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
        => TryFirst(declaration, out var first) ? first.Text : """";

    private static string Each(MethodDeclarationSyntax declaration)
    {
        var names = new List<string>();
        foreach (var token in new[] { declaration.ParameterList.Parameters[0].Identifier })
        {
            names.Add(token.Text);
        }

        return string.Join("","", names);
    }

    private static string Designated(MethodDeclarationSyntax declaration)
        => declaration.ParameterList.Parameters[0].Identifier is var token ? token.Text : """";
}
");

        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void RetargetedNullableMember_AtEveryNonNullSink_BindsWithoutCarveOut()
    {
        // Issue #4356: every position that consumes a value as non-null must
        // bridge a `T?`-only-in-G# analyzer value: a cast operand, an argument
        // to a non-null parameter, a return, a conditional branch, a tuple
        // element, a lambda result, a string concatenation and an
        // interpolation. Receivers and local initializers are covered above.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
        => ""p:"" + d.ParameterList.Parameters[0].Identifier;

    private static string Interpolated(MethodDeclarationSyntax d)
        => $""p:{d.ParameterList.Parameters[0].Identifier}"";
}
");

        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void DesignationIdentifier_RetargetedToNullableBindingIdentifier_IsAsserted()
    {
        // Issue #4356: SingleVariableDesignationSyntax.Identifier (a Roslyn
        // SyntaxToken struct) maps to PatternSyntax.BindingIdentifier, which G#
        // declares `SyntaxToken?`. The walk filters to non-nil tokens, but a
        // filter proves nothing to the G# binder about a property read, so the
        // dereference asserts — as the same read on a Roslyn-annotated `T?`
        // member would.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
");

        Assert.Contains("designation.BindingIdentifier!!.Text", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void ArgumentListAndParameterList_OtherAccesses_StayLoud()
    {
        // Copilot review of #3556: only the '.ArgumentList.Arguments' and
        // '.ParameterList.Parameters' chains have a faithful G# counterpart.
        // Any other wrapper access (e.g. '.Span') must NOT be collapsed to
        // the receiver — that would silently observe a different node
        // ('invocation.Span' instead of 'invocation.ArgumentList.Span') — so
        // it stays untranslated and fails loudly at bind time instead.
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
");

        Assert.Contains(".ArgumentList", printed, StringComparison.Ordinal);
        Assert.Contains(".ParameterList", printed, StringComparison.Ordinal);

        var trees = new[]
        {
            GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
                GSharp.Core.CodeAnalysis.Text.SourceText.From(printed, "argparamspan.gs")),
        };
        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(
            new[] { typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location });
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, trees) { IsLibrary = true };
        bool translationIsLoud = diagnostics.Any(d => d.Severity == TranslationSeverity.Unsupported)
            || trees.Any(t => !t.Diagnostics.IsEmpty)
            || compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics).Any(d => d.IsError);
        Assert.True(
            translationIsLoud,
            "ArgumentList/ParameterList access other than .Arguments/.Parameters should fail loudly, not silently observe a different node:\n" + printed);
    }

    [Fact]
    public void ArgumentListIdiom_RestrictedToInvocationReceiver_OtherMappedReceiversStayLoud()
    {
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
        var (printed, diagnostics) = TranslateAnalyzer(@"
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
");

        Assert.Contains("elementAccess.ArgumentList", printed, StringComparison.Ordinal);
        Assert.Contains("objectCreation.ArgumentList", printed, StringComparison.Ordinal);

        var trees = new[]
        {
            GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
                GSharp.Core.CodeAnalysis.Text.SourceText.From(printed, "otherargumentlist.gs")),
        };
        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(
            new[] { typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location });
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, trees) { IsLibrary = true };
        bool translationIsLoud = diagnostics.Any(d => d.Severity == TranslationSeverity.Unsupported)
            || trees.Any(t => !t.Diagnostics.IsEmpty)
            || compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics).Any(d => d.IsError);
        Assert.True(
            translationIsLoud,
            "ElementAccessExpressionSyntax/ObjectCreationExpressionSyntax '.ArgumentList' reads should fail loudly, not silently reference a nonexistent 'Arguments' member:\n" + printed);
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
        // each with no section/label nesting and no default-arm or
        // pattern-label subtype. Roslyn's OfType<CasePatternSwitchLabelSyntax>()
        // excludes both the default arm AND plain constant labels (Copilot
        // review of #3556: `!c.IsDefault` alone would wrongly keep constant
        // labels too), so the walk rewrites to
        // Cases.Where(c => !c.IsDefault && (c.Guard != nil || c.Value is not
        // ConstantPatternSyntax)) — a guarded constant (`case 5 when b:`) is
        // still a Roslyn CasePatternSwitchLabelSyntax, kept via the Guard check.
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
        Assert.Contains(".Guard", printed, StringComparison.Ordinal);
        Assert.Contains("ConstantPatternSyntax", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("SelectMany", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Sections", printed, StringComparison.Ordinal);
        Assert.Contains(diagnostics, d => d.DiagnosticId == "CS2GS-ANALYZER-SHAPE"
            && d.Message.Contains("Cases.Where", StringComparison.Ordinal));
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void SwitchLabelWalk_FilterPredicate_KeepsOnlyPatternLabelsAgainstRealGsCases()
    {
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
        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(
                @"
func Run(v object) string {
    switch v {
        case 1 {
            return ""plain-constant""
        }
        case 1 when true {
            return ""guarded-constant""
        }
        case string s {
            return ""pattern""
        }
        default {
            return ""default""
        }
    }
}
",
                "switchfilter.gs"));
        Assert.Empty(tree.Diagnostics);

        var switchStatement = tree.Root
            .DescendantNodes()
            .OfType<GSharp.Core.CodeAnalysis.Syntax.SwitchStatementSyntax>()
            .Single();

        bool Keep(GSharp.Core.CodeAnalysis.Syntax.SwitchCaseSyntax c) =>
            !c.IsDefault && (c.Guard != null || c.Value is not GSharp.Core.CodeAnalysis.Syntax.ConstantPatternSyntax);

        var kept = switchStatement.Cases.Where(Keep).ToList();

        Assert.Equal(2, kept.Count);
        Assert.All(kept, c => Assert.False(c.IsDefault));
        Assert.Contains(kept, c => c.Guard != null && c.Value is GSharp.Core.CodeAnalysis.Syntax.ConstantPatternSyntax);
        Assert.Contains(kept, c => c.Guard is null && c.Value is not GSharp.Core.CodeAnalysis.Syntax.ConstantPatternSyntax);
        Assert.DoesNotContain(kept, c => c.Guard is null && c.Value is GSharp.Core.CodeAnalysis.Syntax.ConstantPatternSyntax);
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
    [InlineData("RewriterClonePreservationAnalyzer.cs")]
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
    public static readonly DiagnosticDescriptor RewriterCloneDropsMember = new(
        ""GSA0005"", ""T"", ""M {0} {1} {2} {3}"", ""GSharp.InternalAnalyzers"", DiagnosticSeverity.Warning, isEnabledByDefault: true);
}
";

        var (printedByFile, diagnostics) = TranslateAnalyzerProject(
            (fileName, realSource),
            ("DiagnosticDescriptors.cs", descriptors));

        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printedByFile.Values.ToArray());

        if (fileName == "RewriterClonePreservationAnalyzer.cs")
        {
            string printed = printedByFile[fileName];
            Assert.Contains(".GetConstructors()", printed, StringComparison.Ordinal);
            Assert.Contains("candidate.Name == \".ctor\"", printed, StringComparison.Ordinal);
            Assert.Contains("parameter.HasExplicitDefaultValue", printed, StringComparison.Ordinal);
            Assert.Contains("pattern.BindingIdentifier != nil", printed, StringComparison.Ordinal);
            Assert.Contains("type.NameIdentifier", printed, StringComparison.Ordinal);
            Assert.Contains("creation.Identifier.Text == nodeTypeName", printed, StringComparison.Ordinal);
            // Issue #4173 round 3: this analyzer has TWO real sites that used to
            // silently over-match a null-conditional hop (the tier-1 shared-node
            // bug) — a nested subpattern designator (here) and a switch-case
            // label (below) — both now carry the IsNullConditional: false
            // discriminator that makes the rewrite sound.
            Assert.Contains(
                "Parent: AccessorExpressionSyntax { IsNullConditional: false } access", printed, StringComparison.Ordinal);
            Assert.Contains(
                "case access is AccessorExpressionSyntax { IsNullConditional: false } when", printed, StringComparison.Ordinal);
        }
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
        => TestFixtureSource.Root;

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
        foreach (string printed in printedSources)
        {
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
            Assert.DoesNotContain("import Microsoft.", printed, StringComparison.Ordinal);
        }

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
