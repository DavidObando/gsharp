// <copyright file="BoundClrPropertyAccessExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Diagnostics.CodeAnalysis
import System.Reflection

/// Reads a public (cref:PropertyInfo) or (cref:FieldInfo) on a
/// CLR receiver. When (cref:Receiver) is `null`, the
/// member is static; otherwise it is dispatched against the instance
/// receiver. Examples: `lst.Count`, `sb.Length`, `kvp.Key`,
/// `Console.Out` (static, since Stream B).
class BoundClrPropertyAccessExpression : BoundPropertyReferenceOperationExpression {
    init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        member MemberInfo,
        resultType TypeSymbol,
        staticContainerType TypeSymbol? = nil,
        constrainedReceiverTypeParameter TypeParameterSymbol? = nil,
        constrainedInterfaceType TypeSymbol? = nil,
        isAddressableStaticField bool = false,
        isReadOnlySubmissionGlobal bool = false
    ) : base(syntax) {
        Receiver = receiver
        Member = member
        _type = resultType
        StaticContainerType = staticContainerType ?? MemberLookup.GetClrFieldReferenceContainer(receiver?.Type, member)
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter
        ConstrainedInterfaceType = constrainedInterfaceType
        IsAddressableStaticField = isAddressableStaticField
        IsReadOnlySubmissionGlobal = isReadOnlySubmissionGlobal
    }

    prop Receiver BoundExpression? {
        get;
    }

    prop Member MemberInfo {
        get;
    }

    /// Gets a value indicating whether this is a static (cref:FieldInfo)
    /// read whose storage the emitter may address in place (`ldsflda`) —
    /// ADR-0156 Phase 2 (issue #3185): a top-level global of a prior interactive
    /// submission, surfaced as a public static field on that submission's
    /// `<Program>` container. Member writes and mutating method calls
    /// through such a receiver mutate the stored global rather than a spilled
    /// copy, matching the same-cell global (`ldsflda`) semantics. Only ever
    /// set by the submission-import binding fallbacks, so non-REPL compilation
    /// paths are unaffected.
    prop IsAddressableStaticField bool {
        get;
    }

    /// Gets a value indicating whether the submission global behind
    /// (cref:IsAddressableStaticField) was declared read-only
    /// (`let`/`const`) in its source cell. The emitted field
    /// intentionally omits `InitOnly`, so the source-side flag is carried
    /// here for the binder's member-write rejection (mirroring issue #1132's
    /// read-only value-receiver rule for locals).
    prop IsReadOnlySubmissionGlobal bool {
        get;
    }

    /// Gets the symbolic constructed container used to parent a generic member
    /// reference. Covers static members such as
    /// `Comparer[TResult].Default` and inherited instance fields such as
    /// `Base[T].Value` reached through a symbolic derived receiver.
    /// `null` when no symbolic TypeSpec parent is needed.
    prop StaticContainerType TypeSymbol? {
        get;
    }

    /// Gets the type parameter used for constrained interface dispatch, if any.
    prop ConstrainedReceiverTypeParameter TypeParameterSymbol? {
        get;
    }

    /// Gets the imported interface that owns the constrained member reference, if any.
    prop ConstrainedInterfaceType TypeSymbol? {
        get;
    }

    /// Gets a value indicating whether this access dispatches through a type-parameter constraint.
    @MemberNotNullWhen(true, "ConstrainedReceiverTypeParameter")
    prop IsConstrainedTypeParameterAccess bool -> ConstrainedReceiverTypeParameter != nil

    private var _type TypeSymbol
    override prop Type TypeSymbol -> _type

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop ReferencedProperty Symbol? -> ImportedProperty(Member, Type)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Instance BoundExpression? -> Receiver

    override prop Kind BoundNodeKind -> BoundNodeKind.ClrPropertyAccessExpression
}
