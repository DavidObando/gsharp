// <copyright file="SideEffectAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis.Binding

/// Issue #452: classifies bound expressions by whether re-evaluating them
/// could produce an observable side effect or a different result. Used by
/// the (cref:SideEffectSpiller) lowering pass to decide which
/// sub-expressions inside a "duplicating context" (compound index /
/// property assignments, etc.) must be hoisted into a temp before the
/// emit phase walks them.
/// @remarks The analyzer is intentionally conservative: any expression whose kind
/// is not explicitly recognised as side-effect-free is reported as
/// side-effecting. This means the spiller may occasionally introduce a
/// redundant temp for an expression that is in fact pure, but it will
/// never miss an expression that could re-fire observable behaviour. The
/// IL optimizer / JIT can fold away redundant copies of variable reads at
/// no runtime cost.
///
/// "Side effect" here covers more than just method calls. It includes:
///
/// - Method / constructor / delegate invocations.
/// - Assignments (which themselves return the new value).
/// - Property reads (a user property getter can do anything).
/// - Indexer reads (a CLR or user indexer is also a property getter).
/// - `await` and yield-style suspensions.
/// - Allocations (`new T()`, struct literals) and array / map literals.
/// - Block / spill-sequence expressions (already contain effects).
/// - Anything the analyzer does not recognise.
internal shared class SideEffectAnalyzer {
    /// Returns `true` when re-evaluating [`expression`](paramref)
    /// could observably change program behaviour (i.e. it is unsafe to
    /// duplicate at an emit-time re-emission point without first spilling
    /// it to a temp).
    /// @param expression The expression to classify, or `null`
    /// for an absent optional operand such as a static access's receiver;
    /// a null expression evaluates nothing and so has no side effects.
    /// @returns `true` if the expression has observable side effects.
    func HasObservableSideEffect(expression BoundExpression?) bool {
        if expression == nil {
            return false
        }
        switch expression.Kind {
            case BoundNodeKind.LiteralExpression,
            BoundNodeKind.DefaultExpression,
            BoundNodeKind.TypeOfExpression,
            BoundNodeKind.SizeOfExpression,
            BoundNodeKind.FunctionPointerFromMethodExpression,
            BoundNodeKind.MethodGroupExpression,
            BoundNodeKind.ClrMethodGroupExpression,
            BoundNodeKind.ErrorExpression {
                return false
            }
            case BoundNodeKind.VariableExpression {
                return false
            }
            case BoundNodeKind.ConversionExpression {
                return HasObservableSideEffect((cast[BoundConversionExpression](expression)).Expression)
            }
            case BoundNodeKind.UnaryExpression {
                return HasObservableSideEffect((cast[BoundUnaryExpression](expression)).Operand)
            }
            case BoundNodeKind.BinaryExpression {
                {
                    let b = cast[BoundBinaryExpression](expression)
                    return HasObservableSideEffect(b.Left) || HasObservableSideEffect(b.Right)
                }
            }
            case BoundNodeKind.AddressOfExpression {
                return HasObservableSideEffect((cast[BoundAddressOfExpression](expression)).Operand)
            }
            case BoundNodeKind.ConditionalAddressExpression {
                {
                    // ADR-0061: conditional address-of is pure when all three
                    // sub-expressions are pure — the lowering is a CIL branch
                    // around two address-of forms, with no user-visible writes.
                    let ca = cast[BoundConditionalAddressExpression](expression)
                    return HasObservableSideEffect(ca.Condition) ||
                        HasObservableSideEffect(ca.WhenTrueOperand) ||
                        HasObservableSideEffect(ca.WhenFalseOperand)
                }
            }
            case BoundNodeKind.ConditionalExpression {
                {
                    // ADR-0062: a general ternary is pure when all three
                    // sub-expressions are pure — the lowering is a CIL branch
                    // around two value-producing arms.
                    let c = cast[BoundConditionalExpression](expression)
                    return HasObservableSideEffect(c.Condition) ||
                        HasObservableSideEffect(c.WhenTrue) ||
                        HasObservableSideEffect(c.WhenFalse)
                }
            }
            case BoundNodeKind.DereferenceExpression {
                return HasObservableSideEffect((cast[BoundDereferenceExpression](expression)).Operand)
            }
            case BoundNodeKind.FieldAccessExpression {
                {
                    let fa = cast[BoundFieldAccessExpression](expression)
                    return HasObservableSideEffect(fa.Receiver)
                }
            }
            case BoundNodeKind.TupleElementAccessExpression {
                {
                    let ta = cast[BoundTupleElementAccessExpression](expression)
                    return HasObservableSideEffect(ta.Receiver)
                }
            }
            case BoundNodeKind.LenExpression {
                return HasObservableSideEffect((cast[BoundLenExpression](expression)).Operand)
            }
            default {
                return true
            }
        }
    }
}
