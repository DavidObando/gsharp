// <copyright file="RewriterClonePreservationAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace GSharp.InternalAnalyzers;

/// <summary>
/// Flags a <c>BoundTreeRewriter</c> override that reconstructs its node while
/// reading fewer of the node's members than the base rewriter reads.
/// </summary>
/// <remarks>
/// <para>
/// Bound nodes are discriminated unions over their constructors: a member that
/// one construction form omits (<c>InterfaceType</c> for an interface static
/// field access, <c>TargetExpression</c> for a narrowed index target,
/// <c>NarrowedType</c> for a smart-cast field read) is <em>silently</em> lost
/// when a rewriter rebuilds the node through a constructor that does not take
/// it. The result is not a failure at the rewrite site but a mis-parented
/// member reference much later, in the emitter.
/// </para>
/// <para>
/// <c>BoundTreeRewriter</c>'s own implementations branch on the discriminator
/// and reconstruct through the matching constructor. An override that
/// reconstructs the same node type therefore has to read at least the members
/// the base reads — if it does not, it is dropping one. That is the exact shape
/// of issues #1644 and #3333, which between them cost three miscompiles no test
/// caught, because a non-generic interface happens to resolve correctly either
/// way.
/// </para>
/// <para>
/// The check is deliberately a subset test rather than a constructor-matching
/// test: it needs no model of which constructor carries which member, it names
/// the dropped member, and it stays quiet for an override that only delegates
/// to <c>base</c> or returns the node unchanged. Reads reached through a helper
/// that takes the node are followed one level, so extracting a recurring union
/// invariant into a helper (as <c>Lowering/BoundNodeForm.cs</c> does) does not
/// trip it.
/// </para>
/// </remarks>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class RewriterClonePreservationAnalyzer : DiagnosticAnalyzer
{
    private const string RewriterBaseTypeName = "BoundTreeRewriter";

    /// <inheritdoc />
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; }
        = ImmutableArray.Create(DiagnosticDescriptors.RewriterCloneDropsMember);

    /// <inheritdoc />
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(AnalyzeMethod, SyntaxKind.MethodDeclaration);
    }

    private static void AnalyzeMethod(SyntaxNodeAnalysisContext context)
    {
        var declaration = (MethodDeclarationSyntax)context.Node;
        if (!declaration.Modifiers.Any(SyntaxKind.OverrideKeyword) || declaration.ParameterList.Parameters.Count != 1)
        {
            return;
        }

        if (context.SemanticModel.GetDeclaredSymbol(declaration, context.CancellationToken) is not IMethodSymbol method
            || method.Parameters.Length != 1
            || RewriterBase(method.ContainingType?.BaseType) == null)
        {
            return;
        }

        // Compare against the declaration on BoundTreeRewriter itself, not an
        // intermediate override: the base is the reference implementation.
        var root = RootOverride(method);
        if (root == null || root.ContainingType?.Name != RewriterBaseTypeName)
        {
            return;
        }

        var baseDeclaration = SourceDeclaration(root, context.CancellationToken);
        if (baseDeclaration == null || baseDeclaration.ParameterList.Parameters.Count != 1)
        {
            // The base is in metadata, not source: nothing to compare against.
            return;
        }

        var nodeType = method.Parameters[0].Type;
        if (!Rebuilds(declaration, nodeType.Name))
        {
            return;
        }

        // The base's own reads are collected syntactically -- it reads members
        // off the node directly, so no symbol resolution is needed there.
        var baseReads = CollectReads(
            baseDeclaration,
            baseDeclaration.ParameterList.Parameters[0].Identifier.ValueText,
            model: null,
            context.CancellationToken);

        // `var rewritten = (BoundX)base.RewriteX(node);` makes `rewritten` the
        // node's stand-in for the rest of the method, so reads off it count.
        var parameterName = declaration.ParameterList.Parameters[0].Identifier.ValueText;
        var overrideReads = new HashSet<string>(StringComparer.Ordinal);
        foreach (var name in Aliases(declaration, parameterName))
        {
            foreach (var read in CollectReads(declaration, name, context.SemanticModel, context.CancellationToken))
            {
                overrideReads.Add(read);
            }
        }

        // Only a member some construction form omits can be dropped silently.
        // A member every constructor requires cannot be: an override that does
        // not pass it is replacing the node with a different shape, which is a
        // visible design choice rather than a clone losing information.
        var formDependent = FormDependentMembers(nodeType);
        var dropped = baseReads
            .Where(name => !overrideReads.Contains(name) && formDependent.Contains(name))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();
        if (dropped.Count == 0)
        {
            return;
        }

        context.ReportDiagnostic(Diagnostic.Create(
            DiagnosticDescriptors.RewriterCloneDropsMember,
            declaration.Identifier.GetLocation(),
            method.ContainingType!.Name + "." + method.Name,
            nodeType.Name,
            string.Join(", node.", dropped),
            root.Name));
    }

    /// <summary>
    /// The members of <paramref name="nodeType"/> that depend on which
    /// construction form was used: a member some constructor or factory takes
    /// and another omits, or one whose parameter is optional. Those are exactly
    /// the members a rebuild can drop without the compiler noticing.
    /// </summary>
    private static HashSet<string> FormDependentMembers(ITypeSymbol nodeType)
    {
        var forms = nodeType.GetMembers()
            .OfType<IMethodSymbol>()
            .Where(candidate => candidate.MethodKind == MethodKind.Constructor
                || (candidate.IsStatic
                    && candidate.MethodKind == MethodKind.Ordinary
                    && SymbolEqualityComparer.Default.Equals(candidate.ReturnType, nodeType)))
            .ToList();

        var dependent = new HashSet<string>(StringComparer.Ordinal);
        if (forms.Count == 0)
        {
            return dependent;
        }

        foreach (var member in nodeType.GetMembers().OfType<IPropertySymbol>())
        {
            bool omitted = false, taken = false, optional = false;
            foreach (var form in forms)
            {
                var parameter = form.Parameters.FirstOrDefault(candidate =>
                    string.Equals(candidate.Name, member.Name, StringComparison.OrdinalIgnoreCase));
                if (parameter == null)
                {
                    omitted = true;
                }
                else
                {
                    taken = true;
                    optional |= parameter.IsOptional;
                }
            }

            if (taken && (omitted || optional))
            {
                dependent.Add(member.Name);
            }
        }

        return dependent;
    }

    /// <summary>
    /// The node parameter plus every local that stands in for it — a local
    /// initialized from <c>base.RewriteX(node)</c>, which is the idiomatic way
    /// to rewrite the children first and then inspect the result.
    /// </summary>
    private static IEnumerable<string> Aliases(MethodDeclarationSyntax declaration, string parameterName)
    {
        var names = new HashSet<string>(StringComparer.Ordinal) { parameterName };
        foreach (var declarator in declaration.DescendantNodes().OfType<VariableDeclaratorSyntax>())
        {
            var initializer = declarator.Initializer?.Value;
            if (initializer == null)
            {
                continue;
            }

            foreach (var invocation in initializer.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>())
            {
                if (invocation.Expression is MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax }
                    && invocation.ArgumentList.Arguments.Any(argument =>
                        argument.Expression is IdentifierNameSyntax identifier
                        && identifier.Identifier.ValueText == parameterName))
                {
                    names.Add(declarator.Identifier.ValueText);
                    break;
                }
            }
        }

        // `rewritten is BoundX narrowed` re-binds the same node under a new
        // name; two passes reach the pattern variables of pattern variables,
        // which is as deep as the rewriters go.
        for (var pass = 0; pass < 2; pass++)
        {
            foreach (var pattern in declaration.DescendantNodes().OfType<IsPatternExpressionSyntax>())
            {
                if (pattern.Expression is not IdentifierNameSyntax source || !names.Contains(source.Identifier.ValueText))
                {
                    continue;
                }

                foreach (var designation in pattern.Pattern.DescendantNodesAndSelf().OfType<SingleVariableDesignationSyntax>())
                {
                    names.Add(designation.Identifier.ValueText);
                }
            }
        }

        return names;
    }

    private static INamedTypeSymbol? RewriterBase(INamedTypeSymbol? type)
    {
        for (var current = type; current != null; current = current.BaseType)
        {
            if (current.Name == RewriterBaseTypeName)
            {
                return current;
            }
        }

        return null;
    }

    private static IMethodSymbol? RootOverride(IMethodSymbol method)
    {
        var current = method.OverriddenMethod;
        while (current?.OverriddenMethod != null)
        {
            current = current.OverriddenMethod;
        }

        return current;
    }

    private static MethodDeclarationSyntax? SourceDeclaration(IMethodSymbol method, CancellationToken cancellationToken)
    {
        foreach (var reference in method.DeclaringSyntaxReferences)
        {
            if (reference.GetSyntax(cancellationToken) is MethodDeclarationSyntax declaration)
            {
                return declaration;
            }
        }

        return null;
    }

    /// <summary>
    /// Whether the method constructs a value of the node's own type, either
    /// with <c>new</c> or through a static factory declared on that type.
    /// </summary>
    private static bool Rebuilds(MethodDeclarationSyntax declaration, string nodeTypeName)
    {
        foreach (var node in declaration.DescendantNodes())
        {
            switch (node)
            {
                case ObjectCreationExpressionSyntax creation when TypeNameOf(creation.Type) == nodeTypeName:
                    return true;

                // A static factory on the node type, e.g.
                // BoundFieldAssignmentExpression.WithExpressionReceiver(...).
                case InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax access }
                    when access.Expression is IdentifierNameSyntax owner && owner.Identifier.ValueText == nodeTypeName:
                    return true;
            }
        }

        return false;
    }

    private static string? TypeNameOf(TypeSyntax type) => type switch
    {
        IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
        QualifiedNameSyntax qualified => TypeNameOf(qualified.Right),
        GenericNameSyntax generic => generic.Identifier.ValueText,
        _ => null,
    };

    /// <summary>
    /// Every member name read off <paramref name="parameterName"/>. When
    /// <paramref name="model"/> is supplied, a call that passes the parameter
    /// on to a helper is followed one level, so reads inside the helper count.
    /// </summary>
    private static HashSet<string> CollectReads(
        MethodDeclarationSyntax declaration,
        string parameterName,
        SemanticModel? model,
        CancellationToken cancellationToken)
    {
        var reads = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in declaration.DescendantNodes())
        {
            switch (node)
            {
                // node.Member
                case MemberAccessExpressionSyntax access
                    when access.Expression is IdentifierNameSyntax target && target.Identifier.ValueText == parameterName:
                    reads.Add(access.Name.Identifier.ValueText);
                    break;

                // node is { Member: ... }
                case IsPatternExpressionSyntax pattern
                    when pattern.Expression is IdentifierNameSyntax target && target.Identifier.ValueText == parameterName:
                    AddPatternMembers(pattern.Pattern, reads);
                    break;

                // switch (node) { case { Member: ... } ... }
                case SwitchStatementSyntax switchStatement
                    when switchStatement.Expression is IdentifierNameSyntax target && target.Identifier.ValueText == parameterName:
                    foreach (var label in switchStatement.Sections.SelectMany(section => section.Labels).OfType<CasePatternSwitchLabelSyntax>())
                    {
                        AddPatternMembers(label.Pattern, reads);
                    }

                    break;

                // Helper(node) / Helper(x, node)
                case InvocationExpressionSyntax invocation when model != null:
                    FollowHelper(invocation, parameterName, model, reads, cancellationToken);
                    break;
            }
        }

        return reads;
    }

    private static void AddPatternMembers(PatternSyntax pattern, HashSet<string> reads)
    {
        foreach (var subpattern in pattern.DescendantNodesAndSelf().OfType<SubpatternSyntax>())
        {
            if (subpattern.ExpressionColon?.Expression is IdentifierNameSyntax name)
            {
                reads.Add(name.Identifier.ValueText);
            }
        }
    }

    /// <summary>
    /// Unions in the members a helper reads off the parameter it was handed.
    /// Only one level deep, and only through the model for the tree being
    /// analyzed -- the helper's body is then read syntactically.
    /// </summary>
    private static void FollowHelper(
        InvocationExpressionSyntax invocation,
        string parameterName,
        SemanticModel model,
        HashSet<string> reads,
        CancellationToken cancellationToken)
    {
        // `base.RewriteX(node)` is not a helper: delegating on one path does not
        // excuse dropping a member on the path that rebuilds.
        if (invocation.Expression is MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax })
        {
            return;
        }

        var arguments = invocation.ArgumentList.Arguments;
        var index = -1;
        for (var i = 0; i < arguments.Count; i++)
        {
            if (arguments[i].Expression is IdentifierNameSyntax argument && argument.Identifier.ValueText == parameterName)
            {
                index = i;
                break;
            }
        }

        if (index < 0
            || model.GetSymbolInfo(invocation, cancellationToken).Symbol is not IMethodSymbol target
            || index >= target.Parameters.Length)
        {
            return;
        }

        var helper = SourceDeclaration(target, cancellationToken);
        if (helper == null || helper.ParameterList.Parameters.Count <= index)
        {
            return;
        }

        foreach (var read in CollectReads(
            helper,
            helper.ParameterList.Parameters[index].Identifier.ValueText,
            model: null,
            cancellationToken))
        {
            reads.Add(read);
        }
    }
}
