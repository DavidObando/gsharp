// <copyright file="CallCandidateRecorder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Concurrent
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
    private let currentBodyFailedCalls ThreadLocal[List[BoundErrorExpression]?] = ThreadLocal[
        List[BoundErrorExpression]?
    ]()
    internal let enabled AsyncLocal[bool] = AsyncLocal[bool]()
    private let currentFailedCalls AsyncLocal[ConcurrentDictionary[SyntaxNode, BoundErrorExpression]?] = AsyncLocal[
        ConcurrentDictionary[SyntaxNode, BoundErrorExpression]?
    ]()

    /// Starts collecting failed-call records for a cacheable member body when recording is enabled.
    func BeginBody() List[BoundErrorExpression]? {
        let previous = currentBodyFailedCalls.Value
        currentBodyFailedCalls.Value = if enabled.Value {
            List[BoundErrorExpression]()
        } else {
            default(List[BoundErrorExpression]?)
        }
        return previous
    }

    /// Ends collecting failed-call records for a member body and returns the recorded entries.
    func EndBody(previous List[BoundErrorExpression]?) ImmutableArray[BoundErrorExpression] {
        let collected = currentBodyFailedCalls.Value
        currentBodyFailedCalls.Value = previous
        return if collected == nil || collected.Count == 0 {
            ImmutableArray[BoundErrorExpression].Empty
        } else {
            collected.ToImmutableArray()
        }
    }

    /// Replays the failed-call records of a reused cached body into the active compilation's table.
    func ReplayFailedCalls(failedCalls ImmutableArray[BoundErrorExpression]) {
        if !enabled.Value || failedCalls.IsDefaultOrEmpty || currentFailedCalls.Value is not{} table {
            return
        }
        for error in failedCalls {
            if error.CallSyntax is {} callSyntax {
                table[callSyntax] = error
            }
        }
    }

    /// Turns recording on for the binding that runs in the returned scope, workers included. Only a
    /// compilation made for the semantic model asks for it, so `gsc` allocates nothing here.
    /// @param record Whether to record.
    /// @param failedCalls The owning compilation's failed-call table, when entering a compilation bind.
    /// @returns The scope to dispose when the binding ends.
    func Enter(record bool, failedCalls ConcurrentDictionary[SyntaxNode, BoundErrorExpression]? = nil) RecordingScope {
        let previous = enabled.Value
        let previousFailedCalls = currentFailedCalls.Value
        enabled.Value = record
        if failedCalls != nil || !record {
            currentFailedCalls.Value = if record {
                failedCalls
            } else {
                default(ConcurrentDictionary[SyntaxNode, BoundErrorExpression]?)
            }
        }
        return RecordingScope(previous, previousFailedCalls)
    }

    /// Starts collecting for [`syntax`](paramref).
    /// @param syntax The call being bound.
    /// @param receiverType The call receiver's type, when already known.
    /// @returns The frame that (cref:End) closes, or null when recording is off.
    func Begin(syntax SyntaxNode, receiverType TypeSymbol? = nil) Frame? {
        if !enabled.Value {
            return nil
        }
        let frame = Frame(syntax, current.Value, receiverType)
        current.Value = frame
        return frame
    }

    /// Stops collecting for [`frame`](paramref).
    /// @param frame The frame (cref:Begin) returned.
    func End(frame Frame?) {
        if frame != nil {
            current.Value = frame.Parent
        }
    }

    ///Restores the recording state that (cref:Enter) replaced.
    internal struct RecordingScope : IDisposable {
        private let previous bool
        private let previousFailedCalls ConcurrentDictionary[SyntaxNode, BoundErrorExpression]?

        internal init(previous bool, previousFailedCalls ConcurrentDictionary[SyntaxNode, BoundErrorExpression]?) {
            this.previous = previous
            this.previousFailedCalls = previousFailedCalls
        }

        func Dispose() {
            CallCandidateRecorder.enabled.Value = this.previous
            CallCandidateRecorder.currentFailedCalls.Value = this.previousFailedCalls
        }
    }

    /// Records the declared overloads a source selection considers.
    /// @param candidates The source functions.
    /// @param receiverType The call receiver's type, when any.
    func RecordFunctions(candidates ImmutableArray[FunctionSymbol], receiverType TypeSymbol? = nil) {
        let frame = current.Value
        if !enabled.Value || frame == nil || candidates.IsDefaultOrEmpty {
            return
        }
        if receiverType != nil && frame.ReceiverType == nil {
            frame.ReceiverType = receiverType
        }
        let set = ImmutableArray.CreateBuilder[object](candidates.Length)
        for candidate in candidates {
            set.Add(candidate)
        }
        frame.Sets.Add(set.MoveToImmutable())
    }

    /// Records the reflected overloads an imported selection considers.
    /// @param candidates The reflected methods or constructors.
    /// @param receiverType The call receiver's type, when any.
    func RecordMethods[T MethodBase](candidates IReadOnlyCollection[T], receiverType TypeSymbol? = nil) {
        let frame = current.Value
        if !enabled.Value || frame == nil || candidates.Count == 0 {
            return
        }
        if receiverType != nil && frame.ReceiverType == nil {
            frame.ReceiverType = receiverType
        }
        let set = ImmutableArray.CreateBuilder[object](candidates.Count)
        for candidate in candidates {
            set.Add(candidate)
        }
        frame.Sets.Add(set.MoveToImmutable())
    }

    /// Records the declared extension overloads an extension call considers (ADR-0212 issue #5480).
    /// @param candidates The source extension functions.
    func RecordExtensionFunctions(candidates ImmutableArray[FunctionSymbol]) {
        let frame = current.Value
        if !enabled.Value || frame == nil || candidates.IsDefaultOrEmpty {
            return
        }
        let set = ImmutableArray.CreateBuilder[object](candidates.Length)
        for candidate in candidates {
            set.Add(candidate)
        }
        frame.ExtensionSet = set.MoveToImmutable()
    }

    /// Records the reflected extension overloads an imported extension call considers, filtered to those
    /// whose first parameter can take [`receiverType`](paramref) (ADR-0212 issue #5480).
    /// @param candidates The reflected extension methods of the call's name.
    /// @param receiverType The call receiver's type.
    func RecordExtensionMethods(candidates IReadOnlyCollection[MethodInfo], receiverType TypeSymbol) {
        let frame = current.Value
        if !enabled.Value || frame == nil || candidates.Count == 0 {
            return
        }
        if frame.ReceiverType == nil {
            frame.ReceiverType = receiverType
        }
        let filtered = Binder.FilterImportedExtensionMethods(candidates, receiverType)
        if filtered.IsDefaultOrEmpty {
            return
        }
        let set = ImmutableArray.CreateBuilder[object](filtered.Length)
        for candidate in filtered {
            set.Add(candidate)
        }
        frame.ExtensionSet = set.MoveToImmutable()
    }

    /// Gives [`call`](paramref), or the call it wraps, the group [`frame`](paramref) recorded.
    /// @param frame The frame of the call.
    /// @param bound The expression the binder built for the call.
    func Stamp(frame Frame?, bound BoundExpression) {
        if frame == nil {
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
                if call.MemberGroup.IsDefault && (frame.Sets.Count > 0 || !frame.ExtensionSet.IsDefault) {
                    call.MemberGroup = Select(frame, call.CalledFunction, IsSourceExtensionCall(call, frame.Syntax))
                }
                PropagateFailedChildren(frame)
                return
            }
            if node is BoundBaseClassCallExpression{Method: {} baseMethod} baseCall {
                if baseCall.MemberGroup.IsDefault && frame.Sets.Count > 0 {
                    baseCall.MemberGroup = Select(frame, baseMethod, extensionCall: false)
                }
                PropagateFailedChildren(frame)
                return
            }
            if node is BoundErrorExpression error {
                if error.MemberGroup.IsDefault && (frame.Sets.Count > 0 || !frame.ExtensionSet.IsDefault) {
                    let (selected, isExtension) = SelectForSyntax(frame)
                    if !selected.IsDefaultOrEmpty {
                        error.CallSyntax = frame.Syntax
                        error.MemberGroup = selected
                        error.ReceiverType = frame.ReceiverType
                        error.IsExtensionCall = isExtension
                        if currentFailedCalls.Value is {} table {
                            table[frame.Syntax] = error
                        }
                        if currentBodyFailedCalls.Value is {} bodyList && !bodyList.Contains(error) {
                            bodyList.Add(error)
                        }
                    }
                }
                if frame.FailedChildren is {Count: > 0} children {
                    let builder = ImmutableArray.CreateBuilder[BoundErrorExpression](children.Count)
                    if !error.FailedChildren.IsDefaultOrEmpty {
                        builder.AddRange(error.FailedChildren)
                    }
                    for child in children {
                        if !object.ReferenceEquals(child, error) && !builder.Contains(child) {
                            builder.Add(child)
                        }
                    }
                    if builder.Count > 0 {
                        error.FailedChildren = builder.ToImmutable()
                    }
                }
                if frame.Parent != nil &&
                    (!error.MemberGroup.IsDefaultOrEmpty || !error.FailedChildren.IsDefaultOrEmpty) {
                    frame.Parent.AddFailedChild(error)
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
        PropagateFailedChildren(frame)
    }

    private func PropagateFailedChildren(frame Frame) {
        if frame.Parent is {} parent && frame.FailedChildren is {Count: > 0} children {
            for child in children {
                parent.AddFailedChild(child)
            }
        }
    }

    private func Select(frame Frame, called Symbol, extensionCall bool) ImmutableArray[object] {
        if !frame.ExtensionSet.IsDefault && ContainsCallee(frame.ExtensionSet, called) {
            return frame.ExtensionSet
        }
        if extensionCall {
            return default(ImmutableArray[object])
        }
        var best ImmutableArray[object] = default(ImmutableArray[object])
        for set in frame.Sets {
            if set.Length >= 2 && (best.IsDefault || set.Length >= best.Length) && ContainsCallee(set, called) {
                best = set
            }
        }
        return best
    }

    private func SelectForSyntax(frame Frame)(Group ImmutableArray[object], IsExtension bool) {
        let name = SyntaxCallName(frame.Syntax)
        if string.IsNullOrEmpty(name) {
            return (default(ImmutableArray[object]), false)
        }
        var best ImmutableArray[object] = default(ImmutableArray[object])
        for set in frame.Sets {
            if (best.IsDefault || set.Length >= best.Length) && ContainsName(set, name) {
                best = set
            }
        }
        if !best.IsDefault {
            return (best, false)
        }
        if !frame.ExtensionSet.IsDefault && ContainsName(frame.ExtensionSet, name) {
            let isSourceExtension = frame.ExtensionSet[0] is FunctionSymbol{IsExtension: true} &&
                frame.Syntax is CallExpressionSyntax ce &&
                ce.Parent is AccessorExpressionSyntax accessor &&
                object.ReferenceEquals(accessor.RightPart, ce)
            return (frame.ExtensionSet, isSourceExtension)
        }
        return (default(ImmutableArray[object]), false)
    }

    private func SyntaxCallName(syntax SyntaxNode) string? -> switch syntax {
        case call is CallExpressionSyntax: call.Identifier.ValueText
        case baseInterface is BaseInterfaceCallExpressionSyntax: baseInterface.MethodIdentifier.ValueText
        default: default(string?)
    }

    private func ContainsName(set ImmutableArray[object], name string) bool {
        for candidate in set {
            let matches = switch candidate {
                case function is FunctionSymbol: function.Name == name
                case method is MethodBase: ClrTypeUtilities.EmittedMemberNameMatches(method, name)
                default: false
            }
            if matches {
                return true
            }
        }
        return false
    }

    /// Reports whether [`call`](paramref) was dispatched as a receiver-form source extension call (`receiver.Ext(...)`)
    /// rather than a direct free or static call.
    /// @param call The bound call operation.
    /// @param fallbackSyntax The call syntax node when [`call`](paramref)'s own syntax is not populated.
    func IsSourceExtensionCall(call BoundCallOperationExpression, fallbackSyntax SyntaxNode? = nil) bool ->
    call is BoundCallExpression{Function: {IsExtension: true}, StaticQualifierType: nil} &&
        (call.Syntax ?? fallbackSyntax) is CallExpressionSyntax ce &&
        ce.Parent is AccessorExpressionSyntax accessor &&
        object.ReferenceEquals(accessor.RightPart, ce)

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
            return left.MetadataToken == right.MetadataToken &&
                left.Module == right.Module &&
                left.DeclaringType == right.DeclaringType &&
                left.Name == right.Name
        }
        return false
    }

    /// The candidate sets of one call being bound.
    internal class Frame {
        init(syntax SyntaxNode, parent Frame?, receiverType TypeSymbol? = nil) {
            Syntax = syntax
            Parent = parent
            ReceiverType = receiverType
            Sets = List[ImmutableArray[object]]()
        }

        prop Syntax SyntaxNode {
            get;
        }

        prop Parent Frame? {
            get;
        }

        prop ReceiverType TypeSymbol? {
            get;
            set;
        }

        prop Sets List[ImmutableArray[object]] {
            get;
        }

        prop ExtensionSet ImmutableArray[object] {
            get;
            set;
        }

        prop FailedChildren List[BoundErrorExpression]? {
            get;
            private set;
        }

        func AddFailedChild(child BoundErrorExpression) {
            FailedChildren ??= List[BoundErrorExpression]()
            if !FailedChildren!!.Contains(child) {
                FailedChildren!!.Add(child)
            }
        }
    }
}
