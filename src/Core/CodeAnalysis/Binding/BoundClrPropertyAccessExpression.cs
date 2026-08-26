// <copyright file="BoundClrPropertyAccessExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Reads a public <see cref="PropertyInfo"/> or <see cref="FieldInfo"/> on a
/// CLR receiver. When <see cref="Receiver"/> is <see langword="null"/>, the
/// member is static; otherwise it is dispatched against the instance
/// receiver. Examples: <c>lst.Count</c>, <c>sb.Length</c>, <c>kvp.Key</c>,
/// <c>Console.Out</c> (static, since Stream B).
/// </summary>
public sealed class BoundClrPropertyAccessExpression : BoundExpression
{
    public BoundClrPropertyAccessExpression(
        SyntaxNode? syntax,
        BoundExpression? receiver,
        MemberInfo member,
        TypeSymbol resultType,
        TypeSymbol? staticContainerType = null,
        TypeParameterSymbol? constrainedReceiverTypeParameter = null,
        TypeSymbol? constrainedInterfaceType = null,
        bool isAddressableStaticField = false,
        bool isReadOnlySubmissionGlobal = false)
        : base(syntax)
    {
        Receiver = receiver;
        Member = member;
        Type = resultType;
        StaticContainerType = staticContainerType
            ?? MemberLookup.GetClrFieldReferenceContainer(receiver?.Type, member);
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter;
        ConstrainedInterfaceType = constrainedInterfaceType;
        IsAddressableStaticField = isAddressableStaticField;
        IsReadOnlySubmissionGlobal = isReadOnlySubmissionGlobal;
    }

    public BoundExpression? Receiver { get; }

    public MemberInfo Member { get; }

    /// <summary>
    /// Gets a value indicating whether this is a static <see cref="FieldInfo"/>
    /// read whose storage the emitter may address in place (<c>ldsflda</c>) —
    /// ADR-0156 Phase 2 (issue #3185): a top-level global of a prior interactive
    /// submission, surfaced as a public static field on that submission's
    /// <c>&lt;Program&gt;</c> container. Member writes and mutating method calls
    /// through such a receiver mutate the stored global rather than a spilled
    /// copy, matching the same-cell global (<c>ldsflda</c>) semantics. Only ever
    /// set by the submission-import binding fallbacks, so non-REPL compilation
    /// paths are unaffected.
    /// </summary>
    public bool IsAddressableStaticField { get; }

    /// <summary>
    /// Gets a value indicating whether the submission global behind
    /// <see cref="IsAddressableStaticField"/> was declared read-only
    /// (<c>let</c>/<c>const</c>) in its source cell. The emitted field
    /// intentionally omits <c>InitOnly</c>, so the source-side flag is carried
    /// here for the binder's member-write rejection (mirroring issue #1132's
    /// read-only value-receiver rule for locals).
    /// </summary>
    public bool IsReadOnlySubmissionGlobal { get; }

    /// <summary>
    /// Gets the symbolic constructed container used to parent a generic member
    /// reference. Covers static members such as
    /// <c>Comparer[TResult].Default</c> and inherited instance fields such as
    /// <c>Base[T].Value</c> reached through a symbolic derived receiver.
    /// <c>null</c> when no symbolic TypeSpec parent is needed.
    /// </summary>
    public TypeSymbol? StaticContainerType { get; }

    /// <summary>Gets the type parameter used for constrained interface dispatch, if any.</summary>
    public TypeParameterSymbol? ConstrainedReceiverTypeParameter { get; }

    /// <summary>Gets the imported interface that owns the constrained member reference, if any.</summary>
    public TypeSymbol? ConstrainedInterfaceType { get; }

    /// <summary>Gets a value indicating whether this access dispatches through a type-parameter constraint.</summary>
    [MemberNotNullWhen(true, nameof(ConstrainedReceiverTypeParameter))]
    public bool IsConstrainedTypeParameterAccess => ConstrainedReceiverTypeParameter != null;

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrPropertyAccessExpression;

    /// <summary>
    /// ADR-0156 Phase 2 (issue #3185): whether <paramref name="expression"/>
    /// is a pure, re-evaluable CLR field chain rooted at an addressable
    /// submission global — the root's static-field read plus zero or more
    /// <see cref="FieldInfo"/> links. Such a receiver must NOT be spilled to
    /// a temp by duplicating-context lowering: writes through it must reach
    /// the stored global's address, and re-reading a static field / field
    /// chain has no observable side effect. Never true outside the
    /// interactive submission gate (only the submission binder fallbacks set
    /// <see cref="IsAddressableStaticField"/>).
    /// </summary>
    /// <param name="expression">The candidate receiver expression.</param>
    /// <returns><see langword="true"/> for an addressable submission field chain.</returns>
    public static bool IsAddressableSubmissionFieldChain(BoundExpression expression)
    {
        while (expression is BoundClrPropertyAccessExpression access)
        {
            if (access.Receiver == null)
            {
                return access.IsAddressableStaticField;
            }

            if (access.Member is not FieldInfo)
            {
                return false;
            }

            expression = access.Receiver;
        }

        return false;
    }
}
