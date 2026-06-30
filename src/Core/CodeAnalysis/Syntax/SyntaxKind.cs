// <copyright file="SyntaxKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

// Disabling some warnings temporarily for fast iterations.
#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member
#pragma warning disable SA1602 // Enumeration items should be documented

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a kind of syntax token in the language.
/// </summary>
public enum SyntaxKind
{
    // Punctuation tokens
    BadToken,
    WhitespaceToken,
    CommentToken,
    DocumentationCommentToken,
    EndOfFileToken,

    // Language tokens
    PlusToken,
    PlusEqualsToken,
    PlusPlusToken,
    MinusToken,
    MinusEqualsToken,
    MinusMinusToken,
    StarToken,
    StarEqualsToken,
    SlashToken,
    SlashEqualsToken,
    PercentToken,
    PercentEqualsToken,
    OpenParenthesisToken,
    CloseParenthesisToken,
    OpenSquareBracketToken,
    CloseSquareBracketToken,
    OpenBraceToken,
    CloseBraceToken,
    ColonToken,
    ColonEqualsToken,
    SemicolonToken,
    CommaToken,
    DotToken,
    DotDotToken,
    EllipsisToken,
    HatToken,
    HatEqualsToken,
    AmpersandToken,
    AmpersandAmpersandToken,
    AmpersandEqualsToken,
    AmpersandHatToken,
    AmpersandHatEqualsToken,
    PipeToken,
    PipeEqualsToken,
    PipePipeToken,
    EqualsToken,
    EqualsEqualsToken,
    BangToken,
    BangEqualsToken,
    BangBangToken,
    QuestionToken,
    QuestionDotToken,
    QuestionQuestionToken,
    QuestionQuestionEqualsToken,

    // ADR-0073 / issue #710: prefix token for `a?[i]` null-conditional indexing.
    // Only produced when `?` is immediately followed by `[` with no intervening
    // trivia, so a true ternary `cond ? [arr] : [arr]` is left undisturbed.
    QuestionOpenBracketToken,
    LessToken,
    LessOrEqualsToken,
    LeftArrowToken,
    RightArrowToken,
    ShiftLeftToken,
    ShiftLeftEqualsToken,
    GreaterToken,
    GreaterOrEqualsToken,
    ShiftRightToken,
    ShiftRightEqualsToken,

    // ADR-0047: annotation lead-in token
    AtToken,

    // Built-in type tokens
    StringToken,
    InterpolatedStringToken,
    NumberToken,
    CharacterToken,

    // Identifier tokens
    IdentifierToken,

    // Reserved keywords
    AsKeyword,
    AsyncKeyword,
    AwaitKeyword,
    BreakKeyword,
    CaseKeyword,
    ChanKeyword,
    ClassKeyword,
    ConstKeyword,
    ContinueKeyword,
    DefaultKeyword,
    DeferKeyword,
    DoKeyword,
    ElseKeyword,
    GuardKeyword,
    EnumKeyword,
    FalseKeyword,
    FallthroughKeyword,
    ForKeyword,
    FuncKeyword,
    GoKeyword,
    GotoKeyword,
    IfKeyword,
    ImportKeyword,
    InterfaceKeyword,
    InternalKeyword,
    IsKeyword,
    LetKeyword,
    MapKeyword,
    NilKeyword,
    OpenKeyword,
    OperatorKeyword,
    OverrideKeyword,
    PackageKeyword,
    PrivateKeyword,
    ProtectedKeyword,
    PublicKeyword,
    RangeKeyword,
    ReturnKeyword,
    SealedKeyword,
    SelectKeyword,
    ScopeKeyword,
    SequenceKeyword,
    StructKeyword,
    SwitchKeyword,
    ThrowKeyword,
    TrueKeyword,
    TryKeyword,
    TypeKeyword,
    UsingKeyword,
    VarKeyword,
    WhileKeyword,

    // compilation
    CompilationUnit,
    GlobalStatement,
    ExpressionStatement,
    AssignmentExpression,
    UnaryExpression,
    BinaryExpression,
    ParenthesizedExpression,
    LiteralExpression,
    InterpolatedStringExpression,
    NameExpression,
    CallExpression,
    GenericNameExpression,
    AccessorExpression,
    ArrayCreationExpression,
    StackAllocExpression,
    MapCreationExpression,
    MapEntry,
    IndexExpression,
    RangeExpression,
    FromEndIndexExpression,
    IndexAssignmentExpression,
    MemberIndexAssignmentExpression,
    CompoundIndexAssignmentExpression,
    MemberFieldAssignmentExpression,
    PackageDeclaration,
    ImportDeclaration,
    FunctionDeclaration,
    TypeAliasDeclaration,
    EnumDeclaration,
    EnumMember,
    Parameter,
    TypeClause,
    TypeParameter,
    TypeParameterList,
    TypeArgumentList,
    BlockStatement,
    VariableDeclaration,
    IfStatement,
    ElseClause,
    IfLetStatement,
    GuardLetStatement,
    IfLetBindingClause,
    ForInfiniteStatement,
    ForEllipsisStatement,
    ForConditionStatement,
    ForClauseStatement,
    ForRangeStatement,
    WhileStatement,
    DoWhileStatement,
    LabeledStatement,
    BreakStatement,
    ContinueStatement,
    ReturnStatement,
    MultiAssignmentStatement,
    SwitchStatement,
    SwitchCase,
    SwitchExpression,
    SwitchExpressionArm,

    // Pattern syntax
    ConstantPattern,
    DiscardPattern,
    TypePattern,
    PropertyPattern,
    PropertyPatternField,
    RelationalPattern,
    ListPattern,
    SlicePattern,
    BinaryPattern,
    NotPattern,
    ParenthesizedPattern,
    TryStatement,
    CatchClause,
    FinallyClause,
    ThrowStatement,
    ThrowExpression,
    UsingStatement,
    DeferStatement,
    CatchKeyword,
    FinallyKeyword,
    StructDeclaration,
    InterfaceDeclaration,
    FieldDeclaration,
    StructLiteralExpression,
    FieldInitializer,
    FieldAccessExpression,
    FieldAssignmentExpression,
    TupleLiteralExpression,
    TupleDeconstructionStatement,
    NamedDeconstructionStatement,
    NamedDeconstructionField,
    NamedArgumentExpression,
    WithExpression,
    FunctionLiteralExpression,
    AwaitExpression,
    GoStatement,
    MakeChannelExpression,
    ChannelReceiveExpression,
    ChannelSendStatement,
    SelectStatement,
    SelectCase,
    ScopeStatement,
    FixedStatement,
    AwaitForRangeStatement,
    AwaitUsingStatement,
    EventSubscriptionExpression,
    YieldStatement,

    // Issue #143: typeof / nameof contextual operators
    TypeOfExpression,
    NameOfExpression,

    // Issue #1336: sizeof(T) contextual operator over an unmanaged type
    SizeOfExpression,

    // Issue #141 / ADR-0047: attribute (annotation) syntax
    Annotation,
    AnnotationTarget,

    // ADR-0051: property declarations
    PropertyDeclaration,
    EventDeclaration,
    PropertyAccessor,
    EventAccessor,

    // ADR-0053: static (shared) members
    SharedBlock,

    // Issue #306: standalone user-defined constructor declarations (`init(...)`)
    ConstructorDeclaration,

    // ADR-0068 / issue #698: `deinit { … }` destructor declarations inside a
    // class body. Lowered by the emitter to a `Finalize` override with the
    // body wrapped in `try { … } finally { base.Finalize(); }`.
    DeinitDeclaration,

    // ADR-0059 / issue #255: named delegate type declarations
    // (`type Name = delegate func(...)`). `delegate` is a contextual
    // keyword — kept as IdentifierToken at lex time; the parser recognises
    // it inside `type Name = ...` (mirroring the data/record/inline/ref
    // contextual-modifier pattern in ParseTypeAliasDeclaration).
    DelegateDeclaration,

    // ADR-0060: argument-position ref-kind modifier wrapper. Carries
    // the literal `ref`/`out`/`in` token and, for `out`, an optional
    // inline-declaration payload (`out var name [T]`, `out let name [T]`,
    // or `out _`). Plain `ref name` / `in name` / `out name` wrap a
    // single inner expression.
    RefArgumentExpression,

    // ADR-0061: a call-site-only conditional lvalue payload of the form
    // `<cond> ? <lvalue> : <lvalue>` recognised inside the payload of a
    // ref-kind modifier (`ref`/`out`/`in`) and as the operand of `&`.
    // The two branches may optionally carry a matching inner ref-kind
    // modifier (e.g. `ref c ? ref a : ref b`). Retained for backward
    // compatibility with the inner-modifier shape; ADR-0062 supersedes
    // the general case with `ConditionalExpression`.
    ConditionalRefArgumentExpression,

    // ADR-0062: a general two-arm conditional (ternary) expression of
    // the form `<cond> ? <ifTrue> : <ifFalse>`. Valid in any expression
    // position. In ref-kind argument payloads and as the operand of `&`,
    // the binder reinterprets this syntax as a conditional address-of
    // (preserving ADR-0061's byref semantics).
    ConditionalExpression,

    // ADR-0060 §13: indirect assignment `*p = expr`. The LHS is a
    // pointer dereference; the emitter lowers to `<load-address> <value>
    // stind.*`. Necessary for §5's body-side lowering of `ref`/`out`
    // parameter writes and for direct `*T`-local stores.
    IndirectAssignmentExpression,

    // Issue #522: a C#-style object initializer applied to a constructor
    // call, e.g. `T(args) { Prop1 = v1, Prop2 = v2 }`. Each initializer is
    // a `PropertyInitializer` ('Identifier = Expression'). Lowers in the
    // binder to a `BoundBlockExpression` that constructs into a synthetic
    // local, assigns each property, and yields the local.
    ObjectCreationExpression,
    PropertyInitializer,

    // Issue #575: expression-level type-test and safe-cast operators.
    // `expr is T` → bool; `expr as T` → T (or T?).
    IsExpression,
    AsExpression,

    // Issue #669: if as a value-producing expression.
    // `if cond { a } else { b }` → value.
    IfExpression,
    BlockExpression,

    // ADR-0072 / issue #709: null-coalescing compound assignment
    // `a ??= b` — assigns `b` to `a` only when `a` is nil. Statement-level
    // only in G#; the binder validates LHS is nullable (GS0298) and
    // produces a lowered `if a == nil { a = b }` shape.
    NullCoalescingAssignmentStatement,

    // ADR-0074 / issue #714: a lambda expression `(p T) -> body` (with or
    // without parameters; body is an expression or a `{ … }` block). Bound to
    // a `BoundFunctionLiteralExpression` so closure capture, emit, interpreter,
    // and lowering all work without a new bound-node kind.
    LambdaExpression,

    // ADR-0091 / issue #757: explicit-base interface call expression
    // `base[IFoo].Method(args)`. Disambiguates between inherited default
    // bodies in a DIM diamond and lets non-conflicting overrides delegate
    // to (and augment) the inherited default. Bound to
    // BoundBaseInterfaceCallExpression; emitted as a non-virtual `call`
    // into the interface's MethodDef.
    BaseInterfaceCallExpression,

    // ADR-0100 / issue #795: `default(T)` and bare `default` expressions.
    // `default(T)` yields the zero/null value of any type clause T. The
    // bare `default` literal is valid in target-typed positions (let/var
    // initializer with explicit type, `return` when the enclosing
    // function's return type is known, argument to a typed parameter, and
    // ternary `?:` branches typed by the sibling branch). Both shapes bind
    // to BoundDefaultExpression. The `default` keyword's existing role as
    // a switch-arm leader is preserved: those forms are recognized in the
    // case-parsing path before primary-expression dispatch, so this kind
    // only fires for true value-position uses.
    DefaultExpression,

    // Issue #479 / ADR-0117: a collection initializer applied to a generic
    // collection construction, e.g. `List[int32]{1, 2, 3}`,
    // `HashSet[int32](){…}`, `Dictionary[string, int32]{"a": 1}`, or
    // `Dictionary[K, V](comparer){ ["k"] = v }`. The target is a constructor
    // call; each element is one of the three `CollectionElement` shapes below.
    // Lowers in the binder to a `BoundBlockExpression` that constructs into a
    // synthetic local, calls `Add(...)` / sets the indexer for each element,
    // and yields the local.
    CollectionInitializerExpression,

    // A bare element of a sequence/set collection initializer (`expr`).
    ExpressionCollectionElement,

    // A key/value element of a dictionary collection initializer (`key: value`).
    KeyedCollectionElement,

    // An indexed element of a dictionary collection initializer (`[key] = value`).
    IndexedCollectionElement,
}

#pragma warning restore SA1602 // Enumeration items should be documented
#pragma warning restore CS1591 // Missing XML comment for publicly visible type or member
