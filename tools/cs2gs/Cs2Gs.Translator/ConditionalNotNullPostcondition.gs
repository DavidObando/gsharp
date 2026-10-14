// <copyright file="ConditionalNotNullPostcondition.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.Linq

/// Issue #3802: recognises `[return: NotNullIfNotNull(nameof(p))]` at a
/// CALL SITE and hands back the argument the result's nullability is
/// FORWARDED from.
///
/// The BCL declares `Path.GetExtension`, `Path.GetFileName` and
/// `Path.ChangeExtension` as `string?` with that conditional
/// post-condition: the result is non-null whenever the named argument is.
/// Both nullability judgements in this assembly —
/// `ObliviousNullabilityAnalyzer.IsDirectlyNullable` and the
/// translator's `IsNullableInitializer` — end in the same fallback,
/// "consult the bound symbol's DECLARED annotation", which is right for a
/// plainly nullable member and wrong for a conditional one. Left alone it
/// promotes `string extension = Path.GetExtension(source)` to
/// `string?`, taints every iterator that yields such a value to
/// `sequence[string?]`, and sprays `!!` over the uses — which is
/// how `Cs2Gs.Pipeline`'s `RepositoryMirror` came out of migration
/// with a `string?` dictionary key gsc rightly rejected (GS0155).
///
/// The result is deliberately a FORWARDING EDGE rather than a "this is
/// non-null" verdict. gsc refuses to narrow a call whose argument it sees as
/// `T?`, and the argument's emitted type is decided by the same taint
/// fixpoint this feeds — so answering "non-null" from the argument's
/// syntactic C# shape alone makes the two layers disagree wherever the
/// fixpoint later promotes that argument. Oahu showed exactly that:
/// `Path.GetFileNameWithoutExtension(downloadFileName)` stayed
/// `string` while `downloadFileName` itself became `string?`.
/// Forwarding keeps the post-condition CONDITIONAL in both layers at once.
internal shared class ConditionalNotNullPostcondition {
    private const AttributeName string = "NotNullIfNotNullAttribute"

    /// When [`expression`](paramref) is a call to a method carrying
    /// `[return: NotNullIfNotNull(name)]`, hands back the argument bound
    /// to the named parameter — the expression the result's nullability is
    /// FORWARDED from.
    /// @param expression The candidate expression.
    /// @param getSymbol The caller's symbol resolver. Passed rather than a
    /// (cref:SemanticModel) because the translator routes lookups
    /// through a per-tree model.
    /// @param forwarded Receives the named argument.
    /// @returns Whether a forwarded argument was found.
    func TryGetForwardedArgument(
        expression ExpressionSyntax,
        getSymbol((ExpressionSyntax) -> ISymbol?)?,
        out forwarded ExpressionSyntax?
    ) bool {
        forwarded = nil
        if expression is not InvocationExpressionSyntax invocation || getSymbol == nil {
            return false
        }
        if getSymbol(invocation) is not IMethodSymbol method {
            return false
        }
        let names = NamedParameters(method)
        if names.Count == 0 {
            return false
        }
        // More than one name means "non-null if ANY of these is non-null", a
        // disjunction the caller's single-source forwarding cannot express;
        // leaving it alone keeps the conservative declared-`T?` answer. No BCL
        // member in the migration corpus carries more than one.
        if names.Count > 1 {
            return false
        }
        forwarded = ArgumentFor(invocation, method, names[0])
        return forwarded != nil
    }

    // The parameter names carried by every `[return: NotNullIfNotNull]` on
    // the method. Read off the ORIGINAL DEFINITION so a constructed generic
    // or a reduced extension method still finds them.
    private func NamedParameters(method IMethodSymbol) IReadOnlyList[string] {
        let definition = (method.ReducedFrom ?? method).OriginalDefinition
        var names List[string]? = nil
        for attribute in definition.GetReturnTypeAttributes() {
            if attribute.AttributeClass?.Name != AttributeName || attribute.ConstructorArguments.Length == 0 {
                continue
            }
            if attribute.ConstructorArguments[0].Value is string name {
                (
                    (
                        if names == nil {
                            (names = List[string]())
                        } else {
                            names
                        }
                    )!!
                ).Add(name)
            }
        }
        if names == nil {
            return Array.Empty[string]()
        }
        return names
    }

    // The argument expression bound to the parameter called <paramref
    // name="name"/>, honouring named arguments. Returns null when the
    // parameter is not supplied (an omitted optional argument defaults to
    // null far more often than not, so absence must never narrow).
    private func ArgumentFor(
        invocation InvocationExpressionSyntax,
        method IMethodSymbol,
        name string
    ) ExpressionSyntax? {
        let definition = (method.ReducedFrom ?? method).OriginalDefinition
        var index = -1
        for var i = 0; i < definition.Parameters.Length; i++ {
            if string.Equals(definition.Parameters[i].Name, name, StringComparison.Ordinal) {
                index = i
                break
            }
        }
        if index < 0 {
            return nil
        }
        // A reduced extension invocation (`value.Ext(x)`) drops the receiver
        // from the argument list, so the unreduced parameter positions are
        // one ahead of the syntactic arguments. The receiver itself is
        // parameter 0.
        if method.ReducedFrom != nil {
            if index == 0 {
                return (invocation.Expression as MemberAccessExpressionSyntax)?.Expression
            }
            index--
        }
        let arguments = invocation.ArgumentList.Arguments
        let named ArgumentSyntax? = arguments.FirstOrDefault(
            (a ArgumentSyntax) -> a.NameColon?.Name.Identifier.ValueText == name
        )
        if named != nil {
            return named.Expression
        }
        // Positional only up to the first named argument; past one, position
        // no longer identifies the parameter.
        if index >= arguments.Count || arguments[index].NameColon != nil {
            return nil
        }
        return arguments[index].Expression
    }
}
