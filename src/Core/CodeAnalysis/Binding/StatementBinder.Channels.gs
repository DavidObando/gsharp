// <copyright file="StatementBinder.Channels.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import GSharp.Core.CodeAnalysis
import System.Threading

/// ADR-0174 D3: the statement-level channel surfaces. A receiver distinguishes
/// "closed" from "zero value" through the two-value receive
/// `let v, ok = <-ch`, loops until close with `while let v = <-ch`
/// or `for v in ch`, and every one of those lowers onto the existing tuple,
/// declaration, goto and label nodes around a single
/// `ChannelOps.Receive2<T>` call — no new bound node, no emitter change.
/// @remarks `while let v = <-ch` is recognized <em>syntactically</em> (a prefix
/// `<-` initializer) and bypasses ADR-0163's nullable-stripping
/// clause binder: the binding has the element type exactly, so
/// `chan[string?]` delivers a `nil` element to the body instead of
/// ending the loop. Clauses short-circuit in source order — a closed channel
/// in the first clause never receives from the second.
///
/// Discrimination witnesses (ADR-0154): a mutant that routes the channel
/// clause through (cref:IfLetBindingSupport.BindBindingClause) breaks
/// `Adr0174WhileLetChannelBindingTests.NullableElement_NilIsDelivered_NotTreatedAsClosed`;
/// a mutant that evaluates every clause before gating breaks
/// `Adr0174WhileLetChannelBindingTests.Clauses_ShortCircuit_InSourceOrder`;
/// a mutant that re-evaluates the `for … in` collection each iteration
/// breaks `Adr0174ForInChannelBindingTests.Collection_IsEvaluatedOnce`.
internal partial class StatementBinder {
    /// Binds the two-value receive `<-ch` as a `(T, bool)` tuple
    /// (`ChannelOps.Receive2<T>`), reporting the same operand
    /// diagnostics the single-value receive does.
    /// @param receive The receive syntax.
    /// @param elementType The channel's element type on success.
    /// @returns The tuple-typed call, or `null` after a reported error.
    private func BindTwoValueReceive(receive UnaryExpressionSyntax, out elementType TypeSymbol) BoundExpression? {
        elementType = TypeSymbol.Error
        var operand = bindExpression(receive.Operand, false)
        if operand is BoundErrorExpression || operand.Type == TypeSymbol.Error {
            return nil
        }
        // ADR-0186 §4: a receive requires a non-null channel — the same check
        // the single-value receive (`ExpressionBinder.BindChannelReceiveExpression`)
        // inserts, for `let (v, ok) = <-ch`, `while let` and `if let` alike.
        operand = binderCtx.InsertPlatformCheck(operand, receive.Operand.Location, "a channel receive operand")
        if !TryGetReceivableChannelShape(
            operand,
            receive.Operand.Location,
            receive.OperatorToken.Location,
            out elementType,
            out var direction
        ) {
            return nil
        }
        return binderCtx.ChannelRuntime.BindReceive2(
            receive,
            operand,
            elementType,
            direction,
            binderCtx.AmbientContext()
        )
    }

    /// Checks that [`channel`](paramref) is a channel-shaped handle one can
    /// receive from (ADR-0174 D2's matrix, not `out chan[T]`) and that the
    /// channel runtime is in the reference set.
    /// @param channel The bound operand.
    /// @param operandLocation Where a not-a-channel diagnostic is anchored.
    /// @param operatorLocation Where a direction or missing-runtime diagnostic is anchored.
    /// @param elementType The element type on success.
    /// @param direction The handle's direction on success.
    /// @returns `true` when a receive can be bound.
    private func TryGetReceivableChannelShape(
        channel BoundExpression,
        operandLocation TextLocation,
        operatorLocation TextLocation,
        out elementType TypeSymbol,
        out direction ChannelDirection
    ) bool {
        elementType = TypeSymbol.Error
        if !ChannelTypeSymbol.TryGetChannelShape(channel.Type, out var element, out direction, out _) ||
            element == nil {
            Diagnostics.ReportReceiveOperandIsNotChannel(operandLocation, channel.Type)
            return false
        }
        elementType = element
        if direction == ChannelDirection.Out {
            Diagnostics.ReportReceiveFromSendOnlyChannel(operatorLocation, channel.Type)
            return false
        }
        if !binderCtx.ChannelRuntime.IsAvailable {
            Diagnostics.ReportTargetFrameworkMemberUnavailable(operatorLocation, ChannelRuntimeBinder.ChanTypeName)
            return false
        }
        return true
    }

    /// Binds one `let v [T] = <-ch` clause of a `while let`. The
    /// binding keeps the element type (a `T?` element stays `T?`); the
    /// clause's gate is the receive's `ok` flag.
    /// @param binding The clause.
    /// @param receive The clause's `<-ch` initializer.
    /// @param enclosingScope The scope the initializer binds in.
    /// @param loopScope The scope the binding is declared in.
    /// @returns The declarations to run at the check label and the gate to test after them.
    private func BindWhileLetChannelClause(
        binding IfLetBindingClauseSyntax,
        receive UnaryExpressionSyntax,
        enclosingScope BoundScope,
        loopScope BoundScope
    ) WhileLetChannelClause {
        let savedScope = $scope
        $scope = BoundScope(enclosingScope)
        try {
            let declaredType TypeSymbol? = if binding.TypeClause != nil {
                bindTypeClause(binding.TypeClause)
            } else {
                default(TypeSymbol?)
            }
            let tupleValue BoundExpression? = BindTwoValueReceive(receive, out var elementType)
            if tupleValue == nil || tupleValue.Type is not TupleTypeSymbol tupleType {
                let errorVariable = DeclareWhileLetBinding(
                    loopScope,
                    binding.Identifier,
                    declaredType ?? TypeSymbol.Error
                )
                return WhileLetChannelClause(
                    ImmutableArray.Create[BoundStatement](
                        BoundVariableDeclaration(binding, errorVariable, BoundErrorExpression(nil))
                    ),
                    Gate: nil
                )
            }
            let (tupleTemp, elements) = CreateTupleDeconstructionPlan(binding.Initializer, tupleType)
            var value = elements[0]
            var variableType = elementType
            if declaredType != nil {
                value = conversions.BindConversion(binding.Initializer.Location, value, declaredType)
                variableType = declaredType
            }
            let variable = DeclareWhileLetBinding(loopScope, binding.Identifier, variableType)
            return WhileLetChannelClause(
                ImmutableArray.Create[BoundStatement](
                    BoundVariableDeclaration(binding, tupleTemp, tupleValue),
                    BoundVariableDeclaration(binding, variable, value)
                ),
                Gate: elements[1]
            )
        } finally {
            $scope = savedScope
        }
    }

    private func DeclareWhileLetBinding(loopScope BoundScope, identifier SyntaxToken, type TypeSymbol) VariableSymbol {
        let initializerScope = $scope
        $scope = loopScope
        try {
            return bindLocalVariable(identifier, true, type)
        } finally {
            $scope = initializerScope
        }
    }

    /// ADR-0174 D3: `for v in ch` drains a channel until it is closed. The
    /// collection is evaluated once into a hidden local; the loop then takes the
    /// `while let` shape around a two-value receive, so there is no new
    /// iteration kind and no emitter change.
    /// @param syntax The loop syntax.
    /// @param collection The already-bound channel-shaped collection.
    /// @param labelName The loop label, if any.
    /// @param originatingSyntax The syntax the lowered block is attributed to.
    /// @param bindLoopPrelude The tuple-target prelude hook (issue #1922).
    /// @returns The lowered loop.
    private func BindForInChannelStatement(
        syntax ForRangeStatementSyntax,
        collection BoundExpression,
        labelName string?,
        originatingSyntax SyntaxNode,
        bindLoopPrelude((VariableSymbol) -> ImmutableArray[BoundStatement])?
    ) BoundStatement {
        if syntax.SecondIdentifier != nil {
            Diagnostics.ReportChannelBindingTargetCount(
                syntax.SecondIdentifier.Location,
                "for value in ch",
                "one loop variable",
                2
            )
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        if !TryGetReceivableChannelShape(
            collection,
            syntax.Collection.Location,
            syntax.InToken.Location,
            out var elementType,
            out var direction
        ) {
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        // Lowers to:
        //   {
        //     let <chan> = collection
        //     goto checkLabel
        //     bodyLabel:
        //     <prelude> <body>
        //     continueLabel:
        //     checkLabel:
        //     let <tuple> = ChannelOps.Receive2(<chan>)
        //     let v = <tuple>.Item1
        //     if <tuple>.Item2 goto bodyLabel
        //     breakLabel:
        //   }
        let channelType = Invariant.Required(
            collection.Type,
            "a channel-shaped collection has a type",
            expression: "collection.Type"
        )
        let channelTemp = LocalVariableSymbol(
            "<forin${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
            isReadOnly: true,
            channelType
        )
        $scope.TryDeclareVariable(channelTemp)
        let tupleValue = binderCtx.ChannelRuntime.BindReceive2(
            syntax.Collection,
            BoundVariableExpression(nil, channelTemp),
            elementType,
            direction,
            binderCtx.AmbientContext()
        )
        let (tupleTemp, elements) = CreateTupleDeconstructionPlan(
            syntax.Collection,
            Invariant.Required(
                tupleValue.Type as TupleTypeSymbol,
                "a two-value receive is tuple-typed",
                expression: "tupleValue.Type as TupleTypeSymbol"
            )
        )
        $scope = BoundScope($scope)
        let valueVariable = bindLocalVariable(syntax.FirstIdentifier, false, elementType)
        let prelude = bindLoopPrelude?(valueVariable) ?? ImmutableArray[BoundStatement].Empty
        var body = BindLoopBody(syntax.Body, labelName, out var breakLabel, out var continueLabel)
        if !prelude.IsEmpty {
            body = BoundBlockStatement(originatingSyntax, prelude.Add(body))
        }
        $scope = $scope.Pop()
        let bodyLabel = BoundLabel("body${binderCtx.LabelCounter}")
        let checkLabel = BoundLabel("check${binderCtx.LabelCounter}")
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(BoundVariableDeclaration(syntax, channelTemp, collection))
        statements.Add(BoundGotoStatement(originatingSyntax, checkLabel))
        statements.Add(BoundLabelStatement(originatingSyntax, bodyLabel))
        statements.Add(body)
        statements.Add(BoundLabelStatement(originatingSyntax, continueLabel))
        statements.Add(BoundLabelStatement(originatingSyntax, checkLabel))
        statements.Add(BoundVariableDeclaration(syntax, tupleTemp, tupleValue))
        statements.Add(BoundVariableDeclaration(syntax, valueVariable, elements[0]))
        statements.Add(BoundConditionalGotoStatement(originatingSyntax, bodyLabel, elements[1], jumpIfTrue: true))
        statements.Add(BoundLabelStatement(originatingSyntax, breakLabel))
        return BoundBlockStatement(originatingSyntax, statements.ToImmutable())
    }

    /// One bound `while let` channel clause: its check-label declarations and its `ok` gate.
    /// @param Declarations The declarations run at the check label, in order.
    /// @param Gate The `ok` flag to test after the declarations; `null` after an error.
    private data struct WhileLetChannelClause(
        Declarations ImmutableArray[BoundStatement],
        Gate BoundExpression?
    ) : IEquatable[WhileLetChannelClause] { }

    shared {
        /// Recognizes the prefix-`<-` receive spelling. Only the bare unary
        /// counts: a parenthesized or otherwise wrapped receive is an ordinary
        /// expression and binds through the single-value path.
        /// @param syntax The candidate expression.
        /// @param receive The receive syntax when recognized.
        /// @returns `true` for `<-operand`.
        private func IsChannelReceiveSyntax(
            syntax ExpressionSyntax,
            @NotNullWhen(true) out receive UnaryExpressionSyntax?
        ) bool {
            if syntax is UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.LeftArrowToken}} unary {
                receive = unary
                return true
            }
            receive = nil
            return false
        }
    }
}
