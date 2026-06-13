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
    ConstrainedStaticCallExpression,
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
    ClrMethodGroupExpression,
    IndirectCallExpression,
    InterpolatedStringExpression,
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

    // ADR-0061: a call-site-only conditional lvalue address-of of the form
    // `<cond> ? <lvalue> : <lvalue>`. Lowered to a CIL branch around two
    // address-of forms feeding a single byref onto the evaluation stack.
    ConditionalAddressExpression,

    // ADR-0062: a general two-arm conditional (ternary) value expression
    // of the form `<cond> ? <ifTrue> : <ifFalse>`. Lowered to a CIL branch
    // around two arm values feeding a single value onto the evaluation
    // stack. Both arms are already converted to the result type by the binder.
    ConditionalExpression,

    // ADR-0060 §13: indirect assignment `*p = expr` — stores a value
    // through a managed pointer. Lowered to `<load-address> <value>
    // stind.*` by the emitter. Used both for direct `*T`-local stores
    // and as the body-side lowering target for `ref`/`out` parameter
    // writes (§5).
    IndirectAssignmentExpression,

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

    // Issue #575: expression-level type-test and safe-cast operators.
    IsExpression,
    AsExpression,

    // ADR-0065 §2: a `init(args)` self-delegation statement inside a
    // `convenience init(...)` body. Emitted as a `call .ctor(this, args)`
    // chained CIL call to another constructor in the same class.
    ConstructorChainingExpression,

    // ADR-0091 / issue #757: explicit-base call into an inherited interface
    // default body — `base[IFoo].Method(args)`. Emitted as a non-virtual
    // `call instance R IFoo::Method(...)` so the inherited default runs
    // without re-dispatching through the implementer's v-table.
    BaseInterfaceCallExpression,
}

#pragma warning restore SA1602 // Enumeration items should be documented
#pragma warning restore CS1591 // Missing XML comment for publicly visible type or member
