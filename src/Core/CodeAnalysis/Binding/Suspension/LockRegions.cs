// <copyright file="LockRegions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding.Suspension;

/// <summary>Shape predicates the suspension passes share.</summary>
internal static class LockRegions
{
    /// <summary>Recognizes the binder's lowering of <c>lock</c>: a try whose finally calls <c>Monitor.Exit</c>.</summary>
    /// <param name="node">A try statement.</param>
    /// <returns><see langword="true"/> for a lock region.</returns>
    public static bool IsLockRegion(BoundTryStatement node)
    {
        switch (node.FinallyBlock)
        {
            case BoundBlockStatement block:
                foreach (var statement in block.Statements)
                {
                    if (statement is BoundExpressionStatement { Expression: var expression } && IsMonitorExit(expression))
                    {
                        return true;
                    }
                }

                return false;
            case BoundExpressionStatement single:
                return IsMonitorExit(single.Expression);
            default:
                return false;
        }
    }

    /// <summary>Recognizes the root bridge <c>Blocking.Wait(…)</c> the binder emits for a suspending call in a non-suspending caller.</summary>
    /// <param name="node">An imported call.</param>
    /// <returns><see langword="true"/> for the bridge.</returns>
    public static bool IsBlockingBridge(BoundImportedCallExpression node)
        => node.Function.Name == "Wait"
            && node.Function.ImportedClass.ClassType.FullName == "Gsharp.Concurrency.Blocking"
            && node.Arguments.Length == 1;

    private static bool IsMonitorExit(BoundExpression expression)
        => expression is BoundImportedCallExpression { Function: { Name: "Exit" } function }
            && function.ImportedClass.ClassType.FullName == "System.Threading.Monitor";
}
