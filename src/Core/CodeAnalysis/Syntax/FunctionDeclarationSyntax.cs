// <copyright file="FunctionDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a function declaration in the language.
/// </summary>
public sealed class FunctionDeclarationSyntax : MemberSyntax
{
    // Backing fields for the properties the parser assigns after construction. Their setters
    // invalidate the node's cached span (issue #1675).
    private SyntaxToken? semicolonBodyToken;
    private SyntaxToken? staticModifier;
    private SyntaxToken? returnRefModifier;
    private SyntaxToken? unsafeModifier;
    private SyntaxToken? returnReadOnlyModifier;
    private SyntaxToken? explicitInterfaceOpenParenToken;
    private TypeClauseSyntax? explicitInterfaceType;
    private SyntaxToken? explicitInterfaceCloseParenToken;
    private SyntaxToken? retiredExtensionKeyword;
    private SyntaxToken? partialModifier;

    /// <summary>
    /// Initializes a new instance of the <see cref="FunctionDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="functionKeyword">The func keyword.</param>
    /// <param name="identifier">The function identifier.</param>
    /// <param name="openParenthesisToken">The open parenthesis token.</param>
    /// <param name="parameters">The function's parameters.</param>
    /// <param name="closeParenthesisToken">The close parenthesis token.</param>
    /// <param name="type">The function's type.</param>
    /// <param name="body">The function's body.</param>
    public FunctionDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken functionKeyword,
        SyntaxToken identifier,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenthesisToken,
        TypeClauseSyntax? type,
        BlockStatementSyntax? body)
        : this(syntaxTree, accessibilityModifier: null, functionKeyword, identifier, openParenthesisToken, parameters, closeParenthesisToken, type, body)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="FunctionDeclarationSyntax"/> class with an explicit accessibility modifier.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier (<c>public</c>/<c>internal</c>/<c>private</c>).</param>
    /// <param name="functionKeyword">The func keyword.</param>
    /// <param name="identifier">The function identifier.</param>
    /// <param name="openParenthesisToken">The open parenthesis token.</param>
    /// <param name="parameters">The function's parameters.</param>
    /// <param name="closeParenthesisToken">The close parenthesis token.</param>
    /// <param name="type">The function's type.</param>
    /// <param name="body">The function's body.</param>
    public FunctionDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken? accessibilityModifier,
        SyntaxToken functionKeyword,
        SyntaxToken identifier,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenthesisToken,
        TypeClauseSyntax? type,
        BlockStatementSyntax? body)
        : this(syntaxTree, accessibilityModifier, openModifier: null, overrideModifier: null, functionKeyword, identifier, openParenthesisToken, parameters, closeParenthesisToken, type, body)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="FunctionDeclarationSyntax"/> class with explicit accessibility and virtuality modifiers (Phase 3.B.3 sub-step 3).
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier (<c>public</c>/<c>internal</c>/<c>private</c>).</param>
    /// <param name="openModifier">The optional <c>open</c> contextual keyword (marks the method as overridable per ADR-0017). Class methods only.</param>
    /// <param name="overrideModifier">The optional <c>override</c> contextual keyword (marks the method as overriding a base method). Class methods only.</param>
    /// <param name="functionKeyword">The func keyword.</param>
    /// <param name="identifier">The function identifier.</param>
    /// <param name="openParenthesisToken">The open parenthesis token.</param>
    /// <param name="parameters">The function's parameters.</param>
    /// <param name="closeParenthesisToken">The close parenthesis token.</param>
    /// <param name="type">The function's type.</param>
    /// <param name="body">The function's body.</param>
    public FunctionDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken? accessibilityModifier,
        SyntaxToken? openModifier,
        SyntaxToken? overrideModifier,
        SyntaxToken functionKeyword,
        SyntaxToken identifier,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenthesisToken,
        TypeClauseSyntax? type,
        BlockStatementSyntax? body)
        : this(syntaxTree, accessibilityModifier, openModifier, overrideModifier, functionKeyword, receiverOpenParenthesisToken: null, receiver: null, receiverCloseParenthesisToken: null, identifier, openParenthesisToken, parameters, closeParenthesisToken, type, body)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="FunctionDeclarationSyntax"/> class with an optional Go-style receiver clause (Phase 3.B.6, ADR-0019).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">Optional accessibility modifier.</param>
    /// <param name="openModifier">Optional <c>open</c> modifier.</param>
    /// <param name="overrideModifier">Optional <c>override</c> modifier.</param>
    /// <param name="functionKeyword">The func keyword.</param>
    /// <param name="receiverOpenParenthesisToken">Optional open parenthesis introducing the receiver clause.</param>
    /// <param name="receiver">Optional receiver parameter (Phase 3.B.6 extension function).</param>
    /// <param name="receiverCloseParenthesisToken">Optional close parenthesis terminating the receiver clause.</param>
    /// <param name="identifier">The function identifier.</param>
    /// <param name="openParenthesisToken">The open parenthesis token of the parameter list.</param>
    /// <param name="parameters">The function's parameters.</param>
    /// <param name="closeParenthesisToken">The close parenthesis token of the parameter list.</param>
    /// <param name="type">The function's return type.</param>
    /// <param name="body">The function's body.</param>
    public FunctionDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken? accessibilityModifier,
        SyntaxToken? openModifier,
        SyntaxToken? overrideModifier,
        SyntaxToken functionKeyword,
        SyntaxToken? receiverOpenParenthesisToken,
        ParameterSyntax? receiver,
        SyntaxToken? receiverCloseParenthesisToken,
        SyntaxToken identifier,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenthesisToken,
        TypeClauseSyntax? type,
        BlockStatementSyntax? body)
        : this(syntaxTree, accessibilityModifier, openModifier, overrideModifier, functionKeyword, receiverOpenParenthesisToken, receiver, receiverCloseParenthesisToken, identifier, typeParameterList: null, openParenthesisToken, parameters, closeParenthesisToken, type, body)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="FunctionDeclarationSyntax"/> class with an optional generic type-parameter list (Phase 4.1 / ADR-0020).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">Optional accessibility modifier.</param>
    /// <param name="openModifier">Optional <c>open</c> modifier.</param>
    /// <param name="overrideModifier">Optional <c>override</c> modifier.</param>
    /// <param name="functionKeyword">The func keyword.</param>
    /// <param name="receiverOpenParenthesisToken">Optional open parenthesis introducing the receiver clause.</param>
    /// <param name="receiver">Optional receiver parameter.</param>
    /// <param name="receiverCloseParenthesisToken">Optional close parenthesis terminating the receiver clause.</param>
    /// <param name="identifier">The function identifier.</param>
    /// <param name="typeParameterList">Optional generic type-parameter list <c>[T any, U any]</c> (Phase 4.1).</param>
    /// <param name="openParenthesisToken">The open parenthesis token of the parameter list.</param>
    /// <param name="parameters">The function's parameters.</param>
    /// <param name="closeParenthesisToken">The close parenthesis token of the parameter list.</param>
    /// <param name="type">The function's return type.</param>
    /// <param name="body">The function's body.</param>
    public FunctionDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken? accessibilityModifier,
        SyntaxToken? openModifier,
        SyntaxToken? overrideModifier,
        SyntaxToken functionKeyword,
        SyntaxToken? receiverOpenParenthesisToken,
        ParameterSyntax? receiver,
        SyntaxToken? receiverCloseParenthesisToken,
        SyntaxToken identifier,
        TypeParameterListSyntax? typeParameterList,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenthesisToken,
        TypeClauseSyntax? type,
        BlockStatementSyntax? body)
        : this(syntaxTree, accessibilityModifier, openModifier, overrideModifier, asyncModifier: null, functionKeyword, receiverOpenParenthesisToken, receiver, receiverCloseParenthesisToken, identifier, typeParameterList, openParenthesisToken, parameters, closeParenthesisToken, type, body)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="FunctionDeclarationSyntax"/> class with an optional <c>async</c> modifier (Phase 5.1 / ADR-0023).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">Optional accessibility modifier.</param>
    /// <param name="openModifier">Optional <c>open</c> modifier.</param>
    /// <param name="overrideModifier">Optional <c>override</c> modifier.</param>
    /// <param name="asyncModifier">Optional <c>async</c> modifier (Phase 5.1).</param>
    /// <param name="functionKeyword">The func keyword.</param>
    /// <param name="receiverOpenParenthesisToken">Optional open parenthesis introducing the receiver clause.</param>
    /// <param name="receiver">Optional receiver parameter.</param>
    /// <param name="receiverCloseParenthesisToken">Optional close parenthesis terminating the receiver clause.</param>
    /// <param name="identifier">The function identifier.</param>
    /// <param name="typeParameterList">Optional generic type-parameter list.</param>
    /// <param name="openParenthesisToken">The open parenthesis token of the parameter list.</param>
    /// <param name="parameters">The function's parameters.</param>
    /// <param name="closeParenthesisToken">The close parenthesis token of the parameter list.</param>
    /// <param name="type">The function's return type.</param>
    /// <param name="body">The function's body.</param>
    public FunctionDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken? accessibilityModifier,
        SyntaxToken? openModifier,
        SyntaxToken? overrideModifier,
        SyntaxToken? asyncModifier,
        SyntaxToken functionKeyword,
        SyntaxToken? receiverOpenParenthesisToken,
        ParameterSyntax? receiver,
        SyntaxToken? receiverCloseParenthesisToken,
        SyntaxToken identifier,
        TypeParameterListSyntax? typeParameterList,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenthesisToken,
        TypeClauseSyntax? type,
        BlockStatementSyntax? body)
        : base(syntaxTree)
    {
        AccessibilityModifier = accessibilityModifier;
        OpenModifier = openModifier;
        OverrideModifier = overrideModifier;
        AsyncModifier = asyncModifier;
        StaticModifier = null;
        FunctionKeyword = functionKeyword;
        ReceiverOpenParenthesisToken = receiverOpenParenthesisToken;
        Receiver = receiver;
        ReceiverCloseParenthesisToken = receiverCloseParenthesisToken;
        Identifier = identifier;
        TypeParameterList = typeParameterList;
        OpenParenthesisToken = openParenthesisToken;
        Parameters = parameters;
        CloseParenthesisToken = closeParenthesisToken;
        Type = type;
        Body = body;
    }

    /// <summary>
    /// Gets or sets the optional <c>;</c> token that takes the place of the
    /// function body for a <c>@DllImport</c>-annotated P/Invoke declaration
    /// (ADR-0086 / issue #727). When non-null, <see cref="Body"/> is <c>null</c>
    /// and the declaration is a P/Invoke stub whose implementation lives in an
    /// unmanaged library. Assigned by the parser; <c>null</c> for ordinary
    /// function declarations.
    /// </summary>
    public SyntaxToken? SemicolonBodyToken
    {
        get => semicolonBodyToken;
        set
        {
            semicolonBodyToken = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this declaration uses a
    /// <c>;</c> body marker instead of a block body (ADR-0086).</summary>
    public bool HasSemicolonBody => SemicolonBodyToken != null;

    /// <summary>
    /// Gets or sets the optional <c>partial</c> contextual modifier (ADR-0192 /
    /// issue #4301) preceding this method's <c>func</c> keyword. When non-null
    /// the declaration is one part of a partial method: either the
    /// <em>declaring</em> part (<see cref="HasSemicolonBody"/> is <c>true</c> —
    /// signature and annotations only) or the <em>implementing</em> part
    /// (<see cref="Body"/> is non-null). <c>PartialMethodMerger</c> collapses
    /// the two parts into a single declaration before the body binder runs, so
    /// a merged node carries this token but has a real body. Deliberately NOT
    /// <c>[SyntaxChildIgnore]</c>: the token must participate in child
    /// enumeration so <see cref="SyntaxNode.Span"/> covers it and tooling that
    /// walks the tree sees it. Assigned by the parser; <c>null</c> for an
    /// ordinary method.
    /// </summary>
    public SyntaxToken? PartialModifier
    {
        get => partialModifier;
        set
        {
            partialModifier = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this declaration carries the <c>partial</c> contextual modifier (ADR-0192).</summary>
    public bool IsPartial => PartialModifier != null;

    /// <summary>
    /// Gets or sets the <em>declaring</em> part this node was merged from
    /// (ADR-0192). Non-<see langword="null"/> only on the synthetic node
    /// <c>PartialMethodMerger</c> builds from a declaring/implementing pair; it
    /// records the signature-only part so tooling can report both part
    /// locations, and it is the merger's idempotency guard — a method whose
    /// <c>DeclaringPart</c> is already set is never re-merged when the same
    /// syntax tree is bound again (the LSP rebinds, and a test may compile one
    /// tree more than once). It IS, however, re-checked for GS0608 (enclosing
    /// type not partial — cheap to recompute fresh each bind) and replayed for
    /// <see cref="RecoveredPartsDisagreement"/> (GS0611 — NOT cheap to
    /// recompute, since the two original parts' own disagreement can be masked
    /// once their data is unioned into this one node): Copilot review round 6
    /// caught both diagnostics silently disappearing on a second bind, which
    /// this doc comment's earlier "passed through untouched" claim missed.
    /// <c>[SyntaxChildIgnore]</c>: the declaring part's tokens already belong to
    /// their own declaration in its own file, so re-parenting them here would
    /// double-count them in child enumeration and stretch this node's
    /// <see cref="SyntaxNode.Span"/> across two files.
    /// </summary>
    [SyntaxChildIgnore]
    public FunctionDeclarationSyntax? DeclaringPart { get; set; }

    /// <summary>
    /// Gets or sets the GS0611 aspect the declaring/implementing pair
    /// disagreed on when this merged node was built, or <see langword="null"/>
    /// when they agreed (ADR-0192). Set only on a node with
    /// <see cref="DeclaringPart"/> non-null.
    /// <para>
    /// A real signature disagreement does not stop the merge — see
    /// <c>ValidateConsistency</c>'s caller — so a SECOND bind of the same
    /// syntax tree would otherwise see only the already-merged node and, per
    /// <see cref="DeclaringPart"/>'s idempotency guard, skip re-deriving
    /// anything from it. Re-running the same comparison against the merged
    /// node itself is not a safe substitute: the merge unions several
    /// modifiers with <c>??</c> (e.g. <c>OpenModifier</c>), which can make an
    /// aspect the two ORIGINAL parts genuinely disagreed on look consistent
    /// again once compared against the union. Recording the aspect here at
    /// merge time — when both original parts are still directly
    /// available — lets a later bind replay the SAME GS0611 instead of
    /// silently turning a real compile error into success.
    /// </para>
    /// </summary>
    public string? RecoveredPartsDisagreement { get; set; }

    /// <summary>
    /// Gets or sets the original declaring/implementing part counts of a
    /// malformed partial-method group (GS0610) whose sibling parts error
    /// recovery already dropped from the type's member list, leaving this
    /// node as the sole survivor (ADR-0192). Non-<see langword="null"/> only
    /// on that survivor.
    /// <para>
    /// Recovery drops every other part to suppress the GS0102
    /// duplicate-member cascade — but that means a SECOND bind of the same
    /// syntax tree (the LSP rebinds; ADR-0144's <c>PartialTypeMerger</c>
    /// returns the SAME node when a type has exactly one syntactic part)
    /// sees only this one survivor. Without this marker, <c>PartialMethodMerger</c>
    /// would misread it as a freshly-encountered lone part — a declaring
    /// part with no implementation reports GS0609 instead of the original
    /// GS0610; an implementing part reports GS0610 again but with the WRONG
    /// counts (0 declaring, 1 implementing) since its sibling declaring
    /// parts are gone. Copilot review round 5 caught the former. Recording
    /// the original counts here lets a later bind re-report the SAME GS0610
    /// instead, reaching a genuine fixed point after the first bind.
    /// </para>
    /// </summary>
    public (int DeclaringCount, int ImplementingCount)? RecoveredPartCountMismatch { get; set; }

    /// <summary>Gets the optional open parenthesis introducing the receiver clause (Phase 3.B.6).</summary>
    public SyntaxToken? ReceiverOpenParenthesisToken { get; }

    /// <summary>Gets the optional receiver parameter that turns this function into an extension function (Phase 3.B.6, ADR-0019). <c>null</c> for ordinary free functions and class methods.</summary>
    public ParameterSyntax? Receiver { get; }

    /// <summary>Gets the optional close parenthesis terminating the receiver clause (Phase 3.B.6).</summary>
    public SyntaxToken? ReceiverCloseParenthesisToken { get; }

    /// <summary>Gets a value indicating whether this declaration carries a Go-style receiver clause (Phase 3.B.6 extension function).</summary>
    public bool IsExtension => Receiver != null;

    /// <summary>
    /// Gets or sets the optional open parenthesis introducing a dedicated
    /// explicit-interface-implementation qualifier clause, e.g. <c>func (IFoo) M(...)</c>
    /// (ADR-0149). Distinct from <see cref="ReceiverOpenParenthesisToken"/> — this is a
    /// single-type qualifier, not a name+type extension receiver. Assigned by the parser;
    /// <see langword="null"/> for an ordinary or extension function.
    /// </summary>
    public SyntaxToken? ExplicitInterfaceOpenParenthesisToken
    {
        get => explicitInterfaceOpenParenToken;
        set
        {
            explicitInterfaceOpenParenToken = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>
    /// Gets or sets the interface type referenced by the explicit-interface qualifier
    /// clause (ADR-0149), e.g. the <c>IFoo</c> in <c>func (IFoo) M(...)</c>. Assigned by
    /// the parser; <see langword="null"/> when no clause is present.
    /// </summary>
    public TypeClauseSyntax? ExplicitInterfaceType
    {
        get => explicitInterfaceType;
        set
        {
            explicitInterfaceType = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets or sets the optional close parenthesis terminating the explicit-interface qualifier clause (ADR-0149).</summary>
    public SyntaxToken? ExplicitInterfaceCloseParenthesisToken
    {
        get => explicitInterfaceCloseParenToken;
        set
        {
            explicitInterfaceCloseParenToken = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this declaration carries an explicit-interface qualifier clause (ADR-0149).</summary>
    public bool HasExplicitInterfaceClause => ExplicitInterfaceType != null;

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.FunctionDeclaration;

    /// <summary>
    /// Gets the optional accessibility modifier token (<c>public</c>/<c>internal</c>/<c>private</c>), or <c>null</c> if none was supplied.
    /// </summary>
    public SyntaxToken? AccessibilityModifier { get; }

    /// <summary>Gets the optional <c>open</c> modifier (Phase 3.B.3 sub-step 3). Non-null marks the method as overridable per ADR-0017. Only meaningful on class methods.</summary>
    public SyntaxToken? OpenModifier { get; }

    /// <summary>Gets the optional <c>override</c> modifier (Phase 3.B.3 sub-step 3). Non-null marks the method as overriding a base method per ADR-0017. Only meaningful on class methods.</summary>
    public SyntaxToken? OverrideModifier { get; }

    /// <summary>Gets the optional <c>async</c> or <c>suspend</c> modifier. An <c>async</c> token (Phase 5.1 / ADR-0023) makes this an async function: callers see <c>Task[T]</c> (or <c>Task</c>), and the body may use <c>await</c>. A <c>suspend</c> token (ADR-0174 D4) makes it a suspending function: callers see <c>T</c> and await it implicitly, the body may use <c>await</c>, and the emitted method returns <c>ValueTask[T]</c>.</summary>
    public SyntaxToken? AsyncModifier { get; }

    /// <summary>Gets or sets the optional <c>static</c> contextual keyword (ADR-0089 / issue #755). Non-null when the function was declared inside <c>interface { … }</c> as a static-virtual member; the binder rejects this token on non-interface members.</summary>
    [SyntaxChildIgnore]
    public SyntaxToken? StaticModifier
    {
        get => staticModifier;
        set
        {
            staticModifier = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this function carries a <c>static</c> contextual keyword (ADR-0089).</summary>
    public bool HasStaticModifier => StaticModifier != null;

    /// <summary>Gets a value indicating whether this function declares <c>async</c>.</summary>
    public bool IsAsync => AsyncModifier?.Kind == SyntaxKind.AsyncKeyword;

    /// <summary>Gets a value indicating whether this function declares <c>suspend</c> (ADR-0174 D4).</summary>
    public bool IsSuspend => AsyncModifier?.Kind == SyntaxKind.SuspendKeyword;

    /// <summary>Gets a value indicating whether this function is marked <c>open</c>.</summary>
    public bool IsOpen => OpenModifier != null;

    /// <summary>Gets a value indicating whether this function is marked <c>override</c>.</summary>
    public bool IsOverride => OverrideModifier != null;

    /// <summary>
    /// Gets or sets the optional <c>ref</c> contextual modifier preceding the function's
    /// return type clause (issue #490 / ADR-0060 follow-up), e.g.
    /// <c>func max(...) ref int32 { ... }</c>. When non-null, the function returns a
    /// managed pointer to its declared return type and callers receive a <c>T&amp;</c>.
    /// Assigned by the parser; <c>null</c> otherwise.
    /// </summary>
    public SyntaxToken? ReturnRefModifier
    {
        get => returnRefModifier;
        set
        {
            returnRefModifier = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this function declares a <c>ref</c> return (issue #490).</summary>
    public bool IsRefReturn => ReturnRefModifier != null;

    /// <summary>Gets or sets the contextual <c>readonly</c> token following a return's <c>ref</c>.</summary>
    public SyntaxToken? ReturnReadOnlyModifier
    {
        get => returnReadOnlyModifier;
        set
        {
            returnReadOnlyModifier = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>
    /// Gets or sets the optional <c>unsafe</c> contextual modifier (ADR-0122 / issue #1014)
    /// contextual modifier preceding <c>func</c> (e.g. <c>unsafe func F(...)</c>).
    /// When non-null the function body is an <c>unsafe</c> context: unmanaged
    /// raw pointers (<c>*T</c> → CLR <c>ELEMENT_TYPE_PTR</c>) and raw-pointer
    /// operations are permitted in its signature and body. Assigned by the
    /// parser; <c>null</c> otherwise.
    /// </summary>
    public SyntaxToken? UnsafeModifier
    {
        get => unsafeModifier;
        set
        {
            unsafeModifier = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this function is marked <c>unsafe</c> (ADR-0122 / issue #1014).</summary>
    public bool IsUnsafe => UnsafeModifier != null;

    /// <summary>
    /// Gets or sets a value indicating whether this declaration is a user-defined
    /// conversion operator (issue #1017), declared as
    /// <c>func operator implicit (x T) U { … }</c> or the <c>explicit</c> variant.
    /// When <see langword="true"/> the binder models the declaration as a static
    /// <c>op_Implicit</c>/<c>op_Explicit</c> special-name method on the owning
    /// user type. Assigned by the parser.
    /// </summary>
    public bool IsConversionOperator { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this conversion operator is an
    /// <c>explicit</c> conversion (<c>op_Explicit</c>) rather than an
    /// <c>implicit</c> one (<c>op_Implicit</c>). Only meaningful when
    /// <see cref="IsConversionOperator"/> is <see langword="true"/>. Assigned by
    /// the parser.
    /// </summary>
    public bool ConversionIsExplicit { get; set; }

    /// <summary>
    /// Gets the func keyword.
    /// </summary>
    public SyntaxToken FunctionKeyword { get; }

    /// <summary>
    /// Gets or sets the retired ADR-0165 <c>extension</c> marker token from
    /// <c>func extension (receiver Type) Name(...)</c>, when the parser
    /// recognized that shape. ADR-0182 retired the marker (every receiver
    /// clause is unconditionally an extension now), so this token exists
    /// only to preserve full-fidelity source text for the declaration the
    /// parser reported <c>GS0587</c> against; it carries no semantic
    /// meaning and binding never reads it.
    /// </summary>
    public SyntaxToken? RetiredExtensionKeyword
    {
        get => retiredExtensionKeyword;
        set
        {
            retiredExtensionKeyword = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>
    /// Gets the function identifier.
    /// </summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the optional generic type-parameter list (e.g. <c>[T any, U any]</c>); <c>null</c> for non-generic functions. Phase 4.1 / ADR-0020.</summary>
    public TypeParameterListSyntax? TypeParameterList { get; }

    /// <summary>Gets a value indicating whether this function declares one or more type parameters (Phase 4.1).</summary>
    public bool IsGeneric => TypeParameterList != null;

    /// <summary>
    /// Gets the open parenthesis token.
    /// </summary>
    public SyntaxToken OpenParenthesisToken { get; }

    /// <summary>
    /// Gets the function's parameters.
    /// </summary>
    public SeparatedSyntaxList<ParameterSyntax> Parameters { get; }

    /// <summary>
    /// Gets the close parenthesis token.
    /// </summary>
    public SyntaxToken CloseParenthesisToken { get; }

    /// <summary>
    /// Gets the function's type.
    /// </summary>
    public TypeClauseSyntax? Type { get; }

    /// <summary>
    /// Gets the function's body.
    /// </summary>
    public BlockStatementSyntax? Body { get; }
}
