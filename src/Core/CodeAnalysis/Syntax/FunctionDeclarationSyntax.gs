// <copyright file="FunctionDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a function declaration in the language.
partial class FunctionDeclarationSyntax : MemberSyntax {
    // Backing fields for the properties the parser assigns after construction. Their setters
    // invalidate the node's cached span (issue #1675).
    private var semicolonBodyToken SyntaxToken?

    private var staticModifier SyntaxToken?
    private var returnRefModifier SyntaxToken?
    private var unsafeModifier SyntaxToken?
    private var returnReadOnlyModifier SyntaxToken?
    private var explicitInterfaceOpenParenToken SyntaxToken?
    private var explicitInterfaceType TypeClauseSyntax?
    private var explicitInterfaceCloseParenToken SyntaxToken?
    private var retiredExtensionKeyword SyntaxToken?
    private var partialModifier SyntaxToken?

    /// Initializes a new instance of the (cref:FunctionDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param functionKeyword The func keyword.
    /// @param identifier The function identifier.
    /// @param openParenthesisToken The open parenthesis token.
    /// @param parameters The function's parameters.
    /// @param closeParenthesisToken The close parenthesis token.
    /// @param type The function's type.
    /// @param body The function's body.
    convenience init(
        syntaxTree SyntaxTree,
        functionKeyword SyntaxToken,
        identifier SyntaxToken,
        openParenthesisToken SyntaxToken,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeParenthesisToken SyntaxToken,
        type TypeClauseSyntax?,
        body BlockStatementSyntax?
    ) {
        init(
            syntaxTree,
            nil,
            functionKeyword,
            identifier,
            openParenthesisToken,
            parameters,
            closeParenthesisToken,
            type,
            body
        )
    }

    /// Initializes a new instance of the (cref:FunctionDeclarationSyntax) class with an explicit
    /// accessibility modifier.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier (`public`/`internal`/`private`).
    /// @param functionKeyword The func keyword.
    /// @param identifier The function identifier.
    /// @param openParenthesisToken The open parenthesis token.
    /// @param parameters The function's parameters.
    /// @param closeParenthesisToken The close parenthesis token.
    /// @param type The function's type.
    /// @param body The function's body.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        functionKeyword SyntaxToken,
        identifier SyntaxToken,
        openParenthesisToken SyntaxToken,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeParenthesisToken SyntaxToken,
        type TypeClauseSyntax?,
        body BlockStatementSyntax?
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            nil,
            nil,
            functionKeyword,
            identifier,
            openParenthesisToken,
            parameters,
            closeParenthesisToken,
            type,
            body
        )
    }

    /// Initializes a new instance of the (cref:FunctionDeclarationSyntax) class with explicit accessibility
    /// and virtuality modifiers (Phase 3.B.3 sub-step 3).
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier (`public`/`internal`/`private`).
    /// @param openModifier The optional `open` contextual keyword (marks the method as overridable per
    /// ADR-0017). Class methods only.
    /// @param overrideModifier The optional `override` contextual keyword (marks the method as overriding a
    /// base method). Class methods only.
    /// @param functionKeyword The func keyword.
    /// @param identifier The function identifier.
    /// @param openParenthesisToken The open parenthesis token.
    /// @param parameters The function's parameters.
    /// @param closeParenthesisToken The close parenthesis token.
    /// @param type The function's type.
    /// @param body The function's body.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        openModifier SyntaxToken?,
        overrideModifier SyntaxToken?,
        functionKeyword SyntaxToken,
        identifier SyntaxToken,
        openParenthesisToken SyntaxToken,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeParenthesisToken SyntaxToken,
        type TypeClauseSyntax?,
        body BlockStatementSyntax?
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            openModifier,
            overrideModifier,
            functionKeyword,
            nil,
            nil,
            nil,
            identifier,
            openParenthesisToken,
            parameters,
            closeParenthesisToken,
            type,
            body
        )
    }

    /// Initializes a new instance of the (cref:FunctionDeclarationSyntax) class with an optional Go-style
    /// receiver clause (Phase 3.B.6, ADR-0019).
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier Optional accessibility modifier.
    /// @param openModifier Optional `open` modifier.
    /// @param overrideModifier Optional `override` modifier.
    /// @param functionKeyword The func keyword.
    /// @param receiverOpenParenthesisToken Optional open parenthesis introducing the receiver clause.
    /// @param receiver Optional receiver parameter (Phase 3.B.6 extension function).
    /// @param receiverCloseParenthesisToken Optional close parenthesis terminating the receiver clause.
    /// @param identifier The function identifier.
    /// @param openParenthesisToken The open parenthesis token of the parameter list.
    /// @param parameters The function's parameters.
    /// @param closeParenthesisToken The close parenthesis token of the parameter list.
    /// @param type The function's return type.
    /// @param body The function's body.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        openModifier SyntaxToken?,
        overrideModifier SyntaxToken?,
        functionKeyword SyntaxToken,
        receiverOpenParenthesisToken SyntaxToken?,
        receiver ParameterSyntax?,
        receiverCloseParenthesisToken SyntaxToken?,
        identifier SyntaxToken,
        openParenthesisToken SyntaxToken,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeParenthesisToken SyntaxToken,
        type TypeClauseSyntax?,
        body BlockStatementSyntax?
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            openModifier,
            overrideModifier,
            functionKeyword,
            receiverOpenParenthesisToken,
            receiver,
            receiverCloseParenthesisToken,
            identifier,
            nil,
            openParenthesisToken,
            parameters,
            closeParenthesisToken,
            type,
            body
        )
    }

    /// Initializes a new instance of the (cref:FunctionDeclarationSyntax) class with an optional generic
    /// type-parameter list (Phase 4.1 / ADR-0020).
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier Optional accessibility modifier.
    /// @param openModifier Optional `open` modifier.
    /// @param overrideModifier Optional `override` modifier.
    /// @param functionKeyword The func keyword.
    /// @param receiverOpenParenthesisToken Optional open parenthesis introducing the receiver clause.
    /// @param receiver Optional receiver parameter.
    /// @param receiverCloseParenthesisToken Optional close parenthesis terminating the receiver clause.
    /// @param identifier The function identifier.
    /// @param typeParameterList Optional generic type-parameter list `[T any, U any]` (Phase 4.1).
    /// @param openParenthesisToken The open parenthesis token of the parameter list.
    /// @param parameters The function's parameters.
    /// @param closeParenthesisToken The close parenthesis token of the parameter list.
    /// @param type The function's return type.
    /// @param body The function's body.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        openModifier SyntaxToken?,
        overrideModifier SyntaxToken?,
        functionKeyword SyntaxToken,
        receiverOpenParenthesisToken SyntaxToken?,
        receiver ParameterSyntax?,
        receiverCloseParenthesisToken SyntaxToken?,
        identifier SyntaxToken,
        typeParameterList TypeParameterListSyntax?,
        openParenthesisToken SyntaxToken,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeParenthesisToken SyntaxToken,
        type TypeClauseSyntax?,
        body BlockStatementSyntax?
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            openModifier,
            overrideModifier,
            nil,
            functionKeyword,
            receiverOpenParenthesisToken,
            receiver,
            receiverCloseParenthesisToken,
            identifier,
            typeParameterList,
            openParenthesisToken,
            parameters,
            closeParenthesisToken,
            type,
            body
        )
    }

    /// Initializes a new instance of the (cref:FunctionDeclarationSyntax) class with an optional `async`
    /// modifier (Phase 5.1 / ADR-0023).
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier Optional accessibility modifier.
    /// @param openModifier Optional `open` modifier.
    /// @param overrideModifier Optional `override` modifier.
    /// @param asyncModifier Optional `async` modifier (Phase 5.1).
    /// @param functionKeyword The func keyword.
    /// @param receiverOpenParenthesisToken Optional open parenthesis introducing the receiver clause.
    /// @param receiver Optional receiver parameter.
    /// @param receiverCloseParenthesisToken Optional close parenthesis terminating the receiver clause.
    /// @param identifier The function identifier.
    /// @param typeParameterList Optional generic type-parameter list.
    /// @param openParenthesisToken The open parenthesis token of the parameter list.
    /// @param parameters The function's parameters.
    /// @param closeParenthesisToken The close parenthesis token of the parameter list.
    /// @param type The function's return type.
    /// @param body The function's body.
    init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        openModifier SyntaxToken?,
        overrideModifier SyntaxToken?,
        asyncModifier SyntaxToken?,
        functionKeyword SyntaxToken,
        receiverOpenParenthesisToken SyntaxToken?,
        receiver ParameterSyntax?,
        receiverCloseParenthesisToken SyntaxToken?,
        identifier SyntaxToken,
        typeParameterList TypeParameterListSyntax?,
        openParenthesisToken SyntaxToken,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeParenthesisToken SyntaxToken,
        type TypeClauseSyntax?,
        body BlockStatementSyntax?
    ) : base(syntaxTree) {
        AccessibilityModifier = accessibilityModifier
        OpenModifier = openModifier
        OverrideModifier = overrideModifier
        AsyncModifier = asyncModifier
        StaticModifier = nil
        FunctionKeyword = functionKeyword
        ReceiverOpenParenthesisToken = receiverOpenParenthesisToken
        Receiver = receiver
        ReceiverCloseParenthesisToken = receiverCloseParenthesisToken
        Identifier = identifier
        TypeParameterList = typeParameterList
        OpenParenthesisToken = openParenthesisToken
        Parameters = parameters
        CloseParenthesisToken = closeParenthesisToken
        Type = type
        Body = body
    }

    /// Gets or sets the optional `;` token that takes the place of the
    /// function body for a `@DllImport`-annotated P/Invoke declaration
    /// (ADR-0086 / issue #727). When non-null, (cref:Body) is `null`
    /// and the declaration is a P/Invoke stub whose implementation lives in an
    /// unmanaged library. Assigned by the parser; `null` for ordinary
    /// function declarations.
    prop SemicolonBodyToken SyntaxToken? {
        get -> semicolonBodyToken
        set {
            semicolonBodyToken = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this declaration uses a
    /// `;` body marker instead of a block body (ADR-0086).
    prop HasSemicolonBody bool -> SemicolonBodyToken != nil

    /// Gets or sets the optional `partial` contextual modifier (ADR-0192 /
    /// issue #4301) preceding this method's `func` keyword. When non-null
    /// the declaration is one part of a partial method: either the
    /// <em>declaring</em> part ((cref:HasSemicolonBody) is `true` —
    /// signature and annotations only) or the <em>implementing</em> part
    /// ((cref:Body) is non-null). `PartialMethodMerger` collapses
    /// the two parts into a single declaration before the body binder runs, so
    /// a merged node carries this token but has a real body. Deliberately NOT
    /// `[SyntaxChildIgnore]`: the token must participate in child
    /// enumeration so (cref:SyntaxNode.Span) covers it and tooling that
    /// walks the tree sees it. Assigned by the parser; `null` for an
    /// ordinary method.
    prop PartialModifier SyntaxToken? {
        get -> partialModifier
        set {
            partialModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this declaration carries the `partial` contextual modifier
    /// (ADR-0192).
    prop IsPartial bool -> PartialModifier != nil

    /// Gets or sets the <em>declaring</em> part this node was merged from
    /// (ADR-0192). Non-`null` only on the synthetic node
    /// `PartialMethodMerger` builds from a declaring/implementing pair. The
    /// merger builds that node fresh on every bind from the untouched parsed
    /// parts; it never stores it back into the tree. The binder uses this to
    /// bind the declaring part's own signature in its own file's scope and to
    /// find its `///` comment, and tooling can report both part locations.
    /// `[SyntaxChildIgnore]`: the declaring part's tokens already belong to
    /// their own declaration in its own file, so re-parenting them here would
    /// double-count them in child enumeration and stretch this node's
    /// (cref:SyntaxNode.Span) across two files.
    @SyntaxChildIgnore
    prop DeclaringPart FunctionDeclarationSyntax?

    /// Gets or sets the <em>implementing</em> part this node was merged from
    /// (ADR-0192). Non-`null` only alongside
    /// (cref:DeclaringPart), on the same synthetic merged node. The
    /// merged node's own tokens and body are copied from this part, but its
    /// node identity is not, and `DocumentationAttacher` indexes
    /// `///` comments by node reference — so a comment written only on
    /// the implementing part is found through this reference.
    /// `[SyntaxChildIgnore]` for the same reason as
    /// (cref:DeclaringPart).
    @SyntaxChildIgnore
    prop ImplementingPart FunctionDeclarationSyntax?

    /// Gets or sets the GS0611 aspect the syntax-level consistency check
    /// reported for the pair this merged node was built from, or
    /// `null` when the parts agreed (ADR-0192). The merge
    /// proceeds either way; the binder's cross-file semantic signature check
    /// skips a pair that already disagreed, since past that point it could
    /// only add cascading diagnostics.
    prop PartsDisagreement string?

    /// Gets the optional open parenthesis introducing the receiver clause (Phase 3.B.6).
    prop ReceiverOpenParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets the optional receiver parameter that turns this function into an extension function (Phase
    /// 3.B.6, ADR-0019). `null` for ordinary free functions and class methods.
    prop Receiver ParameterSyntax? {
        get;
    }

    /// Gets the optional close parenthesis terminating the receiver clause (Phase 3.B.6).
    prop ReceiverCloseParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this declaration carries a Go-style receiver clause (Phase 3.B.6
    /// extension function).
    prop IsExtension bool -> Receiver != nil

    /// Gets or sets the optional open parenthesis introducing a dedicated
    /// explicit-interface-implementation qualifier clause, e.g. `func (IFoo) M(...)`
    /// (ADR-0149). Distinct from (cref:ReceiverOpenParenthesisToken) — this is a
    /// single-type qualifier, not a name+type extension receiver. Assigned by the parser;
    /// `null` for an ordinary or extension function.
    prop ExplicitInterfaceOpenParenthesisToken SyntaxToken? {
        get -> explicitInterfaceOpenParenToken
        set {
            explicitInterfaceOpenParenToken = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the interface type referenced by the explicit-interface qualifier
    /// clause (ADR-0149), e.g. the `IFoo` in `func (IFoo) M(...)`. Assigned by
    /// the parser; `null` when no clause is present.
    prop ExplicitInterfaceType TypeClauseSyntax? {
        get -> explicitInterfaceType
        set {
            explicitInterfaceType = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the optional close parenthesis terminating the explicit-interface qualifier clause
    /// (ADR-0149).
    prop ExplicitInterfaceCloseParenthesisToken SyntaxToken? {
        get -> explicitInterfaceCloseParenToken
        set {
            explicitInterfaceCloseParenToken = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this declaration carries an explicit-interface qualifier clause
    /// (ADR-0149).
    prop HasExplicitInterfaceClause bool -> ExplicitInterfaceType != nil

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.FunctionDeclaration

    /// Gets the optional accessibility modifier token (`public`/`internal`/`private`), or `null` if none
    /// was supplied.
    prop AccessibilityModifier SyntaxToken? {
        get;
    }

    /// Gets the optional `open` modifier (Phase 3.B.3 sub-step 3). Non-null marks the method as overridable
    /// per ADR-0017. Only meaningful on class methods.
    prop OpenModifier SyntaxToken? {
        get;
    }

    /// Gets the optional `override` modifier (Phase 3.B.3 sub-step 3). Non-null marks the method as
    /// overriding a base method per ADR-0017. Only meaningful on class methods.
    prop OverrideModifier SyntaxToken? {
        get;
    }

    /// Gets the optional `async` or `suspend` modifier. An `async` token (Phase 5.1 / ADR-0023) makes this
    /// an async function: callers see `Task[T]` (or `Task`), and the body may use `await`. A `suspend`
    /// token (ADR-0174 D4) makes it a suspending function: callers see `T` and await it implicitly, the
    /// body may use `await`, and the emitted method returns `ValueTask[T]`.
    prop AsyncModifier SyntaxToken? {
        get;
    }

    /// Gets or sets the optional `static` contextual keyword (ADR-0089 / issue #755). Non-null when the
    /// function was declared inside `interface { … }` as a static-virtual member; the binder rejects this
    /// token on non-interface members.
    @SyntaxChildIgnore
    prop StaticModifier SyntaxToken? {
        get -> staticModifier
        set {
            staticModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this function carries a `static` contextual keyword (ADR-0089).
    prop HasStaticModifier bool -> StaticModifier != nil

    /// Gets a value indicating whether this function declares `async`.
    prop IsAsync bool -> AsyncModifier?.Kind == SyntaxKind.AsyncKeyword

    /// Gets a value indicating whether this function declares `suspend` (ADR-0174 D4).
    prop IsSuspend bool -> AsyncModifier?.Kind == SyntaxKind.SuspendKeyword

    /// Gets a value indicating whether this function is marked `open`.
    prop IsOpen bool -> OpenModifier != nil

    /// Gets a value indicating whether this function is marked `override`.
    prop IsOverride bool -> OverrideModifier != nil

    /// Gets or sets the optional `ref` contextual modifier preceding the function's
    /// return type clause (issue #490 / ADR-0060 follow-up), e.g.
    /// `func max(...) ref int32 { ... }`. When non-null, the function returns a
    /// managed pointer to its declared return type and callers receive a `T&`.
    /// Assigned by the parser; `null` otherwise.
    prop ReturnRefModifier SyntaxToken? {
        get -> returnRefModifier
        set {
            returnRefModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this function declares a `ref` return (issue #490).
    prop IsRefReturn bool -> ReturnRefModifier != nil

    /// Gets or sets the contextual `readonly` token following a return's `ref`.
    prop ReturnReadOnlyModifier SyntaxToken? {
        get -> returnReadOnlyModifier
        set {
            returnReadOnlyModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the optional `unsafe` contextual modifier (ADR-0122 / issue #1014)
    /// contextual modifier preceding `func` (e.g. `unsafe func F(...)`).
    /// When non-null the function body is an `unsafe` context: unmanaged
    /// raw pointers (`*T` → CLR `ELEMENT_TYPE_PTR`) and raw-pointer
    /// operations are permitted in its signature and body. Assigned by the
    /// parser; `null` otherwise.
    prop UnsafeModifier SyntaxToken? {
        get -> unsafeModifier
        set {
            unsafeModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this function is marked `unsafe` (ADR-0122 / issue #1014).
    prop IsUnsafe bool -> UnsafeModifier != nil

    /// Gets or sets a value indicating whether this declaration is a user-defined
    /// conversion operator (issue #1017), declared as
    /// `func operator implicit (x T) U { … }` or the `explicit` variant.
    /// When `true` the binder models the declaration as a static
    /// `op_Implicit`/`op_Explicit` special-name method on the owning
    /// user type. Assigned by the parser.
    prop IsConversionOperator bool

    /// Gets or sets a value indicating whether this conversion operator is an
    /// `explicit` conversion (`op_Explicit`) rather than an
    /// `implicit` one (`op_Implicit`). Only meaningful when
    /// (cref:IsConversionOperator) is `true`. Assigned by
    /// the parser.
    prop ConversionIsExplicit bool

    /// Gets the func keyword.
    prop FunctionKeyword SyntaxToken {
        get;
    }

    /// Gets or sets the retired ADR-0165 `extension` marker token from
    /// `func extension (receiver Type) Name(...)`, when the parser
    /// recognized that shape. ADR-0182 retired the marker (every receiver
    /// clause is unconditionally an extension now), so this token exists
    /// only to preserve full-fidelity source text for the declaration the
    /// parser reported `GS0587` against; it carries no semantic
    /// meaning and binding never reads it.
    prop RetiredExtensionKeyword SyntaxToken? {
        get -> retiredExtensionKeyword
        set {
            retiredExtensionKeyword = value
            InvalidateCachedSpan()
        }
    }

    /// Gets the function identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the optional generic type-parameter list (e.g. `[T any, U any]`); `null` for non-generic
    /// functions. Phase 4.1 / ADR-0020.
    prop TypeParameterList TypeParameterListSyntax? {
        get;
    }

    /// Gets a value indicating whether this function declares one or more type parameters (Phase 4.1).
    prop IsGeneric bool -> TypeParameterList != nil

    /// Gets the open parenthesis token.
    prop OpenParenthesisToken SyntaxToken {
        get;
    }

    /// Gets the function's parameters.
    prop Parameters SeparatedSyntaxList[ParameterSyntax] {
        get;
    }

    /// Gets the close parenthesis token.
    prop CloseParenthesisToken SyntaxToken {
        get;
    }

    /// Gets the function's type.
    prop Type TypeClauseSyntax? {
        get;
    }

    /// Gets the function's body.
    prop Body BlockStatementSyntax? {
        get;
    }
}
