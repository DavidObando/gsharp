// <copyright file="BoundNodeKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

// Disabling some warnings temporarily for fast iterations.
#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member
#pragma warning disable SA1602 // Enumeration items should be documented

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Kind of binding for a node.
/// </summary>
public enum BoundNodeKind
{
    // Statements
    BlockStatement,
    VariableDeclaration,
    IfStatement,
    ForInfiniteStatement,
    ForEllipsisStatement,
    ForRangeStatement,
    LabelStatement,
    GotoStatement,
    ConditionalGotoStatement,
    ReturnStatement,
    ExpressionStatement,
    TryStatement,
    ThrowStatement,
    PatternSwitchStatement,
    PatternSwitchArm,

    // Expressions
    ErrorExpression,
    LiteralExpression,
    VariableExpression,
    AssignmentExpression,
    UnaryExpression,
    BinaryExpression,
    CallExpression,
    ConversionExpression,
    ImportedCallExpression,
    ImportedInstanceCallExpression,
    ArrayCreationExpression,
    MapLiteralExpression,
    MapDeleteExpression,
    IndexExpression,
    IndexAssignmentExpression,
    LenExpression,
    CapExpression,
    AppendExpression,
    StructLiteralExpression,
    ConstructorCallExpression,
    UserInstanceCallExpression,
    FieldAccessExpression,
    FieldAssignmentExpression,
    PropertyAccessExpression,
    PropertyAssignmentExpression,
    NullConditionalAccessExpression,
    TupleLiteralExpression,
    TupleElementAccessExpression,
    FunctionLiteralExpression,
    MethodGroupExpression,
    IndirectCallExpression,
    ClrConstructorCallExpression,
    ClrPropertyAccessExpression,
    ClrPropertyAssignmentExpression,
    ClrBinaryOperatorExpression,
    ClrUnaryOperatorExpression,
    ClrConversionCallExpression,
    ClrIndexExpression,
    ClrIndexAssignmentExpression,
    ClrEventSubscriptionExpression,
    EventSubscriptionExpression,
    AwaitExpression,
    SwitchExpression,
    SwitchExpressionArm,
    BlockExpression,
    AddressOfExpression,
    DereferenceExpression,
    StateMachineAwaitOnCompleted,
    StateMachineBuilderMoveNext,
    SpillSequenceExpression,
    DefaultExpression,
    ClrStaticCallExpression,

    // Issue #143: typeof operator
    TypeOfExpression,

    // Patterns
    ConstantPattern,
    DiscardPattern,
    TypePattern,
    PropertyPattern,
    PropertyPatternField,
    RelationalPattern,
    ListPattern,
    GoStatement,
    MakeChannelExpression,
    ChannelReceiveExpression,
    ChannelSendStatement,
    ChannelCloseExpression,
    SelectStatement,
    ScopeStatement,
    AwaitForRangeStatement,
    YieldStatement,
    AwaitYieldPoint,
    AwaitResumePoint,

    // Issue #141 / ADR-0047: attribute application (annotation in source).
    Attribute,
}

#pragma warning restore SA1602 // Enumeration items should be documented
#pragma warning restore CS1591 // Missing XML comment for publicly visible type or member
