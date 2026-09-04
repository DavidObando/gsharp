// <copyright file="StatementBinder.Channels.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using System;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0174 D3: the statement-level channel surfaces. A receiver distinguishes
/// "closed" from "zero value" through the two-value receive
/// <c>let v, ok = &lt;-ch</c>, loops until close with <c>while let v = &lt;-ch</c>
/// or <c>for v in ch</c>, and every one of those lowers onto the existing tuple,
/// declaration, goto and label nodes around a single
/// <c>ChannelOps.Receive2&lt;T&gt;</c> call — no new bound node, no emitter change.
/// </summary>
/// <remarks>
/// <para>
/// <c>while let v = &lt;-ch</c> is recognized <em>syntactically</em> (a prefix
/// <c>&lt;-</c> initializer) and bypasses ADR-0163's nullable-stripping
/// clause binder: the binding has the element type exactly, so
/// <c>chan[string?]</c> delivers a <c>nil</c> element to the body instead of
/// ending the loop. Clauses short-circuit in source order — a closed channel
/// in the first clause never receives from the second.
/// </para>
/// <para>
/// Discrimination witnesses (ADR-0154): a mutant that routes the channel
/// clause through <see cref="IfLetBindingSupport.BindBindingClause"/> breaks
/// <c>Adr0174WhileLetChannelBindingTests.NullableElement_NilIsDelivered_NotTreatedAsClosed</c>;
/// a mutant that evaluates every clause before gating breaks
/// <c>Adr0174WhileLetChannelBindingTests.Clauses_ShortCircuit_InSourceOrder</c>;
/// a mutant that re-evaluates the <c>for … in</c> collection each iteration
/// breaks <c>Adr0174ForInChannelBindingTests.Collection_IsEvaluatedOnce</c>.
/// </para>
/// </remarks>
internal sealed partial class StatementBinder
{
    /// <summary>
    /// Recognizes the prefix-<c>&lt;-</c> receive spelling. Only the bare unary
    /// counts: a parenthesized or otherwise wrapped receive is an ordinary
    /// expression and binds through the single-value path.
    /// </summary>
    /// <param name="syntax">The candidate expression.</param>
    /// <param name="receive">The receive syntax when recognized.</param>
    /// <returns><see langword="true"/> for <c>&lt;-operand</c>.</returns>
    private static bool IsChannelReceiveSyntax(ExpressionSyntax syntax, [NotNullWhen(true)] out UnaryExpressionSyntax? receive)
    {
        if (syntax is UnaryExpressionSyntax { OperatorToken.Kind: SyntaxKind.LeftArrowToken } unary)
        {
            receive = unary;
            return true;
        }

        receive = null;
        return false;
    }

    /// <summary>
    /// Binds the two-value receive <c>&lt;-ch</c> as a <c>(T, bool)</c> tuple
    /// (<c>ChannelOps.Receive2&lt;T&gt;</c>), reporting the same operand
    /// diagnostics the single-value receive does.
    /// </summary>
    /// <param name="receive">The receive syntax.</param>
    /// <param name="elementType">The channel's element type on success.</param>
    /// <returns>The tuple-typed call, or <see langword="null"/> after a reported error.</returns>
    private BoundExpression? BindTwoValueReceive(UnaryExpressionSyntax receive, out TypeSymbol elementType)
    {
        elementType = TypeSymbol.Error;
        var operand = bindExpression(receive.Operand);
        if (operand is BoundErrorExpression || operand.Type == TypeSymbol.Error)
        {
            return null;
        }

        if (!TryGetReceivableChannelShape(operand, receive.Operand.Location, receive.OperatorToken.Location, out elementType, out var direction))
        {
            return null;
        }

        return binderCtx.ChannelRuntime.BindReceive2(receive, operand, elementType, direction, binderCtx.AmbientContext());
    }

    /// <summary>
    /// Checks that <paramref name="channel"/> is a channel-shaped handle one can
    /// receive from (ADR-0174 D2's matrix, not <c>out chan[T]</c>) and that the
    /// channel runtime is in the reference set.
    /// </summary>
    /// <param name="channel">The bound operand.</param>
    /// <param name="operandLocation">Where a not-a-channel diagnostic is anchored.</param>
    /// <param name="operatorLocation">Where a direction or missing-runtime diagnostic is anchored.</param>
    /// <param name="elementType">The element type on success.</param>
    /// <param name="direction">The handle's direction on success.</param>
    /// <returns><see langword="true"/> when a receive can be bound.</returns>
    private bool TryGetReceivableChannelShape(
        BoundExpression channel,
        TextLocation operandLocation,
        TextLocation operatorLocation,
        out TypeSymbol elementType,
        out ChannelDirection direction)
    {
        elementType = TypeSymbol.Error;
        if (!ChannelTypeSymbol.TryGetChannelShape(channel.Type, out var element, out direction, out _) || element == null)
        {
            Diagnostics.ReportReceiveOperandIsNotChannel(operandLocation, channel.Type);
            return false;
        }

        elementType = element;

        if (direction == ChannelDirection.Out)
        {
            Diagnostics.ReportReceiveFromSendOnlyChannel(operatorLocation, channel.Type);
            return false;
        }

        if (!binderCtx.ChannelRuntime.IsAvailable)
        {
            Diagnostics.ReportTargetFrameworkMemberUnavailable(operatorLocation, ChannelRuntimeBinder.ChanTypeName);
            return false;
        }

        return true;
    }

    /// <summary>
    /// Binds one <c>let v [T] = &lt;-ch</c> clause of a <c>while let</c>. The
    /// binding keeps the element type (a <c>T?</c> element stays <c>T?</c>); the
    /// clause's gate is the receive's <c>ok</c> flag.
    /// </summary>
    /// <param name="binding">The clause.</param>
    /// <param name="receive">The clause's <c>&lt;-ch</c> initializer.</param>
    /// <param name="enclosingScope">The scope the initializer binds in.</param>
    /// <param name="loopScope">The scope the binding is declared in.</param>
    /// <returns>The declarations to run at the check label and the gate to test after them.</returns>
    private WhileLetChannelClause BindWhileLetChannelClause(
        IfLetBindingClauseSyntax binding,
        UnaryExpressionSyntax receive,
        BoundScope enclosingScope,
        BoundScope loopScope)
    {
        var savedScope = scope;
        scope = new BoundScope(enclosingScope);
        try
        {
            var declaredType = binding.TypeClause != null ? bindTypeClause(binding.TypeClause) : null;
            var tupleValue = BindTwoValueReceive(receive, out var elementType);
            if (tupleValue == null || tupleValue.Type is not TupleTypeSymbol tupleType)
            {
                var errorVariable = DeclareWhileLetBinding(loopScope, binding.Identifier, declaredType ?? TypeSymbol.Error);
                return new WhileLetChannelClause(
                    ImmutableArray.Create<BoundStatement>(new BoundVariableDeclaration(binding, errorVariable, new BoundErrorExpression(null))),
                    Gate: null);
            }

            var (tupleTemp, elements) = CreateTupleDeconstructionPlan(binding.Initializer, tupleType);
            var value = elements[0];
            var variableType = elementType;
            if (declaredType != null)
            {
                value = conversions.BindConversion(binding.Initializer.Location, value, declaredType);
                variableType = declaredType;
            }

            var variable = DeclareWhileLetBinding(loopScope, binding.Identifier, variableType);
            return new WhileLetChannelClause(
                ImmutableArray.Create<BoundStatement>(
                    new BoundVariableDeclaration(binding, tupleTemp, tupleValue),
                    new BoundVariableDeclaration(binding, variable, value)),
                Gate: elements[1]);
        }
        finally
        {
            scope = savedScope;
        }
    }

    private VariableSymbol DeclareWhileLetBinding(BoundScope loopScope, SyntaxToken identifier, TypeSymbol type)
    {
        var initializerScope = scope;
        scope = loopScope;
        try
        {
            return bindLocalVariable(identifier, isReadOnly: true, type);
        }
        finally
        {
            scope = initializerScope;
        }
    }

    /// <summary>
    /// ADR-0174 D3: <c>for v in ch</c> drains a channel until it is closed. The
    /// collection is evaluated once into a hidden local; the loop then takes the
    /// <c>while let</c> shape around a two-value receive, so there is no new
    /// iteration kind and no emitter change.
    /// </summary>
    /// <param name="syntax">The loop syntax.</param>
    /// <param name="collection">The already-bound channel-shaped collection.</param>
    /// <param name="labelName">The loop label, if any.</param>
    /// <param name="originatingSyntax">The syntax the lowered block is attributed to.</param>
    /// <param name="bindLoopPrelude">The tuple-target prelude hook (issue #1922).</param>
    /// <returns>The lowered loop.</returns>
    private BoundStatement BindForInChannelStatement(
        ForRangeStatementSyntax syntax,
        BoundExpression collection,
        string? labelName,
        SyntaxNode originatingSyntax,
        Func<VariableSymbol, ImmutableArray<BoundStatement>>? bindLoopPrelude)
    {
        if (syntax.SecondIdentifier != null)
        {
            Diagnostics.ReportChannelBindingTargetCount(syntax.SecondIdentifier.Location, "for value in ch", "one loop variable", 2);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        if (!TryGetReceivableChannelShape(collection, syntax.Collection.Location, syntax.InToken.Location, out var elementType, out var direction))
        {
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
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
        var channelType = Invariant.Required(collection.Type, "a channel-shaped collection has a type");
        var channelTemp = new LocalVariableSymbol(
            $"<forin{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>",
            isReadOnly: true,
            channelType);
        scope.TryDeclareVariable(channelTemp);
        var tupleValue = binderCtx.ChannelRuntime.BindReceive2(
            syntax.Collection,
            new BoundVariableExpression(null, channelTemp),
            elementType,
            direction,
            binderCtx.AmbientContext());
        var (tupleTemp, elements) = CreateTupleDeconstructionPlan(
            syntax.Collection,
            Invariant.Required(tupleValue.Type as TupleTypeSymbol, "a two-value receive is tuple-typed"));

        scope = new BoundScope(scope);
        var valueVariable = bindLocalVariable(syntax.FirstIdentifier, isReadOnly: false, type: elementType);
        var prelude = bindLoopPrelude?.Invoke(valueVariable) ?? ImmutableArray<BoundStatement>.Empty;
        var body = BindLoopBody(syntax.Body, labelName, out var breakLabel, out var continueLabel);
        if (!prelude.IsEmpty)
        {
            body = new BoundBlockStatement(originatingSyntax, prelude.Add(body));
        }

        scope = scope.Pop();

        var bodyLabel = new BoundLabel($"body{binderCtx.LabelCounter}");
        var checkLabel = new BoundLabel($"check{binderCtx.LabelCounter}");
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundVariableDeclaration(syntax, channelTemp, collection));
        statements.Add(new BoundGotoStatement(originatingSyntax, checkLabel));
        statements.Add(new BoundLabelStatement(originatingSyntax, bodyLabel));
        statements.Add(body);
        statements.Add(new BoundLabelStatement(originatingSyntax, continueLabel));
        statements.Add(new BoundLabelStatement(originatingSyntax, checkLabel));
        statements.Add(new BoundVariableDeclaration(syntax, tupleTemp, tupleValue));
        statements.Add(new BoundVariableDeclaration(syntax, valueVariable, elements[0]));
        statements.Add(new BoundConditionalGotoStatement(originatingSyntax, bodyLabel, elements[1], jumpIfTrue: true));
        statements.Add(new BoundLabelStatement(originatingSyntax, breakLabel));
        return new BoundBlockStatement(originatingSyntax, statements.ToImmutable());
    }

    /// <summary>One bound <c>while let</c> channel clause: its check-label declarations and its <c>ok</c> gate.</summary>
    /// <param name="Declarations">The declarations run at the check label, in order.</param>
    /// <param name="Gate">The <c>ok</c> flag to test after the declarations; <see langword="null"/> after an error.</param>
    private readonly record struct WhileLetChannelClause(ImmutableArray<BoundStatement> Declarations, BoundExpression? Gate);
}
