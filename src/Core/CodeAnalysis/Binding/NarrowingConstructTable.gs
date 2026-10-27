// <copyright file="NarrowingConstructTable.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic

/// How one kind of bound node changes the narrowing state (ADR-0208
/// section 8, construct table).
internal enum NarrowingEffectClass {
    /// The node changes nothing by itself. Its children do.
    None,
    /// Removes every path on the root that it writes.
    RootWrite,
    /// Removes every member-bearing path and every fact on the alias class.
    MemberWrite,
    /// Removes every mutable root.
    PointerWrite,
    /// Puts the operand's root in the alias class.
    Alias,
    /// Runs code that the binder cannot see. It removes every member-bearing
    /// path and every fact on the indirect-write class.
    Call,
    /// One successor. Records the state on the target and ends the path.
    Jump,
    /// Two successors. Never ends the path by itself.
    ConditionalJump,
    /// Merges the exit states of its branches.
    Join,
    /// Binds under the lower bound of its region (loops, handlers).
    Region,
    /// Binds its body under the closure-entry state.
    Closure
}

/// The closed construct table of ADR-0208 section 8. Each concrete
/// (cref:BoundNode) type has one entry. A type that the table does not list has
/// the effect `Call`, the conservative default. A test in Core.Tests
/// enumerates every concrete `BoundNode` type of the assembly against this
/// table, so a new kind cannot be added without choosing its effect.
/// @remarks Some kinds have two effects, which depend on facts that the type
/// does not carry. The table gives the more destructive one. Examples:
/// (cref:BoundConversionExpression) is `Call` because a conversion can be
/// user-defined, and (cref:BoundPropertyAssignmentExpression) is `MemberWrite`
/// while a setter with user code is also a `Call`. The post-lowering kinds
/// (spill sequences and state-machine helpers) never reach the binder walkers
/// and are `Call`. (cref:BoundBinaryExpression) is `Join` because it carries
/// `&&`, `||` and `??`.
internal shared class NarrowingConstructTable {
    private let effects Dictionary[string, NarrowingEffectClass] = Build()

    /// Gets the effect class of a bound node type name. Returns `Call` for a
    /// name that the table does not list.
    func Lookup(typeName string) NarrowingEffectClass {
        return if effects.TryGetValue(typeName, out var effectClass) {
            effectClass
        } else {
            NarrowingEffectClass.Call
        }
    }

    /// Whether the table lists [`typeName`](paramref) explicitly.
    func IsListed(typeName string) bool -> effects.ContainsKey(typeName)

    /// Gets the listed type names, sorted in ordinal order.
    func ListedNames()[]string {
        let names = List[string](effects.Keys)
        names.Sort(StringComparer.Ordinal)
        return names.ToArray()
    }

    /// Gets the effect class of a bound node.
    func Lookup(node BoundNode) NarrowingEffectClass -> Lookup(node.GetType().Name)

    private func Add(table Dictionary[string, NarrowingEffectClass], effectClass NarrowingEffectClass, names[]string) {
        for name in names {
            table.Add(name, effectClass)
        }
    }

    private func Build() Dictionary[string, NarrowingEffectClass] {
        let table = Dictionary[string, NarrowingEffectClass]()
        Add(
            table,
            NarrowingEffectClass.None,
            []string{
                "BoundArrayCreationExpression",
                "BoundAsExpression",
                "BoundAttribute",
                "BoundAwaitSequencePoint",
                "BoundBinaryPattern",
                "BoundBlockExpression",
                "BoundBlockStatement",
                "BoundDefaultExpression",
                "BoundDiscardPattern",
                "BoundErrorExpression",
                "BoundExpressionStatement",
                "BoundFieldAccessExpression",
                "BoundFunctionPointerFromMethodExpression",
                "BoundIndexExpression",
                "BoundIsExpression",
                "BoundLabelStatement",
                "BoundLenExpression",
                "BoundLiteralExpression",
                "BoundLocalFunctionDeclaration",
                "BoundMapLiteralExpression",
                "BoundNotPattern",
                "BoundPropertyPatternField",
                "BoundSizeOfExpression",
                "BoundTupleElementAccessExpression",
                "BoundTupleLiteralExpression",
                "BoundTypeOfExpression",
                "BoundTypePattern",
                "BoundUnaryExpression",
                "BoundUtf8StringExpression",
                "BoundVariableExpression"
            }
        )
        Add(table, NarrowingEffectClass.RootWrite, []string{"BoundAssignmentExpression", "BoundVariableDeclaration"})
        Add(
            table,
            NarrowingEffectClass.MemberWrite,
            []string{
                "BoundClrIndexAssignmentExpression",
                "BoundClrPropertyAssignmentExpression",
                "BoundFieldAssignmentExpression",
                "BoundIndexAssignmentExpression",
                "BoundPropertyAssignmentExpression"
            }
        )
        Add(
            table,
            NarrowingEffectClass.PointerWrite,
            []string{"BoundDereferenceExpression", "BoundIndirectAssignmentExpression"}
        )
        Add(
            table,
            NarrowingEffectClass.Alias,
            []string{
                "BoundAddressOfExpression",
                "BoundConditionalAddressExpression",
                "BoundFixedStatement",
                "BoundManagedFieldKeyExpression",
                "BoundManagedReferenceExpression",
                "BoundStackAllocExpression"
            }
        )
        Add(
            table,
            NarrowingEffectClass.Call,
            []string{
                "BoundAwaitExpression",
                "BoundAwaitForRangeStatement",
                "BoundBaseClassCallExpression",
                "BoundBaseInterfaceCallExpression",
                "BoundCallExpression",
                "BoundClrBinaryOperatorExpression",
                "BoundClrConstructorCallExpression",
                "BoundClrConversionCallExpression",
                "BoundClrEventSubscriptionExpression",
                "BoundClrIndexExpression",
                "BoundClrMethodGroupExpression",
                "BoundClrPropertyAccessExpression",
                "BoundClrStaticCallExpression",
                "BoundClrUnaryOperatorExpression",
                "BoundConstantPattern",
                "BoundConstrainedStaticCallExpression",
                "BoundConstructorCallExpression",
                "BoundConstructorChainingExpression",
                "BoundConversionExpression",
                "BoundEventSubscriptionExpression",
                "BoundForRangeStatement",
                "BoundFunctionPointerInvocationExpression",
                "BoundGoStatement",
                "BoundImportedCallExpression",
                "BoundImportedInstanceCallExpression",
                "BoundIndirectCallExpression",
                "BoundInterpolatedStringExpression",
                "BoundListPattern",
                "BoundMethodGroupExpression",
                "BoundPropertyAccessExpression",
                "BoundPropertyPattern",
                "BoundRelationalPattern",
                "BoundSlicePattern",
                "BoundSpillSequenceExpression",
                "BoundStateMachineAwaitOnCompleted",
                "BoundStateMachineBuilderMoveNext",
                "BoundStructLiteralExpression",
                "BoundTypeParameterConstructionExpression",
                "BoundUserInstanceCallExpression",
                "BoundYieldStatement"
            }
        )
        Add(
            table,
            NarrowingEffectClass.Jump,
            []string{
                "BoundGotoStatement",
                "BoundRethrowStatement",
                "BoundReturnStatement",
                "BoundThrowExpression",
                "BoundThrowStatement"
            }
        )
        Add(table, NarrowingEffectClass.ConditionalJump, []string{"BoundConditionalGotoStatement"})
        Add(
            table,
            NarrowingEffectClass.Join,
            []string{
                "BoundBinaryExpression",
                "BoundConditionalExpression",
                "BoundIfStatement",
                "BoundNullConditionalAccessExpression",
                "BoundPatternSwitchArm",
                "BoundPatternSwitchStatement",
                "BoundSwitchExpression",
                "BoundSwitchExpressionArm"
            }
        )
        Add(
            table,
            NarrowingEffectClass.Region,
            []string{"BoundForEllipsisStatement", "BoundForInfiniteStatement", "BoundTryStatement"}
        )
        Add(table, NarrowingEffectClass.Closure, []string{"BoundFunctionLiteralExpression"})
        return table
    }
}
