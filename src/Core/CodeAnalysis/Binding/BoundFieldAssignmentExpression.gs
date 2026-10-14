// <copyright file="BoundFieldAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Writes a field on a struct held in a variable: `variable.Field = value`
/// (Phase 3.B.1). The receiver is either a simple variable reference or, after
/// closure-boxing lowering, an arbitrary expression (e.g. `boxLocal.Value`
/// for a boxed reference-type captured variable — issue #567).
class BoundFieldAssignmentExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundFieldAssignmentExpression)
    /// class for a field write through a variable receiver, or through no
    /// receiver at all when the field is static (issue #263 lowers a static
    /// auto-property assignment to this form with a null receiver).
    /// @param syntax The originating syntax, or `null` for synthesized nodes.
    /// @param receiver The receiver variable, or `null` for a static field.
    /// @param structType The declaring struct/class type.
    /// @param field The field to write.
    /// @param value The value to assign.
    /// @param resultType The substituted assignment result type, or null.
    init(
        syntax SyntaxNode?,
        receiver VariableSymbol?,
        structType StructSymbol,
        field FieldSymbol,
        value BoundExpression,
        resultType TypeSymbol? = nil
    ) : base(syntax) {
        Receiver = receiver
        StructType = structType
        Field = field
        Value = value
        ResultType = resultType
    }

    /// Initializes a new instance of the (cref:BoundFieldAssignmentExpression)
    /// class for an interface static field write (ADR-0089 / issue #1030). The
    /// declaring (cref:StructType) is `null`; (cref:InterfaceType)
    /// records the owning interface (definition or constructed) so the emitter can
    /// route generic-interface field references through a `TypeSpec` and the
    /// interpreter can key static storage per closed construction.
    /// @param syntax The originating syntax, or `null` for synthesized nodes.
    /// @param field The interface static field to write.
    /// @param interfaceType The owning interface (definition or constructed).
    /// @param value The value to assign.
    /// @param resultType Construction-substituted assignment result type.
    init(
        syntax SyntaxNode?,
        field FieldSymbol,
        interfaceType InterfaceSymbol,
        value BoundExpression,
        resultType TypeSymbol? = nil
    ) : base(syntax) {
        Receiver = nil
        StructType = nil
        Field = field
        InterfaceType = interfaceType
        Value = value
        ResultType = resultType
    }

    private init(
        syntax SyntaxNode?,
        receiverExpression BoundExpression,
        structType StructSymbol,
        field FieldSymbol,
        value BoundExpression,
        resultType TypeSymbol?
    ) : base(syntax) {
        ReceiverExpression = receiverExpression
        StructType = structType
        Field = field
        Value = value
        ResultType = resultType
    }

    prop Receiver VariableSymbol? {
        get;
    }

    /// Gets the expression-based receiver, or `null` when the simple
    /// (cref:Receiver) variable form is used. When non-null, the
    /// emitter evaluates this expression to produce the instance reference
    /// instead of loading (cref:Receiver).
    prop ReceiverExpression BoundExpression? {
        get;
    }

    prop StructType StructSymbol? {
        get;
    }

    /// Gets the owning interface for an interface static field write (ADR-0089 /
    /// issue #1030), or `null` for a struct/class field. When non-null and
    /// it is a generic-interface reference, the emitter resolves the field via a
    /// `TypeSpec`-parented MemberRef; the interpreter keys static storage by
    /// this symbol so each closed construction has independent storage.
    prop InterfaceType InterfaceSymbol? {
        get;
    }

    prop Field FieldSymbol {
        get;
    }

    prop Value BoundExpression {
        get;
    }

    prop ResultType TypeSymbol? {
        get;
    }

    override prop Type TypeSymbol -> ResultType ?? Field.Type
    override prop Kind BoundNodeKind -> BoundNodeKind.FieldAssignmentExpression

    shared {
        /// Creates a field assignment with an expression-based receiver. Used
        /// after closure-boxing lowering when the original receiver local has
        /// been replaced by a field access through a box (issue #567).
        /// @param syntax The originating syntax, or `null` for synthesized nodes.
        /// @param receiverExpression The expression that produces the instance reference.
        /// @param structType The declaring struct/class type.
        /// @param field The field to write.
        /// @param value The value to assign.
        /// @param resultType The substituted assignment result type, or null.
        /// @returns A new (cref:BoundFieldAssignmentExpression) with an expression receiver.
        func WithExpressionReceiver(
            syntax SyntaxNode?,
            receiverExpression BoundExpression,
            structType StructSymbol,
            field FieldSymbol,
            value BoundExpression,
            resultType TypeSymbol? = nil
        ) BoundFieldAssignmentExpression {
            return BoundFieldAssignmentExpression(syntax, receiverExpression, structType, field, value, resultType)
        }
    }
}
