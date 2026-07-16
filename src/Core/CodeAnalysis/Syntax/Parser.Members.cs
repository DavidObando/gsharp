// <copyright file="Parser.Members.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

public partial class Parser
{
    /// <summary>
    /// ADR-0068 / issue #698: parses a class-body destructor declaration
    /// <c>deinit { body }</c>. The keyword carries no parameters, no return
    /// type, no accessibility modifier. A malformed parameter list (the user
    /// wrote <c>deinit(...)</c>) is consumed and diagnosed so the parser can
    /// still locate the body block and recover.
    /// </summary>
    private DeinitDeclarationSyntax ParseDeinitDeclaration()
    {
        var deinitKeyword = NextToken(); // consume the contextual "deinit" identifier

        if (Current.Kind == SyntaxKind.OpenParenthesisToken)
        {
            // `deinit(...)` is invalid — destructors take no parameters. Emit
            // a diagnostic at the paren location and consume up to the matching
            // close paren so we still see the body block.
            Diagnostics.ReportDeinitMayNotDeclareParameters(Current.Location);
            NextToken(); // consume '('
            var depth = 1;
            while (depth > 0 && Current.Kind != SyntaxKind.EndOfFileToken && Current.Kind != SyntaxKind.OpenBraceToken)
            {
                if (Current.Kind == SyntaxKind.OpenParenthesisToken)
                {
                    depth++;
                }
                else if (Current.Kind == SyntaxKind.CloseParenthesisToken)
                {
                    depth--;
                    if (depth == 0)
                    {
                        NextToken(); // consume ')'
                        break;
                    }
                }

                NextToken();
            }
        }

        if (Current.Kind != SyntaxKind.OpenBraceToken)
        {
            // `deinit T { ... }` (a stray return type) and similar shapes —
            // emit a diagnostic at whatever token sits before the body and
            // consume tokens until we find `{`.
            Diagnostics.ReportDeinitMayNotDeclareReturnType(Current.Location);
            while (Current.Kind != SyntaxKind.OpenBraceToken
                   && Current.Kind != SyntaxKind.CloseBraceToken
                   && Current.Kind != SyntaxKind.EndOfFileToken)
            {
                NextToken();
            }
        }

        var body = ParseBlockStatement();
        return new DeinitDeclarationSyntax(syntaxTree, deinitKeyword, body);
    }

    /// <summary>
    /// Issue #306: parses a standalone user-defined constructor
    /// <c>init(params) [: base(args)] { body }</c> inside a class body.
    /// ADR-0065 §2: accepts an optional leading <c>convenience</c> contextual
    /// modifier passed in by the caller.
    /// </summary>
    private ConstructorDeclarationSyntax ParseConstructorDeclaration(SyntaxToken accessibilityModifier, SyntaxToken convenienceModifier = null)
    {
        var initKeyword = NextToken(); // consume the contextual "init" identifier
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseParameterList();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);

        SyntaxToken baseColon = null;
        SyntaxToken baseKeyword = null;
        SyntaxToken baseOpenParen = null;
        SeparatedSyntaxList<ExpressionSyntax> baseArguments = new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty);
        SyntaxToken baseCloseParen = null;
        if (Current.Kind == SyntaxKind.ColonToken)
        {
            baseColon = MatchToken(SyntaxKind.ColonToken);
            baseKeyword = MatchToken(SyntaxKind.IdentifierToken);
            baseOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken);
            baseArguments = ParseArguments();
            baseCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        }

        var body = ParseBlockStatement();

        return new ConstructorDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            convenienceModifier,
            initKeyword,
            openParen,
            parameters,
            closeParen,
            baseColon,
            baseKeyword,
            baseOpenParen,
            baseArguments,
            baseCloseParen,
            body);
    }

    private SharedBlockSyntax ParseSharedBlock()
    {
        var sharedKeyword = NextToken(); // consume the contextual "shared" identifier
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        var fields = ImmutableArray.CreateBuilder<FieldDeclarationSyntax>();
        var properties = ImmutableArray.CreateBuilder<PropertyDeclarationSyntax>();
        var events = ImmutableArray.CreateBuilder<EventDeclarationSyntax>();
        var methods = ImmutableArray.CreateBuilder<FunctionDeclarationSyntax>();
        var initBlocks = ImmutableArray.CreateBuilder<StaticInitializerBlockSyntax>();

        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            // Issue #797: each shared-block member may be preceded by
            // Kotlin-style `@Foo` annotations (ADR-0047 §3), mirroring the
            // instance-member surface in ParseAggregateDeclaration. The default
            // target follows the member kind (field/method/property/event).
            var memberAnnotations = ParseAnnotations();

            SyntaxToken memberAccessibility = null;
            if (Current.Kind == SyntaxKind.PublicKeyword ||
                Current.Kind == SyntaxKind.InternalKeyword ||
                Current.Kind == SyntaxKind.PrivateKeyword ||
                Current.Kind == SyntaxKind.ProtectedKeyword)
            {
                var ahead = 1;
                while (Peek(ahead).Kind == SyntaxKind.OpenKeyword || Peek(ahead).Kind == SyntaxKind.OverrideKeyword)
                {
                    ahead++;
                }

                if (Peek(ahead).Kind == SyntaxKind.AsyncKeyword && Peek(ahead + 1).Kind == SyntaxKind.FuncKeyword)
                {
                    ahead++;
                }

                if (Peek(ahead).Kind == SyntaxKind.FuncKeyword ||
                    (Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "prop") ||
                    (Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "event"))
                {
                    memberAccessibility = NextToken();
                }
            }

            // Issue #502: `async` modifier is allowed on static methods inside
            // a `shared` block, mirroring the instance-method path above.
            SyntaxToken sharedMemberAsyncModifier = null;
            if (Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
            {
                sharedMemberAsyncModifier = NextToken();
            }

            // ADR-0122 / issue #1036: optional `unsafe` contextual modifier on a
            // static `func` method inside a `shared` block, mirroring the
            // instance-method path. Consumed only when immediately followed by
            // `func` (or `async func`), so its SIGNATURE binds in an unsafe
            // context too (the binder consults the per-method `IsUnsafe` flag).
            SyntaxToken sharedMemberUnsafeModifier = null;
            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "unsafe"
                && (Peek(1).Kind == SyntaxKind.FuncKeyword || Peek(1).Kind == SyntaxKind.AsyncKeyword))
            {
                sharedMemberUnsafeModifier = NextToken();
                if (sharedMemberAsyncModifier == null && Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
                {
                    sharedMemberAsyncModifier = NextToken();
                }
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "init"
                && Peek(1).Kind == SyntaxKind.OpenBraceToken)
            {
                // ADR-0140 / issue #2131: an `init { … }` static-initializer
                // block inside a `shared` block. `init` is contextual — it is
                // only special as the first token of a shared-block member,
                // immediately followed by `{`. Its statements emit into the
                // type's `.cctor` after the static-field initializers.
                if (sharedMemberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(sharedMemberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                if (memberAccessibility != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberAccessibility.Location, memberAccessibility.Kind, SyntaxKind.IdentifierToken);
                }

                var initKeyword = NextToken();
                var initBody = ParseBlockStatement();
                initBlocks.Add(new StaticInitializerBlockSyntax(syntaxTree, initKeyword, initBody));
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop")
            {
                if (sharedMemberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(sharedMemberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                var property = ParsePropertyDeclaration(memberAccessibility, null, null);
                property.WithAnnotations(memberAnnotations);
                properties.Add(property);
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "event")
            {
                if (sharedMemberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(sharedMemberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                var eventDecl = ParseEventDeclaration(memberAccessibility, null, null);
                eventDecl.WithAnnotations(memberAnnotations);
                events.Add(eventDecl);
            }
            else if (Current.Kind == SyntaxKind.FuncKeyword)
            {
                FunctionDeclarationSyntax method;
                if (sharedMemberUnsafeModifier != null)
                {
                    this.unsafeDepth++;
                }

                try
                {
                    method = (FunctionDeclarationSyntax)ParseFunctionDeclaration(memberAccessibility, openModifier: null, overrideModifier: null, sharedMemberAsyncModifier);
                }
                finally
                {
                    if (sharedMemberUnsafeModifier != null)
                    {
                        this.unsafeDepth--;
                    }
                }

                method.WithAnnotations(memberAnnotations);
                if (sharedMemberUnsafeModifier != null)
                {
                    method.UnsafeModifier = sharedMemberUnsafeModifier;
                }

                methods.Add(method);
            }
            else
            {
                if (sharedMemberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(sharedMemberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                fields.Add(ParseFieldDeclaration().WithAnnotations(memberAnnotations));
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new SharedBlockSyntax(
            syntaxTree,
            sharedKeyword,
            openBrace,
            fields.ToImmutable(),
            properties.ToImmutable(),
            events.ToImmutable(),
            methods.ToImmutable(),
            initBlocks.ToImmutable(),
            closeBrace);
    }

    private InterfaceDeclarationSyntax ParseInterfaceDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        TypeParameterListSyntax typeParameterList,
        SyntaxToken sealedModifier)
    {
        var interfaceKeyword = MatchToken(SyntaxKind.InterfaceKeyword);
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        var properties = ImmutableArray.CreateBuilder<PropertyDeclarationSyntax>();
        var events = ImmutableArray.CreateBuilder<EventDeclarationSyntax>();
        var methods = ImmutableArray.CreateBuilder<FunctionDeclarationSyntax>();
        var staticFields = ImmutableArray.CreateBuilder<FieldDeclarationSyntax>();
        var seenSharedBlock = false;
        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            // Per ADR-0018, interface members are method signatures only.
            // ADR-0051 extends this to also allow property declarations.
            // ADR-0052 extends this to also allow event declarations.
            // Issue #865 revision: static-virtual members (ADR-0089) live in a
            // `shared { … }` block. No accessibility / open / override
            // modifiers are accepted on plain method signatures.
            // Issue #2129: interface members accept Kotlin-style @annotations
            // (ADR-0047) like class members — parse them here and attach to the
            // property / event / method signature that follows.
            var annotations = ParseAnnotations();

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "shared" && Peek(1).Kind == SyntaxKind.OpenBraceToken)
            {
                ParseInterfaceSharedBlock(methods, properties, staticFields, ref seenSharedBlock, identifier.Text);
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop")
            {
                properties.Add(ParsePropertyDeclaration(accessibilityModifier: null, openModifier: null, overrideModifier: null).WithAnnotations(annotations));
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "event")
            {
                events.Add(ParseEventDeclaration(accessibilityModifier: null, openModifier: null, overrideModifier: null).WithAnnotations(annotations));
            }
            else if (IsInterfaceMethodSignatureStart())
            {
                methods.Add((FunctionDeclarationSyntax)ParseInterfaceMethodSignature().WithAnnotations(annotations));
            }
            else
            {
                Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.FuncKeyword);
                NextToken();
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        var nestedInterfaceDecl = new InterfaceDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            typeParameterList,
            sealedModifier,
            interfaceKeyword,
            openBrace,
            properties.ToImmutable(),
            events.ToImmutable(),
            methods.ToImmutable(),
            closeBrace);
        nestedInterfaceDecl.StaticFields = staticFields.ToImmutable();
        return nestedInterfaceDecl;
    }

    /// <summary>
    /// ADR-0090 / issue #756: returns true if the current token starts an
    /// interface (instance) method signature. The recognised starts are:
    /// <list type="bullet">
    ///   <item><c>func</c></item>
    ///   <item><c>private func</c> (private instance helper)</item>
    /// </list>
    /// Static-virtual members (ADR-0089) and static private helpers (ADR-0090)
    /// are declared inside a <c>shared { … }</c> block on the interface
    /// (issue #865 revision); the <c>static</c> contextual keyword is no
    /// longer recognised on interface members.
    /// </summary>
    private bool IsInterfaceMethodSignatureStart()
    {
        if (Current.Kind == SyntaxKind.FuncKeyword)
        {
            return true;
        }

        if (Current.Kind == SyntaxKind.PrivateKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
        {
            return true;
        }

        return false;
    }

    private FunctionDeclarationSyntax ParseInterfaceMethodSignature()
    {
        // ADR-0090 / issue #756: an optional `private` accessibility modifier
        // may precede the `func` token, marking the method a private instance
        // helper. The binder wires private interface members into
        // <c>InterfaceSymbol.PrivateMethods</c> and emits
        // <c>MethodAttributes.Private | HideBySig</c>.
        //
        // Issue #865 revision: static-virtual interface members (ADR-0089) are
        // now declared inside a `shared { … }` block (see
        // <see cref="ParseInterfaceSharedBlock"/>); the `static` contextual
        // keyword is no longer parsed here.
        SyntaxToken accessibilityModifier = null;
        if (Current.Kind == SyntaxKind.PrivateKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
        {
            accessibilityModifier = NextToken();
        }

        return ParseInterfaceMethodSignatureCore(accessibilityModifier, staticModifier: null);
    }

    /// <summary>
    /// Parses the shared body of an interface method signature (the part from
    /// <c>func</c> onward), shared by the instance path
    /// (<see cref="ParseInterfaceMethodSignature"/>) and the static-virtual
    /// path inside an interface <c>shared { … }</c> block
    /// (<see cref="ParseInterfaceSharedBlock"/>). When
    /// <paramref name="staticModifier"/> is non-null the resulting function is
    /// marked as a static-virtual interface member (ADR-0089); the binder reads
    /// <see cref="FunctionDeclarationSyntax.HasStaticModifier"/>.
    /// </summary>
    private FunctionDeclarationSyntax ParseInterfaceMethodSignatureCore(
        SyntaxToken accessibilityModifier,
        SyntaxToken staticModifier)
    {
        var functionKeyword = MatchToken(SyntaxKind.FuncKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);

        // Issue #1007: an interface method may be generic, declaring a
        // type-parameter list `[T]` (and constraints) between the method name
        // and the `(` parameter list, exactly as class methods and free
        // functions do (ADR-0020). Reuse the same helper so the syntax and
        // binding pipeline is identical.
        var typeParameterList = ParseOptionalTypeParameterList();
        var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseParameterList();
        var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);
        var type = ParseOptionalTypeClause();

        // ADR-0085 (issue #881 revision): interface methods MAY carry a body
        // (default-interface method). When the body is absent, the method is
        // abstract — but it MUST be terminated with a ';' no-body marker, the
        // universal bodyless-func form (matching P/Invoke, ADR-0086). When a
        // body is present, it is bound through the normal class-method body
        // pipeline and the emitter produces a CLR DIM (virtual, non-abstract);
        // a bodied method takes no ';'. ADR-0089 extends the same
        // body-vs-no-body discriminator to static-virtual (shared) members.
        BlockStatementSyntax body = null;
        SyntaxToken semicolonBody = null;
        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            body = ParseBlockStatement();
        }
        else if (Current.Kind == SyntaxKind.SemicolonToken)
        {
            semicolonBody = NextToken();
        }
        else
        {
            Diagnostics.ReportInterfaceMethodMissingSemicolon(identifier.Location, identifier.Text);
        }

        var decl = new FunctionDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            openModifier: null,
            overrideModifier: null,
            functionKeyword,
            receiverOpenParenthesisToken: null,
            receiver: null,
            receiverCloseParenthesisToken: null,
            identifier,
            typeParameterList,
            openParenthesisToken,
            parameters,
            closeParenthesisToken,
            type,
            body);
        decl.StaticModifier = staticModifier;
        decl.SemicolonBodyToken = semicolonBody;
        return decl;
    }

    /// <summary>
    /// Issue #865 revision (ADR-0089): parses a <c>shared { … }</c> block on an
    /// interface. Each member is a <c>func</c> (optionally <c>private</c>) and
    /// becomes a static-virtual interface member — abstract when the body is
    /// omitted, default when present (body-vs-no-body discriminator, mirroring
    /// the instance DIM path). The parsed functions are appended to
    /// <paramref name="methods"/> with <see cref="FunctionDeclarationSyntax.StaticModifier"/>
    /// set to the <c>shared</c> keyword token, so the binder routes them into
    /// <c>InterfaceSymbol.StaticMethods</c> /
    /// <c>InterfaceSymbol.StaticPrivateMethods</c> via the existing
    /// <see cref="FunctionDeclarationSyntax.HasStaticModifier"/> check.
    /// Non-<c>func</c> members are rejected with GS0330 (interface static state
    /// is not supported).
    /// </summary>
    private void ParseInterfaceSharedBlock(
        ImmutableArray<FunctionDeclarationSyntax>.Builder methods,
        ImmutableArray<PropertyDeclarationSyntax>.Builder properties,
        ImmutableArray<FieldDeclarationSyntax>.Builder fields,
        ref bool seenSharedBlock,
        string interfaceName)
    {
        var sharedKeyword = NextToken(); // consume the contextual "shared" identifier
        if (seenSharedBlock)
        {
            Diagnostics.ReportDuplicateSharedBlock(sharedKeyword.Location);
        }

        seenSharedBlock = true;

        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            SyntaxToken accessibilityModifier = null;
            if (Current.Kind == SyntaxKind.PrivateKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
            {
                accessibilityModifier = NextToken();
            }

            if (Current.Kind == SyntaxKind.FuncKeyword)
            {
                methods.Add(ParseInterfaceMethodSignatureCore(accessibilityModifier, sharedKeyword));
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop")
            {
                // ADR-0089 / issue #1019: a `prop` inside an interface shared
                // block is a static-virtual interface property. Mark it with
                // the `shared` keyword as its static modifier so the binder
                // routes it onto InterfaceSymbol static-property accessors.
                var propDecl = ParsePropertyDeclaration(accessibilityModifier: null, openModifier: null, overrideModifier: null);
                propDecl.StaticModifier = sharedKeyword;
                properties.Add(propDecl);

                // A bare static abstract property (`prop Name T;`) terminates
                // with a semicolon (the universal no-body marker); consume it.
                if (Current.Kind == SyntaxKind.SemicolonToken)
                {
                    NextToken();
                }
            }
            else if (Current.Kind == SyntaxKind.VarKeyword
                || Current.Kind == SyntaxKind.LetKeyword
                || Current.Kind == SyntaxKind.ConstKeyword
                || ((Current.Kind == SyntaxKind.PublicKeyword
                        || Current.Kind == SyntaxKind.InternalKeyword
                        || Current.Kind == SyntaxKind.PrivateKeyword
                        || Current.Kind == SyntaxKind.ProtectedKeyword)
                    && (Peek(1).Kind == SyntaxKind.VarKeyword
                        || Peek(1).Kind == SyntaxKind.LetKeyword
                        || Peek(1).Kind == SyntaxKind.ConstKeyword)))
            {
                // ADR-0089 / issue #1030: interface static *state*. A `var` /
                // `let` / `const` member inside an interface `shared { … }`
                // block declares a CLR static field on the interface TypeDef.
                fields.Add(ParseFieldDeclaration());
            }
            else
            {
                // Only `func` (static-virtual) members, `prop` (static-virtual
                // properties, ADR-0089/issue #1019) and `var`/`let`/`const`
                // (interface static state, issue #1030) are allowed inside an
                // interface shared block. Anything else (e.g. `event`) is
                // rejected with GS0330. Report once at the member start, then
                // skip the remainder of the offending declaration so the
                // diagnostic isn't repeated per token.
                Diagnostics.ReportInterfaceSharedMemberMustBeFunc(Current.Location, interfaceName);
                while (Current.Kind != SyntaxKind.CloseBraceToken
                    && Current.Kind != SyntaxKind.EndOfFileToken
                    && Current.Kind != SyntaxKind.FuncKeyword
                    && Current.Kind != SyntaxKind.VarKeyword
                    && Current.Kind != SyntaxKind.LetKeyword
                    && Current.Kind != SyntaxKind.ConstKeyword
                    && !(Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop")
                    && !(Current.Kind == SyntaxKind.PrivateKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword))
                {
                    NextToken();
                }
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        MatchToken(SyntaxKind.CloseBraceToken);
    }

    private PropertyDeclarationSyntax ParsePropertyDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken openModifier,
        SyntaxToken overrideModifier)
    {
        var propKeyword = MatchToken(SyntaxKind.IdentifierToken); // consumes "prop"

        // ADR-0149: optional explicit-interface qualifier clause
        // `prop (IFoo) P T` / `prop (IFoo) this[...] T`. Properties/indexers
        // have no competing receiver-clause grammar, so any `(` here
        // unambiguously starts this clause.
        SyntaxToken explicitIfaceOpenParen = null;
        TypeClauseSyntax explicitIfaceType = null;
        SyntaxToken explicitIfaceCloseParen = null;
        if (Current.Kind == SyntaxKind.OpenParenthesisToken)
        {
            (explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen) = ParseExplicitInterfaceClause();
        }

        // ADR-0118: indexer member — `prop this[<params>] T { get; set }`.
        // The property name is replaced by the contextual `this` keyword
        // followed by a bracketed index-parameter list.
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "this"
            && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken)
        {
            return ParseIndexerDeclaration(accessibilityModifier, openModifier, overrideModifier, propKeyword)
                .WithExplicitInterfaceClause(explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen);
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var type = ParseTypeClause();

        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            var accessors = ParsePropertyAccessors();
            var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
            return new PropertyDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                openModifier,
                overrideModifier,
                propKeyword,
                identifier,
                type,
                openBrace,
                accessors,
                closeBrace)
                .WithExplicitInterfaceClause(explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen);
        }

        if (Current.Kind == SyntaxKind.RightArrowToken)
        {
            // Issue #1278 / ADR-0131: an expression-bodied read-only property
            // `prop Name T -> expr`. Desugar into a single get-only accessor
            // whose body returns the expression (`{ get { return expr } }`).
            var (synthOpenBrace, getAccessor, synthCloseBrace) = SynthesizeArrowGetAccessorList();
            return new PropertyDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                openModifier,
                overrideModifier,
                propKeyword,
                identifier,
                type,
                synthOpenBrace,
                ImmutableArray.Create(getAccessor),
                synthCloseBrace)
                .WithExplicitInterfaceClause(explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen);
        }

        // Bare auto-property: prop Name Type
        return new PropertyDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            openModifier,
            overrideModifier,
            propKeyword,
            identifier,
            type,
            openBraceToken: null,
            accessors: ImmutableArray<PropertyAccessorSyntax>.Empty,
            closeBraceToken: null)
            .WithExplicitInterfaceClause(explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen);
    }

    // ADR-0118: parse the indexer member form `prop this[<params>] T { get; set }`.
    // The leading `prop` keyword has already been consumed. The `this` token is
    // current. The resulting PropertyDeclarationSyntax carries IsIndexer = true.
    private PropertyDeclarationSyntax ParseIndexerDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken openModifier,
        SyntaxToken overrideModifier,
        SyntaxToken propKeyword)
    {
        var thisKeyword = MatchToken(SyntaxKind.IdentifierToken); // consumes "this"
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var parameters = ParseIndexerParameterList();
        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        var type = ParseTypeClause();

        SyntaxToken openBrace = null;
        var accessors = ImmutableArray<PropertyAccessorSyntax>.Empty;
        SyntaxToken closeBrace = null;
        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            accessors = ParsePropertyAccessors();
            closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        }
        else if (Current.Kind == SyntaxKind.RightArrowToken)
        {
            // Issue #1278 / ADR-0131: an expression-bodied read-only indexer
            // `prop this[i T] U -> expr`, desugared into a get-only accessor.
            (openBrace, var getAccessor, closeBrace) = SynthesizeArrowGetAccessorList();
            accessors = ImmutableArray.Create(getAccessor);
        }

        return new PropertyDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            openModifier,
            overrideModifier,
            propKeyword,
            identifier: thisKeyword,
            type,
            openBrace,
            accessors,
            closeBrace)
            .WithIndexer(thisKeyword, openBracket, parameters, closeBracket);
    }

    // ADR-0118: parse the bracketed index-parameter list of an indexer member.
    // Mirrors ParseParameterList but terminates at the closing square bracket.
    private SeparatedSyntaxList<ParameterSyntax> ParseIndexerParameterList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNextParameter = true;
        while (parseNextParameter &&
               Current.Kind != SyntaxKind.CloseSquareBracketToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var parameter = ParseParameter();
            nodesAndSeparators.Add(parameter);

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                var comma = MatchToken(SyntaxKind.CommaToken);
                nodesAndSeparators.Add(comma);
            }
            else
            {
                parseNextParameter = false;
            }
        }

        return new SeparatedSyntaxList<ParameterSyntax>(nodesAndSeparators.ToImmutable());
    }

    private EventDeclarationSyntax ParseEventDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken openModifier,
        SyntaxToken overrideModifier)
    {
        var eventKeyword = MatchToken(SyntaxKind.IdentifierToken); // consumes "event"

        // ADR-0149: optional explicit-interface qualifier clause
        // `event (IFoo) Changed T`. Events have no competing receiver-clause
        // grammar, so any `(` here unambiguously starts this clause.
        SyntaxToken explicitIfaceOpenParen = null;
        TypeClauseSyntax explicitIfaceType = null;
        SyntaxToken explicitIfaceCloseParen = null;
        if (Current.Kind == SyntaxKind.OpenParenthesisToken)
        {
            (explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen) = ParseExplicitInterfaceClause();
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var type = ParseTypeClause();

        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            var accessors = ParseEventAccessors();
            var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
            return new EventDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                openModifier,
                overrideModifier,
                eventKeyword,
                identifier,
                type,
                openBrace,
                accessors,
                closeBrace)
                .WithExplicitInterfaceClause(explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen);
        }

        // Field-like event: event Name Type
        return new EventDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            openModifier,
            overrideModifier,
            eventKeyword,
            identifier,
            type,
            openBraceToken: null,
            accessors: ImmutableArray<EventAccessorSyntax>.Empty,
            closeBraceToken: null)
            .WithExplicitInterfaceClause(explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen);
    }

    private ImmutableArray<EventAccessorSyntax> ParseEventAccessors()
    {
        var accessors = ImmutableArray.CreateBuilder<EventAccessorSyntax>();

        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            if (Current.Kind == SyntaxKind.IdentifierToken &&
                (Current.Text == "add" || Current.Text == "remove" || Current.Text == "raise"))
            {
                var accessorKeyword = NextToken();

                BlockStatementSyntax body = null;
                SyntaxToken semicolon = null;
                if (Current.Kind == SyntaxKind.OpenBraceToken)
                {
                    body = ParseBlockStatement();
                }
                else if (Current.Kind == SyntaxKind.SemicolonToken)
                {
                    semicolon = NextToken();
                }

                accessors.Add(new EventAccessorSyntax(syntaxTree, accessorKeyword, body, semicolon));
            }
            else
            {
                Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.IdentifierToken);
                NextToken();
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        return accessors.ToImmutable();
    }

    private ImmutableArray<PropertyAccessorSyntax> ParsePropertyAccessors()
    {
        var accessors = ImmutableArray.CreateBuilder<PropertyAccessorSyntax>();

        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            if (Current.Kind == SyntaxKind.IdentifierToken &&
                (Current.Text == "get" || Current.Text == "set" || Current.Text == "init"))
            {
                var accessorKeyword = NextToken();

                // For set/init, optionally parse (paramName)
                SyntaxToken openParen = null;
                SyntaxToken paramIdentifier = null;
                SyntaxToken closeParen = null;
                if ((accessorKeyword.Text == "set" || accessorKeyword.Text == "init") && Current.Kind == SyntaxKind.OpenParenthesisToken)
                {
                    openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
                    paramIdentifier = MatchToken(SyntaxKind.IdentifierToken);
                    closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
                }

                // Optional body or semicolon
                BlockStatementSyntax body = null;
                SyntaxToken semicolon = null;
                if (Current.Kind == SyntaxKind.OpenBraceToken)
                {
                    body = ParseBlockStatement();
                }
                else if (Current.Kind == SyntaxKind.RightArrowToken)
                {
                    // Issue #1278 / ADR-0131: an expression-bodied accessor
                    // `get -> expr` / `set -> expr` / `init -> expr`. Desugar
                    // into an equivalent block body so binding and emit reuse
                    // the existing accessor-body path: a getter lowers to
                    // `{ return expr }` and a setter/init lowers to `{ expr }`
                    // (an expression statement, typically an assignment using
                    // the `set(name)` value parameter). Note: G# uses the `->`
                    // arrow, never the C# fat arrow `=>`, which remains a
                    // syntax error below.
                    body = ParseArrowExpressionBody(asReturn: accessorKeyword.Text == "get");
                }
                else if (Current.Kind == SyntaxKind.SemicolonToken)
                {
                    semicolon = NextToken();
                }
                else if (!IsAccessorListTerminator())
                {
                    // Issue #1273: a G# property accessor body is a block `{ }`,
                    // a `->` expression body (issue #1278), or `;` (bare/auto
                    // accessor). Unlike C#, G# has no fat-arrow `=>`
                    // expression-bodied accessor form. Anything else here (e.g.
                    // `get => e`) is a syntax error: report it loudly rather
                    // than silently skipping the tokens, which previously left a
                    // body-less accessor returning the type's default value.
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.OpenBraceToken);
                    SkipMalformedAccessorBody();
                }

                // else: bare accessor (no body, no semicolon) — valid in interfaces
                accessors.Add(new PropertyAccessorSyntax(
                    syntaxTree,
                    accessorKeyword,
                    openParen,
                    paramIdentifier,
                    closeParen,
                    body,
                    semicolon));
            }
            else
            {
                // Unknown token in accessor list — skip to avoid infinite loop.
                NextToken();
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        return accessors.ToImmutable();
    }

    // Issue #1273: a bare (body-less) property accessor is only valid when it is
    // immediately followed by another accessor keyword (`get`/`set`/`init`) or
    // the closing brace of the accessor list. Any other token means the accessor
    // body is malformed (e.g. a `=>`/`->` expression body, which G# does not
    // support).
    private bool IsAccessorListTerminator()
        => Current.Kind == SyntaxKind.CloseBraceToken
            || Current.Kind == SyntaxKind.EndOfFileToken
            || (Current.Kind == SyntaxKind.IdentifierToken
                && (Current.Text == "get" || Current.Text == "set" || Current.Text == "init"));

    // Issue #1273: recover from a malformed accessor body by skipping tokens
    // until we reach the next accessor keyword, the closing brace, or `;`. This
    // keeps the parser making progress without silently accepting the invalid
    // body.
    private void SkipMalformedAccessorBody()
    {
        while (!IsAccessorListTerminator() && Current.Kind != SyntaxKind.SemicolonToken)
        {
            if (Current.Kind == SyntaxKind.OpenBraceToken)
            {
                // A stray block — consume it as a whole so its inner braces do
                // not confuse the accessor-list loop.
                ParseBlockStatement();
                continue;
            }

            NextToken();
        }

        if (Current.Kind == SyntaxKind.SemicolonToken)
        {
            NextToken();
        }
    }

    // Issue #1278 / ADR-0131: parse the `-> expr` tail of an expression-bodied
    // member (free function, method, operator, conversion operator, property,
    // indexer, or property accessor) and synthesize an equivalent block body so
    // binding, lowering, async, and emit reuse the existing block-body path. A
    // body that yields a value (a getter, or a non-void function/property)
    // lowers to `{ return expr }` (asReturn == true); a value-less body (a void
    // function/method, or a set/init accessor) lowers to `{ expr }`, an
    // expression statement (asReturn == false). The synthesized braces reuse the
    // arrow's source position so diagnostics and spans stay anchored at the
    // member. G# spells this arrow `->` (RightArrowToken); the C# fat arrow `=>`
    // is never accepted.
    private BlockStatementSyntax ParseArrowExpressionBody(bool asReturn)
    {
        var arrowToken = MatchToken(SyntaxKind.RightArrowToken);
        var arrowPosition = arrowToken.Position;

        var expression = ParseExpression();

        var openBrace = new SyntaxToken(syntaxTree, SyntaxKind.OpenBraceToken, arrowPosition, "{", null);
        var closeBrace = new SyntaxToken(syntaxTree, SyntaxKind.CloseBraceToken, arrowPosition, "}", null);

        StatementSyntax statement;
        if (asReturn)
        {
            var returnKeyword = new SyntaxToken(syntaxTree, SyntaxKind.ReturnKeyword, arrowPosition, "return", null);
            statement = new ReturnStatementSyntax(syntaxTree, returnKeyword, expression);
        }
        else
        {
            statement = new ExpressionStatementSyntax(syntaxTree, expression);
        }

        return new BlockStatementSyntax(
            syntaxTree,
            openBrace,
            ImmutableArray.Create(statement),
            closeBrace);
    }

    // Issue #1278 / ADR-0131: synthesize the accessor list for an
    // expression-bodied read-only property or indexer `prop Name T -> expr`.
    // Produces the equivalent of `{ get { return expr } }`: a single get-only
    // accessor whose block body returns the expression, plus synthetic braces
    // for the enclosing accessor list anchored at the arrow's position.
    private (SyntaxToken OpenBrace, PropertyAccessorSyntax GetAccessor, SyntaxToken CloseBrace) SynthesizeArrowGetAccessorList()
    {
        var arrowPosition = Current.Position;
        var body = ParseArrowExpressionBody(asReturn: true);

        var getKeyword = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, arrowPosition, "get", null);
        var getAccessor = new PropertyAccessorSyntax(
            syntaxTree,
            getKeyword,
            openParenToken: null,
            parameterIdentifier: null,
            closeParenToken: null,
            body,
            semicolonToken: null);

        var openBrace = new SyntaxToken(syntaxTree, SyntaxKind.OpenBraceToken, arrowPosition, "{", null);
        var closeBrace = new SyntaxToken(syntaxTree, SyntaxKind.CloseBraceToken, arrowPosition, "}", null);
        return (openBrace, getAccessor, closeBrace);
    }

    private FieldDeclarationSyntax ParseFieldDeclaration()
    {
        SyntaxToken fieldAccessibility = null;
        if (Current.Kind == SyntaxKind.PublicKeyword ||
            Current.Kind == SyntaxKind.InternalKeyword ||
            Current.Kind == SyntaxKind.PrivateKeyword ||
            Current.Kind == SyntaxKind.ProtectedKeyword)
        {
            fieldAccessibility = NextToken();
        }

        // ADR-0122 §10 / issue #1035: a fixed-size buffer field
        // `fixed name [N]T` inside an (unsafe) struct. `fixed` is a contextual
        // keyword here (it is also the `fixed` pinning statement keyword in a
        // function body — disambiguated by the field position inside a struct
        // body). The element type and count are captured as the `[N]T` array
        // type clause; the field decays to a `*T` to the first element.
        if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "fixed"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            var fixedKeyword = NextToken();
            var fbIdentifier = MatchToken(SyntaxKind.IdentifierToken);
            var fbType = ParseTypeClause();
            return new FieldDeclarationSyntax(syntaxTree, fieldAccessibility, varOrLetKeyword: null, fbIdentifier, fbType)
                .WithFixedBuffer(fixedKeyword);
        }

        // ADR-0067: field declarations must be introduced with `var` (mutable)
        // or `let` (read-only). Issue #948 adds `const` for compile-time
        // constant fields (implicitly static and read-only). The keyword is
        // captured on the syntax node so the binder can set
        // FieldSymbol.IsReadOnly / IsConst accordingly. If the user omits the
        // keyword, surface a precise diagnostic and try to recover by treating
        // the next identifier as the field name.
        SyntaxToken varOrLetKeyword = null;
        if (Current.Kind == SyntaxKind.VarKeyword
            || Current.Kind == SyntaxKind.LetKeyword
            || Current.Kind == SyntaxKind.ConstKeyword)
        {
            varOrLetKeyword = NextToken();
        }
        else
        {
            Diagnostics.ReportFieldDeclarationRequiresVarOrLet(Current.Location);
        }

        var fieldIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var fieldType = ParseTypeClause();

        // Issue #262: optional initializer for static field declarations.
        SyntaxToken equalsToken = null;
        ExpressionSyntax initializer = null;
        if (Current.Kind == SyntaxKind.EqualsToken)
        {
            equalsToken = NextToken();
            initializer = ParseExpression();
        }

        return new FieldDeclarationSyntax(syntaxTree, fieldAccessibility, varOrLetKeyword, fieldIdentifier, fieldType, equalsToken, initializer);
    }

    private MemberSyntax ParseFunctionDeclaration(SyntaxToken accessibilityModifier)
        => ParseFunctionDeclaration(accessibilityModifier, openModifier: null, overrideModifier: null, asyncModifier: null);

    private MemberSyntax ParseFunctionDeclaration(SyntaxToken accessibilityModifier, SyntaxToken openModifier, SyntaxToken overrideModifier)
        => ParseFunctionDeclaration(accessibilityModifier, openModifier, overrideModifier, asyncModifier: null);

    private MemberSyntax ParseFunctionDeclaration(SyntaxToken accessibilityModifier, SyntaxToken openModifier, SyntaxToken overrideModifier, SyntaxToken asyncModifier)
    {
        var functionKeyword = MatchToken(SyntaxKind.FuncKeyword);

        SyntaxToken explicitIfaceOpenParen = null;
        TypeClauseSyntax explicitIfaceType = null;
        SyntaxToken explicitIfaceCloseParen = null;

        // ADR-0149: optional explicit-interface qualifier clause `func (IFoo) M(...)`.
        // Checked BEFORE the receiver clause since both start with `(' IdentifierToken;
        // see LooksLikeExplicitInterfaceClause for the disambiguation rule.
        if (Current.Kind == SyntaxKind.OpenParenthesisToken && LooksLikeExplicitInterfaceClause())
        {
            (explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen) = ParseExplicitInterfaceClause();
        }

        SyntaxToken receiverOpenParen = null;
        ParameterSyntax receiver = null;
        SyntaxToken receiverCloseParen = null;

        // Phase 3.B.6 / ADR-0019: optional Go-style receiver clause
        // `func ( recv RecvType ) Name(...)`. We only consume it when the
        // tokens unambiguously look like a receiver: open paren, identifier,
        // a type clause, close paren, followed by an identifier (the name).
        if (explicitIfaceType == null && Current.Kind == SyntaxKind.OpenParenthesisToken && LooksLikeReceiverClause())
        {
            receiverOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken);
            receiver = ParseParameter();
            receiverCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        }

        var identifier = MatchOperatorOrIdentifier(receiver != null, out var isConversionOperator, out var conversionIsExplicit);
        var typeParameterList = ParseOptionalTypeParameterList();
        var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseParameterList();
        var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);

        // Issue #490 (ADR-0060 follow-up): optional `ref` contextual modifier preceding
        // the return type clause turns this function into a ref-returning function:
        //   func max(ref a int32, ref b int32) ref int32 { return ref (a > b ? a : b) }
        // The keyword is consumed only when followed by a type-starting token, so a
        // top-level function literally named after the `ref` token is unaffected.
        SyntaxToken returnRefModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref" && CanStartTypeClause(Peek(1)))
        {
            returnRefModifier = NextToken();
        }

        var type = ParseOptionalTypeClause();

        // ADR-0086 / issue #727: a `;` in place of a `{ ... }` body marks the
        // declaration as a P/Invoke stub (`@DllImport`-annotated function with
        // no managed body). The binder validates that the annotation is
        // present and well-formed; an unannotated `;` body produces GS0325.
        BlockStatementSyntax body;
        SyntaxToken semicolonBody = null;
        if (Current.Kind == SyntaxKind.SemicolonToken)
        {
            semicolonBody = NextToken();
            body = null;
        }
        else if (Current.Kind == SyntaxKind.RightArrowToken)
        {
            // Issue #1278 / ADR-0131: an expression-bodied function/method
            // `func F(...) T -> expr`. Desugar at parse time into an equivalent
            // block body so binding, lowering, async, and emit reuse the
            // existing block-body path. A non-void function (return type
            // present) lowers to `{ return expr }`; a void function (no return
            // type clause) lowers to `{ expr }` (an expression statement),
            // mirroring C#'s expression-bodied void methods. This single path
            // also covers methods, operators (`func operator + ...`), and
            // user-defined conversion operators (`func operator implicit ...`).
            //
            // ADR-0146 (Kotlin visibility narrowing follow-up): `func F() -> object { ... }`
            // (return-type clause omitted, body is an anonymous-class literal) is the one
            // shape where an omitted return type is still treated as value-returning — the
            // binder infers the return type from the literal, narrowing it at a
            // public/protected boundary per ADR-0146's "Kotlin visibility narrowing" section.
            // Every other omitted-type arrow body keeps the existing void behavior.
            body = ParseArrowExpressionBody(asReturn: type != null || IsAnonymousClassLiteralStartAfterArrow());
        }
        else
        {
            body = ParseBlockStatement();
        }

        var decl = new FunctionDeclarationSyntax(syntaxTree, accessibilityModifier, openModifier, overrideModifier, asyncModifier, functionKeyword, receiverOpenParen, receiver, receiverCloseParen, identifier, typeParameterList, openParenthesisToken, parameters, closeParenthesisToken, type, body);
        decl.ReturnRefModifier = returnRefModifier;
        decl.SemicolonBodyToken = semicolonBody;
        decl.IsConversionOperator = isConversionOperator;
        decl.ConversionIsExplicit = conversionIsExplicit;
        decl.ExplicitInterfaceOpenParenthesisToken = explicitIfaceOpenParen;
        decl.ExplicitInterfaceType = explicitIfaceType;
        decl.ExplicitInterfaceCloseParenthesisToken = explicitIfaceCloseParen;
        return decl;
    }

    // Stream D: `func (a Point) operator +(b Point) Point { … }`. After the
    // optional receiver clause, if the current token is the contextual
    // `operator` keyword we consume it and the following operator token, then
    // synthesize an IdentifierToken whose text is the CLR op_* name (e.g.
    // `op_Addition`). Downstream binding sees a regular extension function with
    // that name; the binder later hooks `BindBinaryExpression` /
    // `BindUnaryExpression` to look up `op_*` on the user type's symbol.
    private SyntaxToken MatchOperatorOrIdentifier(bool hasReceiver, out bool isConversionOperator, out bool conversionIsExplicit)
    {
        isConversionOperator = false;
        conversionIsExplicit = false;

        if (Current.Kind != SyntaxKind.OperatorKeyword)
        {
            return MatchToken(SyntaxKind.IdentifierToken);
        }

        // Issue #1017: user-defined conversion operators are spelled
        // `func operator implicit (x T) U { … }` (or `explicit`). `implicit`
        // and `explicit` are contextual keywords recognised only immediately
        // after `operator`; elsewhere they remain ordinary identifiers. A
        // conversion operator has no receiver clause — the single parameter is
        // the source operand and the return type is the conversion target.
        if (!hasReceiver
            && Current.Kind == SyntaxKind.OperatorKeyword
            && Peek(1).Kind == SyntaxKind.IdentifierToken
            && (Peek(1).Text == "implicit" || Peek(1).Text == "explicit"))
        {
            var conversionOperatorKeyword = NextToken();
            var conversionKindToken = NextToken();
            isConversionOperator = true;
            conversionIsExplicit = conversionKindToken.Text == "explicit";
            var conversionName = conversionIsExplicit ? "op_Explicit" : "op_Implicit";
            return new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, conversionOperatorKeyword.Position, conversionName, null);
        }

        var operatorKeyword = NextToken();
        var operatorToken = NextToken();

        // Disambiguate binary vs unary by peeking the parameter list. With a
        // receiver clause, the parameter list contains only the *extra*
        // operands — empty list ⇒ unary, otherwise binary. (Free-function
        // form without a receiver is not yet wired through this path.)
        var isUnary = hasReceiver
            && Current.Kind == SyntaxKind.OpenParenthesisToken
            && Peek(1).Kind == SyntaxKind.CloseParenthesisToken;

        var name = isUnary
            ? GSharp.Core.CodeAnalysis.Binding.OperatorNames.TryGetUnaryName(operatorToken.Kind)
            : GSharp.Core.CodeAnalysis.Binding.OperatorNames.TryGetBinaryName(operatorToken.Kind)
              ?? GSharp.Core.CodeAnalysis.Binding.OperatorNames.TryGetUnaryName(operatorToken.Kind);

        if (name == null)
        {
            Diagnostics.ReportUnexpectedToken(operatorToken.Location, operatorToken.Kind, SyntaxKind.PlusToken);
            return new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, operatorKeyword.Position, "__bad_operator__", null);
        }

        return new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, operatorKeyword.Position, name, null);
    }

    private TypeParameterListSyntax ParseOptionalTypeParameterList()
    {
        // Phase 4.1 / ADR-0020: a generic type-parameter list `[T any, U any]`
        // appears immediately after the declared name of func/class/struct/
        // data struct/interface. The token following the name is unambiguously
        // either `[` (TPs) or `(` / `{` / type clause (no TPs).
        if (Current.Kind != SyntaxKind.OpenSquareBracketToken || !LooksLikeTypeParameterList())
        {
            return null;
        }

        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNext = true;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseSquareBracketToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseTypeParameter());

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        return new TypeParameterListSyntax(syntaxTree, openBracket, new SeparatedSyntaxList<TypeParameterSyntax>(nodesAndSeparators.ToImmutable()), closeBracket);
    }

    private bool LooksLikeTypeParameterList()
    {
        // We are positioned at `[`. A type parameter list looks like
        // `[ Ident (Ident|class|struct|init())? ( , ... )* ]`. Crucially the *first*
        // token after `[` is an identifier (not a number, ']', or another '['). That
        // alone is enough to disambiguate against `[]T` (slice) and `[N]T` (array shape)
        // which appear in type positions, not after declaration names anyway.
        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        // Also reject the corner case `[ Ident ]` where the bracketed segment
        // is followed by a token that would make it look like a type clause
        // (e.g. `[ Ident ] Ident` -> slice/array shape used somewhere we
        // shouldn't be). At a declaration header the follow-set after the TP
        // list is `(`, so we just look for that.
        //
        // ADR-0097 / issue #775 (constraint keyword renamed to `init()` by
        // issue #997): also skip `class`, `struct`, and `init()` constraint
        // tokens that may appear after the type-parameter name.
        var ahead = 2;
        while (true)
        {
            var k = Peek(ahead).Kind;
            if (k == SyntaxKind.IdentifierToken || k == SyntaxKind.ClassKeyword || k == SyntaxKind.StructKeyword || k == SyntaxKind.DotToken)
            {
                // `init` is lexed as an identifier; consume an optional `()` pair
                // when this identifier is the contextual `init` constraint keyword.
                if (k == SyntaxKind.IdentifierToken
                    && Peek(ahead).Text == "init"
                    && Peek(ahead + 1).Kind == SyntaxKind.OpenParenthesisToken
                    && Peek(ahead + 2).Kind == SyntaxKind.CloseParenthesisToken)
                {
                    ahead += 3;
                    continue;
                }

                // A `.` continues a qualified (dotted) constraint name
                // (e.g. `[T Namespace.Sub.IFace[T]]`); skip it and the segment
                // identifier that follows so the balanced `[ ... ]` and the
                // list-terminating `,`/`]` are examined against the right token.
                ahead++;
                continue;
            }

            // ADR-0089 / issue #943: a constraint identifier may carry a generic
            // type-argument list (e.g. the curiously-recurring `[T IComparable[T]]`).
            // Skip the balanced `[ ... ]` segment so the disambiguation following
            // it (a `,` between type parameters or the closing `]` of the whole
            // type-parameter list) is examined against the right token.
            if (k == SyntaxKind.OpenSquareBracketToken)
            {
                var depth = 0;
                while (true)
                {
                    var inner = Peek(ahead).Kind;
                    if (inner == SyntaxKind.EndOfFileToken)
                    {
                        return false;
                    }

                    if (inner == SyntaxKind.OpenSquareBracketToken)
                    {
                        depth++;
                    }
                    else if (inner == SyntaxKind.CloseSquareBracketToken)
                    {
                        depth--;
                        if (depth == 0)
                        {
                            ahead++;
                            break;
                        }
                    }

                    ahead++;
                }

                continue;
            }

            break;
        }

        if (Peek(ahead).Kind == SyntaxKind.CommaToken)
        {
            return true;
        }

        if (Peek(ahead).Kind == SyntaxKind.CloseSquareBracketToken)
        {
            // Phase 4.1: function declarations follow `[T any]` with `(`.
            // Phase 4.3 / ADR-0020: type declarations follow `[T any]` with
            // `data`/`struct`/`class`/`interface` (contextual `data` lexes as
            // an identifier; the lookahead also covers the not-yet-supported
            // `interface` case for forward compatibility).
            var follow = Peek(ahead + 1);
            if (follow.Kind == SyntaxKind.OpenParenthesisToken
                || follow.Kind == SyntaxKind.StructKeyword
                || follow.Kind == SyntaxKind.EnumKeyword
                || follow.Kind == SyntaxKind.ClassKeyword
                || follow.Kind == SyntaxKind.InterfaceKeyword
                || follow.Kind == SyntaxKind.SealedKeyword
                || follow.Kind == SyntaxKind.OpenKeyword
                || follow.Kind == SyntaxKind.EqualsToken // ADR-0059 / issue #1503: `type X[T any] = delegate func(...)` (generic named delegate).
                || follow.Kind == SyntaxKind.OpenBraceToken // ADR-0078: `class Name[T any] { ... }`.
                || follow.Kind == SyntaxKind.ColonToken // ADR-0078: `class Name[T any] : Base { ... }`.
                || (follow.Kind == SyntaxKind.IdentifierToken && (follow.Text == "data" || follow.Text == "record")))
            {
                return true;
            }
        }

        return false;
    }

    private TypeParameterSyntax ParseTypeParameter()
    {
        SyntaxToken variance = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && (Current.Text == "in" || Current.Text == "out") && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            variance = NextToken();
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken constraint = null;
        SyntaxToken openBracket = null;
        SeparatedSyntaxList<TypeClauseSyntax> constraintTypeArgs = default;
        SyntaxToken closeBracket = null;
        TypeClauseSyntax constraintTypeClause = null;

        if (Current.Kind == SyntaxKind.IdentifierToken)
        {
            // Reserve the `class`/`struct`/`init` constraints (handled below
            // as their own keyword tokens / `init`-contextual identifier) so
            // that we don't accidentally bind them as the legacy
            // any/comparable/interface-name slot.
            if (!IsAdditionalConstraintStart(Current))
            {
                // A qualified (dotted) constraint name — e.g.
                // `Namespace.Sub.IFace[T]` — cannot be represented by the single
                // `constraint` identifier token. Parse the whole thing through the
                // regular type-clause machinery (which already handles dotted names
                // and per-segment generic arguments, stopping at the `,`/`]` that
                // closes the type-parameter list). The first-segment identifier is
                // retained in `constraint` for `any`/`comparable` dispatch and
                // error locations. cs2gs emits fully-qualified constraint names, so
                // this is the common shape for translated generic-math interfaces.
                if (Peek(1).Kind == SyntaxKind.DotToken)
                {
                    constraintTypeClause = ParseTypeClause();
                    constraint = constraintTypeClause.Identifier;
                }
                else
                {
                    constraint = NextToken();

                    // ADR-0089 / issue #755: a constraint identifier may be followed by
                    // a generic type-argument list (the curiously-recurring pattern
                    // `[T IAdd[T]]` is the canonical generic-math shape required for
                    // static-virtual interface members). Parse `[ TypeClause (, TypeClause)* ]`
                    // when present; the binder constructs the closed interface from the
                    // resulting argument list.
                    if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
                    {
                        openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
                        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
                        var parseNext = true;
                        while (parseNext &&
                               Current.Kind != SyntaxKind.CloseSquareBracketToken &&
                               Current.Kind != SyntaxKind.EndOfFileToken)
                        {
                            nodesAndSeparators.Add(ParseTypeClause());
                            if (Current.Kind == SyntaxKind.CommaToken)
                            {
                                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                            }
                            else
                            {
                                parseNext = false;
                            }
                        }

                        closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
                        constraintTypeArgs = new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable());
                    }
                }
            }
        }

        // ADR-0097 / issue #775 (constraint keyword renamed to `init()` by
        // issue #997): consume any of `class`, `struct`, `init()` constraints
        // in any order. The binder validates illegal combinations (e.g.
        // `class struct`).
        SyntaxToken classKw = null;
        SyntaxToken structKw = null;
        SyntaxToken initKw = null;
        SyntaxToken initOpenParen = null;
        SyntaxToken initCloseParen = null;
        SyntaxToken unmanagedKw = null;
        while (true)
        {
            if (Current.Kind == SyntaxKind.ClassKeyword)
            {
                if (classKw == null)
                {
                    classKw = NextToken();
                }
                else
                {
                    break;
                }
            }
            else if (Current.Kind == SyntaxKind.StructKeyword)
            {
                if (structKw == null)
                {
                    structKw = NextToken();
                }
                else
                {
                    break;
                }
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken
                     && Current.Text == "unmanaged")
            {
                // Issue #1336: contextual `unmanaged` constraint keyword.
                if (unmanagedKw == null)
                {
                    unmanagedKw = NextToken();
                }
                else
                {
                    break;
                }
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken
                     && Current.Text == "init"
                     && Peek(1).Kind == SyntaxKind.OpenParenthesisToken
                     && Peek(2).Kind == SyntaxKind.CloseParenthesisToken)
            {
                if (initKw == null)
                {
                    initKw = NextToken();
                    initOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken);
                    initCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken);
                }
                else
                {
                    break;
                }
            }
            else
            {
                break;
            }
        }

        var typeParameter = new TypeParameterSyntax(
            syntaxTree,
            variance,
            identifier,
            constraint,
            openBracket,
            constraintTypeArgs,
            closeBracket,
            classKw,
            structKw,
            initKw,
            initOpenParen,
            initCloseParen,
            unmanagedKw);

        if (constraintTypeClause != null)
        {
            typeParameter.ConstraintType = constraintTypeClause;
        }

        return typeParameter;
    }

    /// <summary>
    /// ADR-0097 / issue #775 (constraint keyword renamed to <c>init()</c> by
    /// issue #997): returns <see langword="true"/> when
    /// <paramref name="token"/> begins a flag-style constraint
    /// (<c>class</c>, <c>struct</c>, or <c>init(</c>). These are handled
    /// in a dedicated post-loop after the legacy single-identifier
    /// constraint slot is parsed (<c>any</c>, <c>comparable</c>, or a
    /// sealed-interface name).
    /// </summary>
    private bool IsAdditionalConstraintStart(SyntaxToken token)
    {
        if (token.Kind == SyntaxKind.ClassKeyword || token.Kind == SyntaxKind.StructKeyword)
        {
            return true;
        }

        // Issue #1336: contextual `unmanaged` constraint keyword.
        if (token.Kind == SyntaxKind.IdentifierToken && token.Text == "unmanaged")
        {
            return true;
        }

        if (token.Kind == SyntaxKind.IdentifierToken && token.Text == "init" && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            return true;
        }

        return false;
    }

    // ADR-0149: a dedicated explicit-interface-implementation qualifier clause
    // `(InterfaceType)` immediately after a member keyword (`func`, `prop`,
    // `event`) — e.g. `func (IFoo) M(...)`, `prop (IFoo) P T`,
    // `prop (IFoo) this[...] T`, `event (IFoo) Changed T`. Reused across all
    // three member kinds via ParseOptionalExplicitInterfaceClause so the
    // grammar/parse logic lives in exactly one place.
    //
    // For `prop`/`event` there is no competing grammar (properties and events
    // never had a receiver-clause concept), so any `(` immediately following
    // the member keyword unambiguously starts this clause. For `func`, the
    // clause must be distinguished from the pre-existing Go-style receiver
    // clause (`func (recv RecvType) Name(...)`, ADR-0019): both start with
    // `(` IdentifierToken, so `LooksLikeExplicitInterfaceClause` must run
    // BEFORE `LooksLikeReceiverClause` and only claims the `(` when the token
    // right after the first identifier continues the SAME single type
    // reference — a qualified-name `.`, a generic-argument `[`, or the
    // immediate close `)` — rather than starting a second, distinct type
    // (which signals a receiver's "name Type" pair, e.g. `(recv IFoo)`).
    //
    // A single-token lookahead at the position right after the identifier is
    // NOT sufficient: `Identifier [` is ambiguous between a generic-argument
    // list on THAT SAME identifier (`IFoo[T]`, a one-type-reference explicit
    // interface clause) and the start of a receiver's array-shaped type,
    // where the identifier is the receiver NAME and `[...]T` is a SEPARATE,
    // second type (`(self []T)`, `(self [3]T)`). Both shapes begin with the
    // token sequence `(` Identifier `[`, so peeking only one token past the
    // identifier cannot tell them apart — speculatively scan a full type
    // clause instead (see below).
    private bool LooksLikeExplicitInterfaceClause()
    {
        if (Peek(0).Kind != SyntaxKind.OpenParenthesisToken)
        {
            return false;
        }

        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        // Speculatively scan a single type clause starting right after the
        // `(`, reusing the same scanner already used to disambiguate generic
        // call sites elsewhere (TryScanTypeClause). An explicit-interface
        // clause contains EXACTLY one type reference — `IFoo`, `Ns.IFoo`, or
        // `IFoo[T]` — with nothing else before the closing `)`, so we only
        // commit to this interpretation when the scan succeeds AND lands
        // exactly on the closing `)` with nothing left over. A receiver's
        // array-shaped type (`self []T`, `self [3]T`) fails this scan
        // because `self` scans as a complete type on its own (a plain
        // identifier with no generic-argument list, since `[]`/`[3]` is not
        // a valid generic-argument list) and the scan position would then
        // land on `[`, not `)` — correctly falling through to the
        // receiver-clause heuristic instead.
        var pos = 1;
        return TryScanTypeClause(ref pos) && Peek(pos).Kind == SyntaxKind.CloseParenthesisToken;
    }

    // ADR-0149: parses `(InterfaceType)` when present. The caller has already
    // confirmed (via LooksLikeExplicitInterfaceClause for `func`, or simply by
    // checking for `(` for `prop`/`event`, which have no competing grammar)
    // that the current token starts this clause.
    private (SyntaxToken OpenParen, TypeClauseSyntax Type, SyntaxToken CloseParen) ParseExplicitInterfaceClause()
    {
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var type = ParseTypeClause();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return (openParen, type, closeParen);
    }

    private bool LooksLikeReceiverClause()
    {
        // Issue #751 (ADR-0084 L2): a receiver clause has the shape
        //   '(' ident <type-clause> ')' (ident | operator) ( '(' | '[' )
        // The original implementation hard-coded a tiny subset of type-clause
        // spellings (bare identifier, `[N]T` / `[]T`). That excluded common
        // shapes like `T?`, `sequence[T]`, `map[K,V]`, `(int, T)`, and
        // combinations thereof, silently demoting an extension-method
        // declaration to a malformed regular function. Rather than mirror
        // the entire type grammar here we scan the candidate receiver as a
        // balanced bracket region: find the matching `)` of the outer
        // parenthesis (bailing on a top-level `,` which would mean a
        // multi-parameter regular parameter list, never a receiver), and
        // then verify the trailing-token shape that distinguishes a
        // receiver clause from a regular parameter list. The actual type
        // grammar is validated when the receiver is parsed for real by
        // `ParseParameter` → `ParseTypeClause` — keeping the type grammar
        // in one place.
        if (Peek(0).Kind != SyntaxKind.OpenParenthesisToken)
        {
            return false;
        }

        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        var parenDepth = 1;
        var bracketDepth = 0;
        var ahead = 2;
        var closeParenAhead = -1;
        while (true)
        {
            var kind = Peek(ahead).Kind;
            if (kind == SyntaxKind.EndOfFileToken)
            {
                return false;
            }

            // A top-level `,` means we have a multi-parameter regular
            // parameter list, not a single-parameter receiver clause.
            // Brackets (`[...]`) and inner parens nest freely; only
            // commas at the outer level disqualify.
            if (parenDepth == 1 && bracketDepth == 0 && kind == SyntaxKind.CommaToken)
            {
                return false;
            }

            switch (kind)
            {
                case SyntaxKind.OpenParenthesisToken:
                    parenDepth++;
                    break;
                case SyntaxKind.CloseParenthesisToken:
                    parenDepth--;
                    if (parenDepth == 0)
                    {
                        closeParenAhead = ahead;
                    }

                    break;
                case SyntaxKind.OpenSquareBracketToken:
                    bracketDepth++;
                    break;
                case SyntaxKind.CloseSquareBracketToken:
                    bracketDepth--;
                    if (bracketDepth < 0)
                    {
                        return false;
                    }

                    break;
            }

            if (closeParenAhead >= 0)
            {
                break;
            }

            ahead++;
        }

        // After the closing `)` we must see a function name (identifier or
        // the contextual `operator` keyword for operator-overload streams).
        ahead = closeParenAhead + 1;
        var afterCloseKind = Peek(ahead).Kind;
        if (afterCloseKind != SyntaxKind.IdentifierToken && afterCloseKind != SyntaxKind.OperatorKeyword)
        {
            return false;
        }

        // Stream D: `operator <op>(` follows the receiver clause for operator
        // overloads. Accept any non-EOF token after `operator` here — the
        // operator-token validation happens in MatchOperatorOrIdentifier.
        if (afterCloseKind == SyntaxKind.OperatorKeyword)
        {
            return Peek(ahead + 1).Kind != SyntaxKind.EndOfFileToken
                && Peek(ahead + 2).Kind == SyntaxKind.OpenParenthesisToken;
        }

        // The parameter list opens with `(`, or — for a generic extension
        // function — a type-parameter list `[T]` precedes it (Phase 4.1).
        var afterNameKind = Peek(ahead + 1).Kind;
        return afterNameKind == SyntaxKind.OpenParenthesisToken
            || afterNameKind == SyntaxKind.OpenSquareBracketToken;
    }

    private SeparatedSyntaxList<ParameterSyntax> ParseParameterList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNextParameter = true;
        while (parseNextParameter &&
               Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var parameter = ParseParameter();
            nodesAndSeparators.Add(parameter);

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                var comma = MatchToken(SyntaxKind.CommaToken);
                nodesAndSeparators.Add(comma);
            }
            else
            {
                parseNextParameter = false;
            }
        }

        return new SeparatedSyntaxList<ParameterSyntax>(nodesAndSeparators.ToImmutable());
    }

    private ParameterSyntax ParseParameter()
    {
        // ADR-0047: parameter-level annotations precede the identifier.
        var annotations = ParseAnnotations();

        // ADR-0058 / issue #376: optional `scoped` contextual modifier precedes the identifier.
        // Disambiguate: `scoped` is only a modifier when followed by another identifier (the
        // parameter name). If the current token IS the parameter name (no following identifier),
        // treat it as the identifier, not as a modifier.
        SyntaxToken scopedModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "scoped"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            scopedModifier = NextToken();
        }

        // ADR-0060: optional `ref`/`out`/`in` contextual modifier immediately precedes the
        // parameter identifier (after the optional `scoped`). Disambiguation rule: the
        // modifier is only consumed when the next token is an identifier (the parameter
        // name). If `ref` / `out` / `in` IS the parameter name (no following identifier),
        // treat it as the identifier itself.
        SyntaxToken refKindModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken
            && (Current.Text == "ref" || Current.Text == "out" || Current.Text == "in")
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            refKindModifier = NextToken();
        }

        // ADR-0101 / issue #799: the C# `params` keyword is intentionally NOT
        // part of the G# parameter grammar — the canonical variadic spelling
        // is `name ...T` (Go-style). Detect the C# pattern `params <ident>`
        // and emit a focused diagnostic (GS0363) before recovering by
        // skipping the keyword and continuing to parse the rest as a regular
        // parameter. This stops the user from hitting a cryptic "expected
        // identifier" error and points them at the canonical spelling.
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "params"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            var paramsToken = NextToken();
            Diagnostics.ReportParamsKeywordNotSupported(paramsToken.Location);
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken ellipsis = null;
        if (Current.Kind == SyntaxKind.EllipsisToken)
        {
            ellipsis = MatchToken(SyntaxKind.EllipsisToken);
        }

        var type = ParseTypeClause();

        // ADR-0063: optional default-value clause. Parsed as a general expression here;
        // the binder enforces the "compile-time constant representable in CLR parameter
        // metadata" rule and emits diagnostics on misuse.
        SyntaxToken equalsToken = null;
        ExpressionSyntax defaultValue = null;
        if (Current.Kind == SyntaxKind.EqualsToken)
        {
            equalsToken = NextToken();
            defaultValue = ParseExpression();
        }

        var parameter = new ParameterSyntax(syntaxTree, identifier, ellipsis, type).WithAnnotations(annotations);
        parameter.ScopedModifier = scopedModifier;
        parameter.RefKindModifier = refKindModifier;
        parameter.EqualsToken = equalsToken;
        parameter.DefaultValue = defaultValue;
        return parameter;
    }
}
