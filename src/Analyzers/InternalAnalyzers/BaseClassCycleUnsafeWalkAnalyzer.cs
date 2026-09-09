// <copyright file="BaseClassCycleUnsafeWalkAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace GSharp.InternalAnalyzers;

/// <summary>
/// GSA0006 (issues #4162, #4164): flags a loop that walks
/// <c>StructSymbol.BaseClass</c> by hand instead of through the guarded
/// <c>StructSymbol.GetHierarchy()</c> helper.
/// </summary>
/// <remarks>
/// <para>
/// A genuine base-class cycle (<c>class B : C</c> / <c>class C : B</c>) is
/// normally rejected by the post-bind cycle detector (issue #973), but
/// declaration binding walks a struct's <c>BaseClass</c> chain in several
/// places BEFORE that detector runs once at the end for every struct in the
/// compilation. #4162 fixed the first discovered instance
/// (<c>StructSymbol.GetHierarchy()</c> itself); auditing every other
/// <c>.BaseClass</c> walk for #4164 found five more independent, unguarded
/// copies of the identical loop shape, two of which reproduced the exact
/// same unbounded-memory-growth failure #4162 first found. Six independent
/// recurrences of one bug class is a signal that hand-auditing after each
/// new hang/OOM report does not scale — this rule makes a seventh
/// recurrence a build warning instead of a runtime defect.
/// </para>
/// <para>
/// The rule: any assignment of the shape <c>x = x.BaseClass</c>, where
/// <c>x</c> is a local/parameter identifier, occurring anywhere inside a
/// <c>for</c>/<c>while</c>/<c>do</c> loop is exactly the "advance one step
/// up the hierarchy" operation — the only legitimate reason to repeatedly
/// reassign a variable to its own <c>BaseClass</c> is to walk the chain, and
/// an unguarded walk of a cyclic chain never terminates. A single,
/// non-repeating fetch into a NEW variable name (e.g. <c>var parent =
/// current.BaseClass;</c>, used throughout the binder for immediate-base-class
/// checks) is not flagged — only self-reassignment inside a loop is the
/// unsafe shape.
/// </para>
/// <para>
/// <see cref="IsInsideExemptMethod"/> exempts <c>StructSymbol.GetHierarchy()</c>
/// itself (the one sanctioned implementation every other walk should call
/// instead of re-deriving its own guard) and
/// <c>DeclarationBinder.DetectClassInheritanceCycles()</c> (the cycle
/// detector itself — it cannot be rewritten to call
/// <c>GetHierarchy()</c> because it needs the exact back-edge node to
/// break, not just the acyclic prefix a hierarchy walk would silently stop
/// at).
/// </para>
/// <para>
/// Deliberately out of scope: a RECURSIVE walk (a method calling itself
/// with <c>x.BaseClass</c> as an argument) is a different syntactic shape
/// this rule does not detect — none of the sites found so far were
/// recursive, so this is not yet a proven gap, but it is a known one.
/// A null-conditional reassignment (<c>x = x?.BaseClass</c>) is also not
/// detected: this file self-migrates as part of the cs2gs-pr-guard hot-core
/// set (issue #4172), and <c>ConditionalAccessExpressionSyntax</c> /
/// <c>MemberBindingExpressionSyntax</c> have no G# analyzer-API mapping
/// (ADR-0169) — see issue #4173. Not a proven gap either: across every real
/// <c>.BaseClass</c>-walk site found and fixed (#4162, #4164, #4172), the
/// one null-conditional access encountered (<c>derived?.BaseClass</c> in
/// <c>DeclarationBinder.Functions.cs</c>, fixed by #4164) was in a loop
/// INITIALIZER, a position this rule never inspects — never in the
/// reassignment position this rule targets.
/// </para>
/// <para>
/// ENABLED BY DEFAULT (<c>isEnabledByDefault: true</c> on
/// <see cref="DiagnosticDescriptors.UnguardedBaseClassWalk"/>): a real-tree
/// run against <c>src/Core</c> initially found 47 further hand-rolled
/// <c>.BaseClass</c> walks beyond the six this rule was written to catch,
/// all safe only because of binding-phase ordering (they ran after the
/// cycle detector, or after emit-time diagnostics had already rejected a
/// cyclic program) — not a structural guarantee a future edit couldn't
/// break. Issue #4172 migrated every one of those 47 onto
/// <c>GetHierarchy()</c> (or deleted the one that was dead code), so this
/// repository's <c>TreatWarningsAsErrors=true</c> build now enforces the
/// rule for real: any new unguarded walk is a build break, not a runtime
/// hang waiting to be reported.
/// </para>
/// </remarks>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class BaseClassCycleUnsafeWalkAnalyzer : DiagnosticAnalyzer
{
    private const string StructSymbolTypeName = "StructSymbol";
    private const string BaseClassPropertyName = "BaseClass";
    private const string ExemptMethodName = "GetHierarchy";
    private const string ExemptDetectorMethodName = "DetectClassInheritanceCycles";
    private const string ExemptDetectorTypeName = "DeclarationBinder";

    /// <inheritdoc />
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; }
        = ImmutableArray.Create(DiagnosticDescriptors.UnguardedBaseClassWalk);

    /// <inheritdoc />
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();

        // Issue #4173: registered on the identifier rather than the
        // assignment itself, and filtered by an equality check against
        // AssignmentExpressionSyntax.Left (StructFieldDefsReadAnalyzer.cs
        // uses the identical idiom), rather than an `assignment.Left is not
        // IdentifierNameSyntax leftIdentifier` type-pattern test. Both
        // recognize exactly the same set of assignments — an identifier can
        // only be found as `.Left` when `.Left` IS an IdentifierNameSyntax —
        // but cs2gs's analyzer-API mode only knows how to lower an equality
        // comparison against `.Left` (which has no G# counterpart: G#'s
        // AssignmentExpressionSyntax targets a plain IdentifierToken, never
        // an arbitrary expression), not a type-pattern test against it.
        context.RegisterSyntaxNodeAction(AnalyzeAssignment, SyntaxKind.IdentifierName);
    }

    private static void AnalyzeAssignment(SyntaxNodeAnalysisContext context)
    {
        var leftIdentifier = (IdentifierNameSyntax)context.Node;
        if (leftIdentifier.Parent is not AssignmentExpressionSyntax assignment
            || assignment.Left != leftIdentifier)
        {
            return;
        }

        var baseClassAccess = GetBaseClassAccess(assignment.Right, out var rightReceiver);
        if (baseClassAccess == null
            || rightReceiver is not IdentifierNameSyntax rightIdentifier
            || rightIdentifier.Identifier.ValueText != leftIdentifier.Identifier.ValueText)
        {
            return;
        }

        if (!IsInsideLoop(assignment) || IsInsideExemptMethod(assignment))
        {
            return;
        }

        if (!IsStructSymbolBaseClassAccess(context, baseClassAccess))
        {
            return;
        }

        context.ReportDiagnostic(Diagnostic.Create(
            DiagnosticDescriptors.UnguardedBaseClassWalk,
            assignment.GetLocation(),
            leftIdentifier.Identifier.ValueText));
    }

    /// <summary>
    /// Returns the member-access node of a <c>.BaseClass</c> access — an
    /// ordinary <see cref="MemberAccessExpressionSyntax"/> for
    /// <c>x.BaseClass</c> — together with its receiver expression in
    /// <paramref name="receiver"/>. Returns <see langword="null"/> when
    /// <paramref name="expression"/> is not a <c>BaseClass</c> access at all.
    /// Deliberately does not also match a null-conditional <c>x?.BaseClass</c>
    /// (see the "Deliberately out of scope" remark on this type — issue
    /// #4173).
    /// </summary>
    private static ExpressionSyntax? GetBaseClassAccess(ExpressionSyntax expression, out ExpressionSyntax? receiver)
    {
        if (expression is MemberAccessExpressionSyntax memberAccess
            && memberAccess.Name.Identifier.ValueText == BaseClassPropertyName)
        {
            receiver = memberAccess.Expression;
            return memberAccess;
        }

        receiver = null;
        return null;
    }

    private static bool IsInsideLoop(SyntaxNode node)
    {
        for (var current = node; current != null; current = current.Parent)
        {
            if (current is ForStatementSyntax or WhileStatementSyntax or DoStatementSyntax)
            {
                return true;
            }

            // A loop body is its own scope boundary for this check: stop at
            // the innermost method/lambda/local-function so a `.BaseClass`
            // reassignment in an unrelated OUTER loop (with this assignment
            // living inside a nested function literal instead) is not
            // mistaken for being inside that outer loop.
            if (current is MethodDeclarationSyntax or LocalFunctionStatementSyntax
                or LambdaExpressionSyntax or AnonymousMethodExpressionSyntax)
            {
                return false;
            }
        }

        return false;
    }

    private static bool IsInsideExemptMethod(SyntaxNode node)
    {
        var method = node.FirstAncestorOrSelf<MethodDeclarationSyntax>();
        var type = method?.FirstAncestorOrSelf<TypeDeclarationSyntax>();
        if (method == null || type == null)
        {
            return false;
        }

        if (method.Identifier.ValueText == ExemptMethodName && type.Identifier.ValueText == StructSymbolTypeName)
        {
            // The one sanctioned implementation every other walk should call.
            return true;
        }

        if (method.Identifier.ValueText == ExemptDetectorMethodName && type.Identifier.ValueText == ExemptDetectorTypeName)
        {
            // DeclarationBinder.DetectClassInheritanceCycles() is the
            // post-bind cycle detector (#973) itself: it CANNOT be
            // rewritten to call GetHierarchy(), because it needs to
            // identify the exact back-edge node to break
            // (`current.SetBaseClass(null)`) and memoizes already-verified
            // acyclic nodes across the classes it walks — both are outside
            // what GetHierarchy()'s return value alone can express. It is
            // already independently guarded (`onPath`/`acyclic` sets).
            return true;
        }

        return false;
    }

    private static bool IsStructSymbolBaseClassAccess(SyntaxNodeAnalysisContext context, ExpressionSyntax baseClassAccess)
    {
        // Checked against the member SYMBOL rather than syntax alone so an
        // unrelated `.BaseClass` member on some other type is not mistaken
        // for this one (see IgnoresUnrelatedTypeNamedSimilarly). Accepts
        // either a property or a field: StructSymbol.BaseClass is a property
        // today, but nothing about this rule depends on that.
        var symbolInfo = context.SemanticModel.GetSymbolInfo(baseClassAccess, context.CancellationToken);
        var member = symbolInfo.Symbol;
        if (member == null
            || member.Name != BaseClassPropertyName
            || member is not (IPropertySymbol or IFieldSymbol))
        {
            return false;
        }

        return member.ContainingType?.Name == StructSymbolTypeName;
    }
}
