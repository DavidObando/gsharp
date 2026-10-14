// <copyright file="LockRegions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding.Suspension

import GSharp.Core.CodeAnalysis.Binding

/// Shape predicates the suspension passes share.
internal shared class LockRegions {
    /// Recognizes the binder's lowering of `lock`: a try whose finally calls `Monitor.Exit`.
    /// @param node A try statement.
    /// @returns `true` for a lock region.
    func IsLockRegion(node BoundTryStatement) bool {
        switch node.FinallyBlock {
            case block is BoundBlockStatement {
                for statement in block.Statements {
                    if statement is BoundExpressionStatement{Expression: var expression} && IsMonitorExit(expression) {
                        return true
                    }
                }
                return false
            }
            case single is BoundExpressionStatement {
                return IsMonitorExit(single.Expression)
            }
            default {
                return false
            }
        }
    }

    /// Recognizes the root bridge `Blocking.Wait(…)` the binder emits for a suspending call in a
    /// non-suspending caller.
    /// @param node An imported call.
    /// @returns `true` for the bridge.
    func IsBlockingBridge(node BoundImportedCallExpression) bool -> node
        .Function
        .Name == "Wait" &&
        node
        .Function
        .ImportedClass
        .ClassType
        .FullName == "Gsharp.Concurrency.Blocking" &&
        node
        .Arguments
        .Length == 1 &&
        object.ReferenceEquals(node.Syntax, node.Arguments[0].Syntax)

    private func IsMonitorExit(expression BoundExpression) bool -> expression is BoundImportedCallExpression{
        Function: {Name: "Exit"} function
    } &&
        function
        .ImportedClass
        .ClassType
        .FullName == "System.Threading.Monitor"
}
