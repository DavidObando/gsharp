// <copyright file="BoundNodeKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

// Disabling some warnings temporarily for fast iterations.
#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member
#pragma warning disable SA1602 // Enumeration items should be documented

namespace GSharp.Core.CodeAnalysis.Binding
{
    /// <summary>
    /// Kind of binding for a node.
    /// </summary>
    internal enum BoundNodeKind
    {
        // Statements
        BlockStatement,
        VariableDeclaration,
        IfStatement,
        ForEllipsisStatement,
        LabelStatement,
        GotoStatement,
        ConditionalGotoStatement,
        ReturnStatement,
        ExpressionStatement,

        // Expressions
        ErrorExpression,
        LiteralExpression,
        VariableExpression,
        AssignmentExpression,
        UnaryExpression,
        BinaryExpression,
        CallExpression,
        ConversionExpression,
    }
}

#pragma warning restore SA1602 // Enumeration items should be documented
#pragma warning restore CS1591 // Missing XML comment for publicly visible type or member
