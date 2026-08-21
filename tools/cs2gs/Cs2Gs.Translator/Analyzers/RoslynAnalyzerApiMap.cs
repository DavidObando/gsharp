// <copyright file="RoslynAnalyzerApiMap.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;

namespace Cs2Gs.Translator.Analyzers;

/// <summary>
/// The declarative Roslyn → G# analyzer API map (ADR-0169,
/// docs/cs2gs-analyzer-translation.md). Analyzer translation mode is the
/// one place cs2gs's "third-party CLR APIs pass through untouched" rule is
/// wrong: Microsoft.CodeAnalysis usage must be rewritten to the G#
/// analyzer API, and the analyzed-language surface (SyntaxKind values,
/// syntax node members) to its structurally different G# counterpart.
/// Every entry carries a fidelity class: an <see cref="Entry.AdaptationNote"/>
/// marks an Adapted rewrite (detection semantics shifted — surfaces as a
/// CS2GS-ANALYZER-SHAPE warning); absence from the map is a loud
/// CS2GS-GAP, never a silent passthrough. Identity-mapped members are
/// backstopped by the round-trip binder: a translated member that does not
/// exist on the G# type fails AssertBinds/round-trip, never silently.
/// </summary>
internal static class RoslynAnalyzerApiMap
{
    /// <summary>
    /// Roslyn namespaces → G# namespaces, for rewriting using directives.
    /// Several C# namespaces collapse onto one G# namespace; the import
    /// de-dup in TranslateDocument handles the collision.
    /// </summary>
    private static readonly Dictionary<string, string> NamespaceMap = new(StringComparer.Ordinal)
    {
        ["Microsoft.CodeAnalysis"] = "GSharp.Core.CodeAnalysis",
        ["Microsoft.CodeAnalysis.Diagnostics"] = "GSharp.Core.CodeAnalysis.Analyzers",
        ["Microsoft.CodeAnalysis.CSharp"] = "GSharp.Core.CodeAnalysis.Syntax",
        ["Microsoft.CodeAnalysis.CSharp.Syntax"] = "GSharp.Core.CodeAnalysis.Syntax",
        ["Microsoft.CodeAnalysis.Operations"] = "GSharp.Core.CodeAnalysis.Binding",
        ["Microsoft.CodeAnalysis.Text"] = "GSharp.Core.CodeAnalysis.Text",
    };

    /// <summary>
    /// Roslyn type metadata name → G# type. Names deliberately mirror
    /// Roslyn wherever the framework could (ADR-0169), so most entries
    /// change only the namespace.
    /// </summary>
    private static readonly Dictionary<string, Entry> TypeMap = new(StringComparer.Ordinal)
    {
        // Host API (Exact).
        ["Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer"] = new("GSharp.Core.CodeAnalysis.Analyzers", "GSharpDiagnosticAnalyzer"),
        ["Microsoft.CodeAnalysis.Diagnostics.AnalysisContext"] = new("GSharp.Core.CodeAnalysis.Analyzers", "AnalysisContext"),
        ["Microsoft.CodeAnalysis.Diagnostics.CompilationStartAnalysisContext"] = new("GSharp.Core.CodeAnalysis.Analyzers", "CompilationStartAnalysisContext"),
        ["Microsoft.CodeAnalysis.Diagnostics.CompilationAnalysisContext"] = new("GSharp.Core.CodeAnalysis.Analyzers", "CompilationAnalysisContext"),
        ["Microsoft.CodeAnalysis.Diagnostics.SyntaxNodeAnalysisContext"] = new("GSharp.Core.CodeAnalysis.Analyzers", "SyntaxNodeAnalysisContext"),
        ["Microsoft.CodeAnalysis.Diagnostics.SyntaxTreeAnalysisContext"] = new("GSharp.Core.CodeAnalysis.Analyzers", "SyntaxTreeAnalysisContext"),
        ["Microsoft.CodeAnalysis.Diagnostics.SymbolAnalysisContext"] = new("GSharp.Core.CodeAnalysis.Analyzers", "SymbolAnalysisContext"),
        ["Microsoft.CodeAnalysis.Diagnostics.SemanticModelAnalysisContext"] = new("GSharp.Core.CodeAnalysis.Analyzers", "SemanticModelAnalysisContext"),
        ["Microsoft.CodeAnalysis.Diagnostics.OperationAnalysisContext"] = new(
            "GSharp.Core.CodeAnalysis.Analyzers",
            "BoundNodeAnalysisContext",
            "G# has no IOperation; bound-node actions receive BoundNode, whose member shapes are stable at the kind level only."),
        ["Microsoft.CodeAnalysis.Diagnostics.GeneratedCodeAnalysisFlags"] = new("GSharp.Core.CodeAnalysis.Analyzers", "GeneratedCodeAnalysisFlags"),
        ["Microsoft.CodeAnalysis.DiagnosticDescriptor"] = new("GSharp.Core.CodeAnalysis", "DiagnosticDescriptor"),
        ["Microsoft.CodeAnalysis.Diagnostic"] = new("GSharp.Core.CodeAnalysis", "Diagnostic"),
        ["Microsoft.CodeAnalysis.DiagnosticSeverity"] = new("GSharp.Core.CodeAnalysis", "DiagnosticSeverity"),
        ["Microsoft.CodeAnalysis.SemanticModel"] = new("GSharp.Core.CodeAnalysis", "SemanticModel"),
        ["Microsoft.CodeAnalysis.Location"] = new(
            "GSharp.Core.CodeAnalysis.Text",
            "TextLocation",
            "TextLocation is a struct with StartLine/StartCharacter; Roslyn's GetLineSpan idioms need review."),

        // Syntax surface (the analyzed language — structurally different).
        ["Microsoft.CodeAnalysis.SyntaxNode"] = new("GSharp.Core.CodeAnalysis.Syntax", "SyntaxNode"),
        ["Microsoft.CodeAnalysis.SyntaxToken"] = new("GSharp.Core.CodeAnalysis.Syntax", "SyntaxToken"),
        ["Microsoft.CodeAnalysis.SyntaxTree"] = new("GSharp.Core.CodeAnalysis.Syntax", "SyntaxTree"),
        ["Microsoft.CodeAnalysis.CSharp.SyntaxKind"] = new("GSharp.Core.CodeAnalysis.Syntax", "SyntaxKind"),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax"] = new("GSharp.Core.CodeAnalysis.Syntax", "ExpressionSyntax"),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.ElementAccessExpressionSyntax"] = new("GSharp.Core.CodeAnalysis.Syntax", "IndexExpressionSyntax"),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.IdentifierNameSyntax"] = new("GSharp.Core.CodeAnalysis.Syntax", "NameExpressionSyntax"),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax"] = new(
            "GSharp.Core.CodeAnalysis.Syntax",
            "AccessorExpressionSyntax",
            "G# member access is LeftPart/RightPart expressions, not Expression/Name; name extraction becomes RightPart.GetLastToken().Text."),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax"] = new("GSharp.Core.CodeAnalysis.Syntax", "ParenthesizedExpressionSyntax"),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax"] = new(
            "GSharp.Core.CodeAnalysis.Syntax",
            "AssignmentExpressionSyntax",
            "G# simple assignment targets an identifier token, and index/member writes are distinct Index/MemberIndexAssignmentExpression nodes — assignment-LHS pattern checks are usually structural no-ops in G#."),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax"] = new("GSharp.Core.CodeAnalysis.Syntax", "CallExpressionSyntax"),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.ObjectCreationExpressionSyntax"] = new("GSharp.Core.CodeAnalysis.Syntax", "ObjectCreationExpressionSyntax"),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.IsPatternExpressionSyntax"] = new(
            "GSharp.Core.CodeAnalysis.Syntax",
            "IsExpressionSyntax",
            "G# is-expressions carry ADR-0166 pattern shapes; designation and subpattern walks need review."),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.VariableDeclaratorSyntax"] = new(
            "GSharp.Core.CodeAnalysis.Syntax",
            "VariableDeclarationSyntax",
            "G# declarations are single-declarator; Variables-list walks collapse to the declaration itself."),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.TypeSyntax"] = new(
            "GSharp.Core.CodeAnalysis.Syntax",
            "TypeClauseSyntax",
            "G# type positions are type clauses; name-extraction helpers need review."),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.GenericNameSyntax"] = new("GSharp.Core.CodeAnalysis.Syntax", "GenericNameExpressionSyntax"),
        ["Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax"] = new(
            "GSharp.Core.CodeAnalysis.Syntax",
            "FunctionDeclarationSyntax",
            "FunctionDeclaration covers C# methods and local functions; review kind checks that distinguished them."),

        // Symbols (Exact by design where names align).
        ["Microsoft.CodeAnalysis.ISymbol"] = new("GSharp.Core.CodeAnalysis.Symbols", "Symbol"),
        ["Microsoft.CodeAnalysis.IFieldSymbol"] = new("GSharp.Core.CodeAnalysis.Symbols", "FieldSymbol"),
        ["Microsoft.CodeAnalysis.IPropertySymbol"] = new("GSharp.Core.CodeAnalysis.Symbols", "PropertySymbol"),
        ["Microsoft.CodeAnalysis.IMethodSymbol"] = new("GSharp.Core.CodeAnalysis.Symbols", "FunctionSymbol"),
        ["Microsoft.CodeAnalysis.IParameterSymbol"] = new("GSharp.Core.CodeAnalysis.Symbols", "ParameterSymbol"),
        ["Microsoft.CodeAnalysis.SymbolKind"] = new("GSharp.Core.CodeAnalysis.Symbols", "SymbolKind"),
        ["Microsoft.CodeAnalysis.SymbolEqualityComparer"] = new("GSharp.Core.CodeAnalysis.Symbols", "SymbolEqualityComparer"),
        ["Microsoft.CodeAnalysis.IArrayTypeSymbol"] = new("GSharp.Core.CodeAnalysis.Symbols", "ArrayTypeSymbol"),
        ["Microsoft.CodeAnalysis.SyntaxReference"] = new(
            "GSharp.Core.CodeAnalysis.Syntax",
            "SyntaxNode",
            "DeclaringSyntaxNodes holds SyntaxNodes directly; SyntaxReference locals become nodes and GetSyntax() calls are dropped."),
        ["Microsoft.CodeAnalysis.INamedTypeSymbol"] = new(
            "GSharp.Core.CodeAnalysis.Symbols",
            "TypeSymbol",
            "G# has no INamedTypeSymbol split; generic-instantiation idioms (ConstructedFrom, TypeArguments) need review against the concrete TypeSymbol subclass."),

        // Bound tree (the IOperation analogue).
        ["Microsoft.CodeAnalysis.IOperation"] = new(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundExpression",
            "IOperation maps to BoundExpression (Type/ConstantValue live on expressions in G#); statement-level operation analyzers need review."),
        ["Microsoft.CodeAnalysis.Operations.IBinaryOperation"] = new("GSharp.Core.CodeAnalysis.Binding", "BoundBinaryExpression"),
        ["Microsoft.CodeAnalysis.Operations.IInvocationOperation"] = new("GSharp.Core.CodeAnalysis.Binding", "BoundCallExpression"),
        ["Microsoft.CodeAnalysis.Operations.IArgumentOperation"] = new(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundExpression",
            "G# call arguments are the bound expressions directly; IArgumentOperation.Value accesses drop."),
        ["Microsoft.CodeAnalysis.Operations.IConversionOperation"] = new(
            "GSharp.Core.CodeAnalysis.Binding",
            "BoundConversionExpression",
            "G# inserts different implicit conversions than C#; conversion-unwrap loops need review."),
        ["Microsoft.CodeAnalysis.OperationKind"] = new("GSharp.Core.CodeAnalysis.Binding", "BoundNodeKind"),
        ["Microsoft.CodeAnalysis.Operations.BinaryOperatorKind"] = new("GSharp.Core.CodeAnalysis.Binding", "BoundBinaryOperatorKind"),
        ["Microsoft.CodeAnalysis.ITypeSymbol"] = new("GSharp.Core.CodeAnalysis.Symbols", "TypeSymbol"),
        ["Microsoft.CodeAnalysis.SymbolDisplayFormat"] = new(
            "GSharp.Core.CodeAnalysis.Symbols",
            "DisplayFormat",
            "G# collapses SymbolDisplayFormat options into the DisplayFormat enum; verify rendered-string comparisons."),
        ["Microsoft.CodeAnalysis.INamespaceSymbol"] = new(
            null,
            "string",
            "G# has no namespace symbol; ContainingNamespace is the display string directly, so ToDisplayString() calls on it are dropped."),
    };

    /// <summary>
    /// Enum member value renames, keyed by the Roslyn enum's metadata
    /// name. Members not listed for a mapped enum are identity-mapped and
    /// backstopped by the round-trip binder.
    /// </summary>
    private static readonly Dictionary<(string Type, string Member), Entry> EnumMemberMap = new()
    {
        [("Microsoft.CodeAnalysis.CSharp.SyntaxKind", "ElementAccessExpression")] = new(null, "IndexExpression"),
        [("Microsoft.CodeAnalysis.CSharp.SyntaxKind", "SimpleMemberAccessExpression")] = new(null, "AccessorExpression"),
        [("Microsoft.CodeAnalysis.CSharp.SyntaxKind", "InvocationExpression")] = new(null, "CallExpression"),
        [("Microsoft.CodeAnalysis.CSharp.SyntaxKind", "MethodDeclaration")] = new(
            null,
            "FunctionDeclaration",
            "FunctionDeclaration also covers C# local functions; review if the analyzer distinguished them."),
        [("Microsoft.CodeAnalysis.OperationKind", "BinaryOperator")] = new(null, "BinaryExpression"),
        [("Microsoft.CodeAnalysis.OperationKind", "Invocation")] = new(null, "CallExpression"),
        [("Microsoft.CodeAnalysis.OperationKind", "Conversion")] = new(null, "ConversionExpression"),
        [("Microsoft.CodeAnalysis.SymbolKind", "Method")] = new(null, "Function"),
        [("Microsoft.CodeAnalysis.SymbolKind", "NamedType")] = new(null, "Type"),
        [("Microsoft.CodeAnalysis.OperationKind", "TypeOf")] = new(null, "TypeOfExpression"),
    };

    /// <summary>
    /// Instance member renames, keyed by the declaring Roslyn type's
    /// metadata name. A null G# name marks a member with NO G#
    /// counterpart: the access is replaced per the note (comparison sites
    /// lower to <c>false</c>) and always surfaces a shape warning.
    /// </summary>
    private static readonly Dictionary<(string Type, string Member), Entry> MemberMap = new()
    {
        [("Microsoft.CodeAnalysis.CSharp.Syntax.ElementAccessExpressionSyntax", "Expression")] = new(null, "Target"),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax", "Name")] = new(
            null,
            "RightPart",
            "AccessorExpressionSyntax.RightPart is an expression; identifier extraction becomes GetLastToken()."),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax", "Expression")] = new(null, "LeftPart"),
        [("Microsoft.CodeAnalysis.SyntaxToken", "ValueText")] = new(null, "Text"),
        [("Microsoft.CodeAnalysis.Operations.IConversionOperation", "Operand")] = new(null, "Expression"),
        [("Microsoft.CodeAnalysis.Diagnostics.OperationAnalysisContext", "Operation")] = new(null, "BoundNode"),
        [("Microsoft.CodeAnalysis.INamedTypeSymbol", "TypeArguments")] = new(null, "ConstructedTypeArguments"),
        [("Microsoft.CodeAnalysis.SymbolDisplayFormat", "FullyQualifiedFormat")] = new(null, "FullyQualified"),
        [("Microsoft.CodeAnalysis.SymbolDisplayFormat", "MinimallyQualifiedFormat")] = new(null, "Minimal"),
        [("Microsoft.CodeAnalysis.Diagnostics.AnalysisContext", "RegisterOperationAction")] = new(
            null,
            "RegisterBoundNodeAction",
            "Operation actions become bound-node actions; BoundNode member shapes are stable at the kind level only."),
        [("Microsoft.CodeAnalysis.Operations.IBinaryOperation", "LeftOperand")] = new(null, "Left"),
        [("Microsoft.CodeAnalysis.Operations.IBinaryOperation", "RightOperand")] = new(null, "Right"),
        [("Microsoft.CodeAnalysis.Operations.IInvocationOperation", "TargetMethod")] = new(null, "Function"),
        [("Microsoft.CodeAnalysis.IMethodSymbol", "OverriddenMethod")] = new(null, "OverriddenMethod"),
        [("Microsoft.CodeAnalysis.ISymbol", "DeclaringSyntaxReferences")] = new(
            null,
            "DeclaringSyntaxNodes",
            "DeclaringSyntaxNodes holds SyntaxNodes directly; drop GetSyntax() calls."),
        [("Microsoft.CodeAnalysis.ITypeSymbol", "SpecialType")] = new(
            null,
            null,
            "G# has no SpecialType; comparisons rewrite to fully-qualified display-string checks, other uses fail the round-trip binder."),
        [("Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax", "Left")] = new(
            null,
            null,
            "G# index/member writes parse as Index/MemberIndexAssignmentExpression, never as a read node on an assignment's left; the C# assignment-LHS check has no G# counterpart, so comparisons against it lower to 'false'."),
    };

    /// <summary>
    /// Determines whether <paramref name="namespaceName"/> belongs to the
    /// Roslyn API surface this map rewrites.
    /// </summary>
    /// <param name="namespaceName">A namespace display string.</param>
    /// <returns>True for Microsoft.CodeAnalysis and its descendants.</returns>
    public static bool IsRoslynNamespace(string namespaceName)
        => namespaceName != null
           && (namespaceName == "Microsoft.CodeAnalysis"
               || namespaceName.StartsWith("Microsoft.CodeAnalysis.", StringComparison.Ordinal));

    /// <summary>Maps a Roslyn namespace to its G# counterpart for import rewriting.</summary>
    /// <param name="namespaceName">The Roslyn namespace.</param>
    /// <param name="gsNamespace">The G# namespace.</param>
    /// <returns>True when mapped.</returns>
    public static bool TryMapNamespace(string namespaceName, out string gsNamespace)
        => NamespaceMap.TryGetValue(namespaceName, out gsNamespace);

    /// <summary>Maps a Roslyn type metadata name to its G# type.</summary>
    /// <param name="metadataName">The Roslyn type's full metadata name.</param>
    /// <param name="entry">The mapped G# namespace/name plus any adaptation note.</param>
    /// <returns>True when mapped; false means CS2GS-GAP.</returns>
    public static bool TryMapType(string metadataName, out Entry entry)
        => TypeMap.TryGetValue(metadataName, out entry);

    /// <summary>
    /// Enumerates every G# namespace that analyzer translation may synthesize
    /// from a Roslyn namespace, type, member, or attribute rewrite.
    /// </summary>
    /// <returns>The mapped target namespaces. Duplicates are permitted.</returns>
    public static IEnumerable<string> EnumerateTargetNamespaces()
    {
        foreach (string targetNamespace in NamespaceMap.Values)
        {
            yield return targetNamespace;
        }

        foreach (Entry entry in TypeMap.Values)
        {
            if (!string.IsNullOrEmpty(entry.GsNamespace))
            {
                yield return entry.GsNamespace;
            }
        }
    }

    /// <summary>Maps a Roslyn enum member to its G# spelling.</summary>
    /// <param name="enumMetadataName">The declaring enum's metadata name.</param>
    /// <param name="memberName">The enum member.</param>
    /// <param name="entry">The mapped member plus any adaptation note.</param>
    /// <returns>True when an explicit rename exists; false means identity.</returns>
    public static bool TryMapEnumMember(string enumMetadataName, string memberName, out Entry entry)
        => EnumMemberMap.TryGetValue((enumMetadataName, memberName), out entry);

    /// <summary>Maps a Roslyn instance member to its G# spelling.</summary>
    /// <param name="typeMetadataName">The declaring type's metadata name.</param>
    /// <param name="memberName">The member name.</param>
    /// <param name="entry">The mapped member (null <see cref="Entry.GsName"/> = no counterpart) plus any note.</param>
    /// <returns>True when an explicit mapping exists; false means identity.</returns>
    public static bool TryMapMember(string typeMetadataName, string memberName, out Entry entry)
        => MemberMap.TryGetValue((typeMetadataName, memberName), out entry);

    /// <summary>A single mapping row.</summary>
    /// <param name="GsNamespace">The G# namespace (types only; null for members).</param>
    /// <param name="GsName">The G# spelling, or null when the member has no counterpart.</param>
    /// <param name="AdaptationNote">Non-null marks Adapted fidelity: emit a CS2GS-ANALYZER-SHAPE warning carrying this note.</param>
    internal readonly record struct Entry(string GsNamespace, string GsName, string AdaptationNote = null);
}
