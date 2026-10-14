// <copyright file="BoundClrPropertyAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Diagnostics.CodeAnalysis
import System.Reflection

/// Writes a public (cref:PropertyInfo) or (cref:FieldInfo) on a
/// CLR receiver. When (cref:Receiver) is `null`, the
/// member is static; otherwise it is an instance member dispatched against
/// the receiver. Stream B parity for imported-type member writes; mirrors the
/// read-only (cref:BoundClrPropertyAccessExpression).
class BoundClrPropertyAssignmentExpression : BoundExpression {
    init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        member MemberInfo,
        value BoundExpression,
        resultType TypeSymbol,
        staticContainerType TypeSymbol?,
        constrainedReceiverTypeParameter TypeParameterSymbol? = nil,
        constrainedInterfaceType TypeSymbol? = nil
    ) : base(syntax) {
        Receiver = receiver
        Member = member
        Value = value
        _type = resultType
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter
        ConstrainedInterfaceType = constrainedInterfaceType
        StaticContainerType = staticContainerType ?? MemberLookup.GetClrFieldReferenceContainer(receiver?.Type, member)
    }

    /// Gets the receiver, or `null` when the member is
    /// static -- see the remarks on this type.
    prop Receiver BoundExpression? {
        get;
    }

    prop Member MemberInfo {
        get;
    }

    prop Value BoundExpression {
        get;
    }

    prop ConstrainedReceiverTypeParameter TypeParameterSymbol? {
        get;
    }

    prop ConstrainedInterfaceType TypeSymbol? {
        get;
    }

    /// Gets the symbolic declaring type used to parent a generic
    /// static or instance field reference, or `null` when no TypeSpec
    /// parent is needed.
    prop StaticContainerType TypeSymbol? {
        get;
    }

    @MemberNotNullWhen(true, "ConstrainedReceiverTypeParameter")
    prop IsConstrainedTypeParameterAccess bool -> ConstrainedReceiverTypeParameter != nil

    private var _type TypeSymbol
    override prop Type TypeSymbol -> _type
    override prop Kind BoundNodeKind -> BoundNodeKind.ClrPropertyAssignmentExpression
}
