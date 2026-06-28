#nullable disable

// <copyright file="SideEffectAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Issue #452: classifies bound expressions by whether re-evaluating them
/// could produce an observable side effect or a different result. Used by
/// the <see cref="SideEffectSpiller"/> lowering pass to decide which
/// sub-expressions inside a "duplicating context" (compound index /
/// property assignments, etc.) must be hoisted into a temp before the
/// emit phase walks them.
/// </summary>
/// <remarks>
/// <para>
/// The analyzer is intentionally conservative: any expression whose kind
/// is not explicitly recognised as side-effect-free is reported as
/// side-effecting. This means the spiller may occasionally introduce a
/// redundant temp for an expression that is in fact pure, but it will
/// never miss an expression that could re-fire observable behaviour. The
/// IL optimizer / JIT can fold away redundant copies of variable reads at
/// no runtime cost.
/// </para>
/// <para>
/// "Side effect" here covers more than just method calls. It includes:
/// </para>
/// <list type="bullet">
///   <item>Method / constructor / delegate invocations.</item>
///   <item>Assignments (which themselves return the new value).</item>
///   <item>Property reads (a user property getter can do anything).</item>
///   <item>Indexer reads (a CLR or user indexer is also a property getter).</item>
///   <item><c>await</c> and yield-style suspensions.</item>
///   <item>Allocations (<c>new T()</c>, struct literals) and array / map literals.</item>
///   <item>Block / spill-sequence expressions (already contain effects).</item>
///   <item>Anything the analyzer does not recognise.</item>
/// </list>
/// </remarks>
internal static class SideEffectAnalyzer
{
    /// <summary>
    /// Returns <see langword="true"/> when re-evaluating <paramref name="expression"/>
    /// could observably change program behaviour (i.e. it is unsafe to
    /// duplicate at an emit-time re-emission point without first spilling
    /// it to a temp).
    /// </summary>
    /// <param name="expression">The expression to classify.</param>
    /// <returns><see langword="true"/> if the expression has observable side effects.</returns>
    public static bool HasObservableSideEffect(BoundExpression expression)
    {
        if (expression == null)
        {
            return false;
        }

        switch (expression.Kind)
        {
            // Pure terminal forms.
            case BoundNodeKind.LiteralExpression:
            case BoundNodeKind.DefaultExpression:
            case BoundNodeKind.TypeOfExpression:
            case BoundNodeKind.SizeOfExpression:
            case BoundNodeKind.FunctionPointerFromMethodExpression:
            case BoundNodeKind.MethodGroupExpression:
            case BoundNodeKind.ClrMethodGroupExpression:
            case BoundNodeKind.ErrorExpression:
                return false;

            // Variable reads are pure (load opcodes).
            case BoundNodeKind.VariableExpression:
                return false;

            // Conversions are pure when the source is pure (the conversion
            // itself just emits a value-typing opcode in nearly all cases —
            // a user-defined conversion goes through ClrConversionCallExpression
            // which is classified separately).
            case BoundNodeKind.ConversionExpression:
                return HasObservableSideEffect(((BoundConversionExpression)expression).Expression);

            // Unary operators on a pure operand are pure.
            case BoundNodeKind.UnaryExpression:
                return HasObservableSideEffect(((BoundUnaryExpression)expression).Operand);

            // Binary operators on pure operands are pure. Note: && / || in
            // the bound tree are still BoundBinaryExpression; the short-circuit
            // semantics matter to lowering, not to purity classification.
            case BoundNodeKind.BinaryExpression:
            {
                var b = (BoundBinaryExpression)expression;
                return HasObservableSideEffect(b.Left) || HasObservableSideEffect(b.Right);
            }

            // Address-of and dereference of a pure operand are pure
            // (they're just managed-pointer arithmetic).
            case BoundNodeKind.AddressOfExpression:
                return HasObservableSideEffect(((BoundAddressOfExpression)expression).Operand);
            case BoundNodeKind.ConditionalAddressExpression:
            {
                // ADR-0061: conditional address-of is pure when all three
                // sub-expressions are pure — the lowering is a CIL branch
                // around two address-of forms, with no user-visible writes.
                var ca = (BoundConditionalAddressExpression)expression;
                return HasObservableSideEffect(ca.Condition)
                    || HasObservableSideEffect(ca.WhenTrueOperand)
                    || HasObservableSideEffect(ca.WhenFalseOperand);
            }

            case BoundNodeKind.ConditionalExpression:
            {
                // ADR-0062: a general ternary is pure when all three
                // sub-expressions are pure — the lowering is a CIL branch
                // around two value-producing arms.
                var c = (BoundConditionalExpression)expression;
                return HasObservableSideEffect(c.Condition)
                    || HasObservableSideEffect(c.WhenTrue)
                    || HasObservableSideEffect(c.WhenFalse);
            }

            case BoundNodeKind.DereferenceExpression:
                return HasObservableSideEffect(((BoundDereferenceExpression)expression).Operand);

            // Field reads are pure when the receiver is pure. (Field writes
            // are FieldAssignmentExpression — that path always has side effects.)
            case BoundNodeKind.FieldAccessExpression:
            {
                var fa = (BoundFieldAccessExpression)expression;
                return HasObservableSideEffect(fa.Receiver);
            }

            // Tuple element access of a pure tuple is pure (it's just an
            // ldfld on the synthesised ValueTuple field).
            case BoundNodeKind.TupleElementAccessExpression:
            {
                var ta = (BoundTupleElementAccessExpression)expression;
                return HasObservableSideEffect(ta.Receiver);
            }

            // len / cap on a pure operand are pure (they read .Length / .Count
            // which are property getters but are conventionally idempotent).
            case BoundNodeKind.LenExpression:
                return HasObservableSideEffect(((BoundLenExpression)expression).Operand);
            case BoundNodeKind.CapExpression:
                return HasObservableSideEffect(((BoundCapExpression)expression).Operand);

            // Every other expression kind — calls, awaits, assignments,
            // property / indexer reads (which run user code), allocations
            // (struct literals, array creation, map literals, etc.),
            // blocks, spill sequences, interpolations, switch expressions,
            // null-conditional access (capture has side effects), event
            // subscriptions, channel ops, make-channel, etc. — is
            // classified as side-effecting. This is conservative: we'd
            // rather over-spill than miss a duplicated effect.
            default:
                return true;
        }
    }
}
