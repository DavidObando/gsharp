// <copyright file="ConditionalNotNullPostcondition.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2Gs.Translator;

/// <summary>
/// Issue #3802: recognises <c>[return: NotNullIfNotNull(nameof(p))]</c> at a
/// CALL SITE and hands back the argument the result's nullability is
/// FORWARDED from.
///
/// <para>
/// The BCL declares <c>Path.GetExtension</c>, <c>Path.GetFileName</c> and
/// <c>Path.ChangeExtension</c> as <c>string?</c> with that conditional
/// post-condition: the result is non-null whenever the named argument is.
/// Both nullability judgements in this assembly —
/// <c>ObliviousNullabilityAnalyzer.IsDirectlyNullable</c> and the
/// translator's <c>IsNullableInitializer</c> — end in the same fallback,
/// "consult the bound symbol's DECLARED annotation", which is right for a
/// plainly nullable member and wrong for a conditional one. Left alone it
/// promotes <c>string extension = Path.GetExtension(source)</c> to
/// <c>string?</c>, taints every iterator that yields such a value to
/// <c>sequence[string?]</c>, and sprays <c>!!</c> over the uses — which is
/// how <c>Cs2Gs.Pipeline</c>'s <c>RepositoryMirror</c> came out of migration
/// with a <c>string?</c> dictionary key gsc rightly rejected (GS0155).
/// </para>
///
/// <para>
/// The result is deliberately a FORWARDING EDGE rather than a "this is
/// non-null" verdict. gsc refuses to narrow a call whose argument it sees as
/// <c>T?</c>, and the argument's emitted type is decided by the same taint
/// fixpoint this feeds — so answering "non-null" from the argument's
/// syntactic C# shape alone makes the two layers disagree wherever the
/// fixpoint later promotes that argument. Oahu showed exactly that:
/// <c>Path.GetFileNameWithoutExtension(downloadFileName)</c> stayed
/// <c>string</c> while <c>downloadFileName</c> itself became <c>string?</c>.
/// Forwarding keeps the post-condition CONDITIONAL in both layers at once.
/// </para>
/// </summary>
internal static class ConditionalNotNullPostcondition
{
    private const string AttributeName = "NotNullIfNotNullAttribute";

    /// <summary>
    /// When <paramref name="expression"/> is a call to a method carrying
    /// <c>[return: NotNullIfNotNull(name)]</c>, hands back the argument bound
    /// to the named parameter — the expression the result's nullability is
    /// FORWARDED from.
    /// </summary>
    /// <param name="expression">The candidate expression.</param>
    /// <param name="getSymbol">
    /// The caller's symbol resolver. Passed rather than a
    /// <see cref="SemanticModel"/> because the translator routes lookups
    /// through a per-tree model.
    /// </param>
    /// <param name="forwarded">Receives the named argument.</param>
    /// <returns>Whether a forwarded argument was found.</returns>
    public static bool TryGetForwardedArgument(
        ExpressionSyntax expression,
        Func<ExpressionSyntax, ISymbol> getSymbol,
        out ExpressionSyntax forwarded)
    {
        forwarded = null;
        if (expression is not InvocationExpressionSyntax invocation || getSymbol == null)
        {
            return false;
        }

        if (getSymbol(invocation) is not IMethodSymbol method)
        {
            return false;
        }

        IReadOnlyList<string> names = NamedParameters(method);
        if (names.Count == 0)
        {
            return false;
        }

        // More than one name means "non-null if ANY of these is non-null", a
        // disjunction the caller's single-source forwarding cannot express;
        // leaving it alone keeps the conservative declared-`T?` answer. No BCL
        // member in the migration corpus carries more than one.
        if (names.Count > 1)
        {
            return false;
        }

        forwarded = ArgumentFor(invocation, method, names[0]);
        return forwarded != null;
    }

    // The parameter names carried by every `[return: NotNullIfNotNull]` on
    // the method. Read off the ORIGINAL DEFINITION so a constructed generic
    // or a reduced extension method still finds them.
    private static IReadOnlyList<string> NamedParameters(IMethodSymbol method)
    {
        IMethodSymbol definition = (method.ReducedFrom ?? method).OriginalDefinition;
        List<string> names = null;
        foreach (AttributeData attribute in definition.GetReturnTypeAttributes())
        {
            if (attribute.AttributeClass?.Name != AttributeName
                || attribute.ConstructorArguments.Length == 0)
            {
                continue;
            }

            if (attribute.ConstructorArguments[0].Value is string name)
            {
                (names ??= new List<string>()).Add(name);
            }
        }

        return (IReadOnlyList<string>)names ?? Array.Empty<string>();
    }

    // The argument expression bound to the parameter called <paramref
    // name="name"/>, honouring named arguments. Returns null when the
    // parameter is not supplied (an omitted optional argument defaults to
    // null far more often than not, so absence must never narrow).
    private static ExpressionSyntax ArgumentFor(
        InvocationExpressionSyntax invocation,
        IMethodSymbol method,
        string name)
    {
        IMethodSymbol definition = (method.ReducedFrom ?? method).OriginalDefinition;
        int index = -1;
        for (int i = 0; i < definition.Parameters.Length; i++)
        {
            if (string.Equals(definition.Parameters[i].Name, name, StringComparison.Ordinal))
            {
                index = i;
                break;
            }
        }

        if (index < 0)
        {
            return null;
        }

        // A reduced extension invocation (`value.Ext(x)`) drops the receiver
        // from the argument list, so the unreduced parameter positions are
        // one ahead of the syntactic arguments. The receiver itself is
        // parameter 0.
        if (method.ReducedFrom != null)
        {
            if (index == 0)
            {
                return (invocation.Expression as MemberAccessExpressionSyntax)?.Expression;
            }

            index--;
        }

        SeparatedSyntaxList<ArgumentSyntax> arguments = invocation.ArgumentList.Arguments;
        ArgumentSyntax named = arguments.FirstOrDefault(
            a => a.NameColon?.Name.Identifier.ValueText == name);
        if (named != null)
        {
            return named.Expression;
        }

        // Positional only up to the first named argument; past one, position
        // no longer identifies the parameter.
        if (index >= arguments.Count || arguments[index].NameColon != null)
        {
            return null;
        }

        return arguments[index].Expression;
    }
}
