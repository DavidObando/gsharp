// <copyright file="CallCandidateRecorder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection
import System.Threading

/// Collects the candidate sets that overload resolution considers while one call binds, so that the
/// bound call can carry them (ADR-0212 slice S4, `SemanticModel.GetMemberGroup`).
/// @remarks One frame per call being bound. The resolver stores a set it has already built, so no
/// candidate is copied during binding. A frame ends with the call: the call keeps the widest set that
/// holds a candidate of the called method's name, the later one on a tie. A probe (a lambda parameter
/// inference, a conversion operator search) names other methods or holds fewer candidates. A thread owns its frames, so parallel body binding needs no lock.
internal shared class CallCandidateRecorder {
    private let current ThreadLocal[Frame?] = ThreadLocal[Frame?]()

    /// Starts collecting for [`syntax`](paramref).
    /// @param syntax The call being bound.
    /// @returns The frame that (cref:End) closes.
    func Begin(syntax SyntaxNode) Frame {
        let frame = Frame(syntax, current.Value)
        current.Value = frame
        return frame
    }

    /// Stops collecting for [`frame`](paramref).
    /// @param frame The frame (cref:Begin) returned.
    func End(frame Frame) {
        current.Value = frame.Parent
    }

    /// Records the declared overloads a source selection considers.
    /// @param candidates The source functions.
    func RecordFunctions(candidates ImmutableArray[FunctionSymbol]) {
        let frame = current.Value
        if frame == nil || candidates.Length < 2 {
            return
        }
        let set = ImmutableArray.CreateBuilder[object](candidates.Length)
        for candidate in candidates {
            set.Add(candidate)
        }
        frame.Sets.Add(set.MoveToImmutable())
    }

    /// Records the reflected overloads an imported selection considers.
    /// @param candidates The reflected methods or constructors.
    func RecordMethods[T MethodBase](candidates IReadOnlyCollection[T]) {
        let frame = current.Value
        if frame == nil || candidates.Count < 2 {
            return
        }
        let set = ImmutableArray.CreateBuilder[object](candidates.Count)
        for candidate in candidates {
            set.Add(candidate)
        }
        frame.Sets.Add(set.MoveToImmutable())
    }

    /// Gives [`call`](paramref), or the call it wraps, the group [`frame`](paramref) recorded.
    /// @param frame The frame of the call.
    /// @param bound The expression the binder built for the call.
    func Stamp(frame Frame, bound BoundExpression) {
        if frame.Sets.Count == 0 {
            return
        }
        var node BoundExpression? = bound
        for var depth = 0; depth < 8 && node != nil; depth++ {
            // A suspending call wraps the user's invocation as its logical operand.
            if node.LogicalCompletionOperand is {} logical {
                node = logical
                continue
            }
            if node is BoundCallOperationExpression call {
                if call.MemberGroup.IsDefault {
                    call.MemberGroup = Select(frame, call.CalledFunction)
                }
                return
            }
            node = switch node {
                case conversion is BoundConversionExpression: conversion.Expression
                case block is BoundBlockExpression: block.Expression
                case unary is BoundUnaryExpression: unary.Operand
                default: default(BoundExpression?)
            }
        }
    }

    private func Select(frame Frame, called Symbol) ImmutableArray[object] {
        var best ImmutableArray[object] = default(ImmutableArray[object])
        for set in frame.Sets {
            if (best.IsDefault || set.Length >= best.Length) && ContainsCallee(set, called) {
                best = set
            }
        }
        return best
    }

    // A probe of an argument conversion or an inference holds other methods, so a set counts only when it
    // holds the called method itself.
    private func ContainsCallee(set ImmutableArray[object], called Symbol) bool {
        for candidate in set {
            if IsCallee(candidate, called) {
                return true
            }
        }
        return false
    }

    private func IsCallee(candidate object, called Symbol) bool {
        if candidate is FunctionSymbol function {
            return object.ReferenceEquals(function, called) ||
                (
                called is FunctionSymbol other && function.Declaration != nil && object.ReferenceEquals(
                    function.Declaration,
                    other.Declaration
                )
            )
        }
        if candidate is MethodBase method && called is ImportedFunctionSymbol imported {
            let target = imported.Method
            let left = if method is MethodInfo{IsGenericMethod: true} openLeft {
                openLeft.GetGenericMethodDefinition()
            } else {
                method
            }
            let right = if target.IsGenericMethod {
                target.GetGenericMethodDefinition()
            } else {
                cast[MethodBase](target)
            }
            return left.MetadataToken == right.MetadataToken && left.Module == right.Module && left.Name == right.Name
        }
        return false
    }

    /// The candidate sets of one call being bound.
    internal class Frame {
        init(syntax SyntaxNode, parent Frame?) {
            Syntax = syntax
            Parent = parent
            Sets = List[ImmutableArray[object]]()
        }

        prop Syntax SyntaxNode {
            get;
        }

        prop Parent Frame? {
            get;
        }

        prop Sets List[ImmutableArray[object]] {
            get;
        }
    }
}
