// <copyright file="Parser.Declarations.2.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// The GSharp language parser.
/// </summary>

public partial class Parser
{


    private SeparatedSyntaxList<EnumMemberSyntax> ParseEnumMembers()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            // Issue #188 / ADR-0047 §3: each enum-member entry may be
            // preceded by Kotlin-style `@Foo` annotations (default target
            // `field`, since enum members are emitted as static literal
            // fields on the enum type per ECMA-335 §I.8.5.2).
            var annotations = ParseAnnotations();
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var member = new EnumMemberSyntax(syntaxTree, identifier).WithAnnotations(annotations);

            // ADR-0078 / issue #725: discriminated-union enum case may carry
            // a payload as a primary-constructor parameter list:
            //   enum Shape { Circle(r float64); Square(s float64) }
            // We accept either `;` or `,` between cases — `;` is the canonical
            // separator when payloads are present.
            if (Current.Kind == SyntaxKind.OpenParenthesisToken)
            {
                member.PayloadOpenParenthesis = MatchToken(SyntaxKind.OpenParenthesisToken);
                member.PayloadParameters = ParseParameterList();
                member.PayloadCloseParenthesis = MatchToken(SyntaxKind.CloseParenthesisToken);
            }

            nodesAndSeparators.Add(member);

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else if (Current.Kind == SyntaxKind.SemicolonToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.SemicolonToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<EnumMemberSyntax>(nodesAndSeparators.ToImmutable());
    }

    private StructDeclarationSyntax ParseStructDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken dataKeyword,
        SyntaxToken inlineKeyword,
        SyntaxToken openModifier,
        SyntaxToken preconsumedStructOrClassKeyword = null)
    {
        var structOrClassKeyword = preconsumedStructOrClassKeyword ?? (Current.Kind == SyntaxKind.ClassKeyword
            ? MatchToken(SyntaxKind.ClassKeyword)
            : MatchToken(SyntaxKind.StructKeyword));

        // Modifier validation (inline only on struct, open only on class, data
        // combination rules) is now performed in the caller — either
        // ParseAggregateDeclaration (new grammar, ADR-0078) or
        // ParseTypeAliasDeclaration (legacy grammar, GS0306).

        // Phase 3.B.3 sub-step 2: optional Kotlin-style primary constructor
        // parameter list `(name Type, name Type, ...)` directly after the
        // `class` keyword. Each parameter becomes both a ctor argument and a
        // public field of the same name. Both classes and structs accept a
        // primary constructor parameter list.
        SyntaxToken primaryCtorOpenParen = null;
        SyntaxToken primaryCtorCloseParen = null;
        SeparatedSyntaxList<ParameterSyntax> primaryCtorParameters = new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty);
        if (Current.Kind == SyntaxKind.OpenParenthesisToken)
        {
            primaryCtorOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken);
            primaryCtorParameters = ParseParameterList();
            primaryCtorCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        }

        // Phase 3.B.3 sub-step 3: optional base clause `: Base`.
        // Phase 3.B.4 extends this to `: Base, IFoo, IBar` — a comma-separated
        // list. The binder classifies each identifier as either the base class
        // (at most one, must come first) or an implemented interface.
        // ADR-0078: structs may carry an implemented-interface clause too;
        // earlier parser-level restrictions are dropped (binder enforces
        // semantic legality, e.g. structs may not have a base class).
        SyntaxToken baseColon = null;
        SyntaxToken baseTypeIdentifier = null;
        SyntaxToken baseCtorOpenParen = null;
        SeparatedSyntaxList<ExpressionSyntax> baseCtorArguments = new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty);
        SyntaxToken baseCtorCloseParen = null;
        var additionalBaseIdentifiers = ImmutableArray.CreateBuilder<SyntaxToken>();
        var baseTypeClauseNodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var baseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(ImmutableArray<SyntaxNode>.Empty);
        if (Current.Kind == SyntaxKind.ColonToken)
        {
            baseColon = MatchToken(SyntaxKind.ColonToken);
            var firstBaseType = ParseTypeClause();
            baseTypeClauseNodesAndSeparators.Add(firstBaseType);
            baseTypeIdentifier = firstBaseType.DottedName == null
                ? null
                : new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, firstBaseType.Identifier.Position, firstBaseType.DottedName, null);

            // Issue #306: optional base-constructor argument list immediately
            // after the base-class name, e.g. `: Exception(message)`. Only the
            // base class (the first identifier) may carry constructor arguments;
            // interfaces never do. The arguments are bound against the base
            // class's constructors and forwarded by the derived ctor.
            if (Current.Kind == SyntaxKind.OpenParenthesisToken)
            {
                baseCtorOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken);
                baseCtorArguments = ParseArguments();
                baseCtorCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken);
            }

            while (Current.Kind == SyntaxKind.CommaToken)
            {
                var comma = MatchToken(SyntaxKind.CommaToken);
                baseTypeClauseNodesAndSeparators.Add(comma);
                var nextType = ParseTypeClause();
                baseTypeClauseNodesAndSeparators.Add(nextType);
                var next = nextType.DottedName == null
                    ? null
                    : new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, nextType.Identifier.Position, nextType.DottedName, null);
                additionalBaseIdentifiers.Add(next);
            }

            baseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(baseTypeClauseNodesAndSeparators.ToImmutable());
        }

        SyntaxToken openBrace;
        var fields = ImmutableArray.CreateBuilder<FieldDeclarationSyntax>();
        var properties = ImmutableArray.CreateBuilder<PropertyDeclarationSyntax>();
        var events = ImmutableArray.CreateBuilder<EventDeclarationSyntax>();
        var methods = ImmutableArray.CreateBuilder<FunctionDeclarationSyntax>();
        var constructors = ImmutableArray.CreateBuilder<ConstructorDeclarationSyntax>();
        DeinitDeclarationSyntax structDecl_deinit = null;
        SharedBlockSyntax structDecl_sharedBlock = null;
        var nestedTypes = ImmutableArray.CreateBuilder<MemberSyntax>();

        // ADR-0078 / issue #718: the body block `{ ... }` is optional for any
        // aggregate that uses the new declaration head. The bodyless form is
        //   class Name(params) [: Bases]
        //   struct Name(params) [: Bases]
        //   data class Name(params) [: Bases]
        //   data struct Name(params) [: Bases]
        //   inline struct Name(params)
        // — all of which carry their fields via the primary constructor. A
        // bodyless declaration is detected when the next token after the
        // declaration head is not <c>{</c>.
        var isBodyless = Current.Kind != SyntaxKind.OpenBraceToken;
        if (isBodyless)
        {
            openBrace = new SyntaxToken(syntaxTree, SyntaxKind.OpenBraceToken, Current.Position, "{", null);
            var syntheticCloseBrace = new SyntaxToken(syntaxTree, SyntaxKind.CloseBraceToken, Current.Position, "}", null);
            var bodylessDecl = new StructDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                typeKeyword,
                identifier,
                dataKeyword,
                inlineKeyword,
                openModifier,
                structOrClassKeyword,
                primaryCtorOpenParen,
                primaryCtorParameters,
                primaryCtorCloseParen,
                baseColon,
                baseTypeIdentifier,
                additionalBaseIdentifiers.ToImmutable(),
                openBrace,
                fields.ToImmutable(),
                properties.ToImmutable(),
                events.ToImmutable(),
                methods.ToImmutable(),
                syntheticCloseBrace);
            bodylessDecl.BaseTypeClauses = baseTypeClauses;
            bodylessDecl.BaseConstructorOpenParenthesisToken = baseCtorOpenParen;
            bodylessDecl.BaseConstructorArguments = baseCtorArguments;
            bodylessDecl.BaseConstructorCloseParenthesisToken = baseCtorCloseParen;
            return bodylessDecl;
        }

        openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            // Issue #186 / ADR-0047 §3: each struct/class body member may be
            // preceded by Kotlin-style `@Foo` annotations. For field members
            // the default target is `field`; for method members the existing
            // method-binder path picks them up via MemberSyntax.Annotations.
            var memberAnnotations = ParseAnnotations();

            // Issue #910 / ADR-0110: nested type declarations (class / struct /
            // interface / enum) inside a class or struct body. The declaration
            // head may be preceded by an optional accessibility modifier. Reuse
            // the shared top-level aggregate parser so nested types accept the
            // full declaration grammar (modifiers, type parameters, base
            // clauses, bodies, and recursive nesting).
            {
                var nestedHeadOffset = (Current.Kind == SyntaxKind.PublicKeyword
                    || Current.Kind == SyntaxKind.InternalKeyword
                    || Current.Kind == SyntaxKind.PrivateKeyword
                    || Current.Kind == SyntaxKind.ProtectedKeyword) ? 1 : 0;

                if (TryDetectAggregateDeclarationHead(nestedHeadOffset))
                {
                    SyntaxToken nestedAccessibility = null;
                    if (nestedHeadOffset == 1)
                    {
                        nestedAccessibility = NextToken();
                    }

                    var nestedType = ParseAggregateDeclaration(nestedAccessibility);
                    nestedType.WithAnnotations(memberAnnotations);
                    nestedTypes.Add(nestedType);

                    // A nested discriminated-union enum desugars into a sealed
                    // base plus one class per case (queued on
                    // pendingSyntheticMembers). Drain them as siblings of the
                    // nested type so they remain nested within this body.
                    while (pendingSyntheticMembers.Count > 0)
                    {
                        nestedTypes.Add(pendingSyntheticMembers.Dequeue());
                    }

                    if (Current == startToken)
                    {
                        NextToken();
                    }

                    continue;
                }
            }

            // Phase 3.B.3 sub-step 2b: method declarations inside the body.
            // Use the existing `func Name(args) Ret { body }` parser; the
            // method has no explicit receiver clause — the receiver is the
            // enclosing class. Struct types reject methods (diagnose+skip).
            SyntaxToken memberAccessibility = null;
            if (Current.Kind == SyntaxKind.PublicKeyword ||
                Current.Kind == SyntaxKind.InternalKeyword ||
                Current.Kind == SyntaxKind.PrivateKeyword ||
                Current.Kind == SyntaxKind.ProtectedKeyword)
            {
                // Accessibility modifier may be followed by an optional
                // `open`/`override` and an optional `async` (only meaningful
                // before `func`), then `func`, `prop`, or `event`.
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
                    (Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "event") ||
                    (Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "init" && Peek(ahead + 1).Kind == SyntaxKind.OpenParenthesisToken) ||
                    (Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "convenience"
                        && ((Peek(ahead + 1).Kind == SyntaxKind.IdentifierToken && Peek(ahead + 1).Text == "init" && Peek(ahead + 2).Kind == SyntaxKind.OpenParenthesisToken)
                            || (Peek(ahead + 1).Kind == SyntaxKind.FuncKeyword
                                && Peek(ahead + 2).Kind == SyntaxKind.IdentifierToken && Peek(ahead + 2).Text == "init"
                                && Peek(ahead + 3).Kind == SyntaxKind.OpenParenthesisToken))))
                {
                    memberAccessibility = NextToken();
                }
            }

            // Phase 3.B.3 sub-step 3: parse optional `open` / `override`
            // modifiers (any order) before the method's `func` keyword.
            SyntaxToken memberOpenModifier = null;
            SyntaxToken memberOverrideModifier = null;
            while (Current.Kind == SyntaxKind.OpenKeyword || Current.Kind == SyntaxKind.OverrideKeyword)
            {
                if (Current.Kind == SyntaxKind.OpenKeyword && memberOpenModifier == null)
                {
                    memberOpenModifier = NextToken();
                }
                else if (Current.Kind == SyntaxKind.OverrideKeyword && memberOverrideModifier == null)
                {
                    memberOverrideModifier = NextToken();
                }
                else
                {
                    // Duplicate modifier — diagnose by consuming and reporting.
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.FuncKeyword);
                    NextToken();
                }
            }

            // Issue #502 / ADR-0023: an optional `async` modifier may precede
            // `func` on a class instance method, mirroring the top-level path
            // in ParseMember. The modifier is consumed only when immediately
            // followed by `func`; otherwise it is left for ParseFieldDeclaration
            // (or another fallback) to surface a diagnostic.
            SyntaxToken memberAsyncModifier = null;
            if (Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
            {
                memberAsyncModifier = NextToken();
            }

            // ADR-0122 / issue #1014: optional `unsafe` contextual modifier on
            // an in-body `func` method. Consumed only when immediately followed
            // by `func` (or `async func`).
            SyntaxToken memberUnsafeModifier = null;
            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "unsafe"
                && (Peek(1).Kind == SyntaxKind.FuncKeyword || Peek(1).Kind == SyntaxKind.AsyncKeyword))
            {
                memberUnsafeModifier = NextToken();
                if (memberAsyncModifier == null && Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
                {
                    memberAsyncModifier = NextToken();
                }
            }

            // ADR-0065 §2: optional `convenience` contextual keyword may
            // precede `init` (or `func init`) on a class constructor.
            SyntaxToken memberConvenienceModifier = null;
            if (Current.Kind == SyntaxKind.IdentifierToken
                && Current.Text == "convenience"
                && ((Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(1).Text == "init" && Peek(2).Kind == SyntaxKind.OpenParenthesisToken)
                    || (Peek(1).Kind == SyntaxKind.FuncKeyword
                        && Peek(2).Kind == SyntaxKind.IdentifierToken && Peek(2).Text == "init"
                        && Peek(3).Kind == SyntaxKind.OpenParenthesisToken)))
            {
                memberConvenienceModifier = NextToken();
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "init" && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
            {
                // Issue #306: standalone user-defined constructor
                // `init(params) [: base(args)] { body }`. Only valid for classes.
                if (memberOpenModifier != null || memberOverrideModifier != null)
                {
                    var loc = (memberOpenModifier ?? memberOverrideModifier).Location;
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.OpenParenthesisToken);
                }

                if (memberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                if (structOrClassKeyword.Kind != SyntaxKind.ClassKeyword)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.IdentifierToken);
                }

                var constructor = ParseConstructorDeclaration(memberAccessibility, memberConvenienceModifier);
                constructor.WithAnnotations(memberAnnotations);
                constructors.Add(constructor);
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "deinit"
                     && (Peek(1).Kind == SyntaxKind.OpenBraceToken
                         || Peek(1).Kind == SyntaxKind.OpenParenthesisToken
                         || (Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(2).Kind == SyntaxKind.OpenBraceToken)))
            {
                // ADR-0068 / issue #698: `deinit { … }` destructor declaration.
                // The keyword is a contextual identifier — we recognise it only
                // when it is immediately followed by `{` (well-formed case) or
                // by `(` (a malformed parameter-list shape we still want to
                // diagnose, not silently treat as a field).
                if (memberAccessibility != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberAccessibility.Location, memberAccessibility.Kind, SyntaxKind.IdentifierToken);
                }

                if (memberOpenModifier != null || memberOverrideModifier != null)
                {
                    var loc = (memberOpenModifier ?? memberOverrideModifier).Location;
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.IdentifierToken);
                }

                if (memberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.IdentifierToken);
                }

                if (memberConvenienceModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberConvenienceModifier.Location, memberConvenienceModifier.Kind, SyntaxKind.IdentifierToken);
                }

                var deinitDecl = ParseDeinitDeclaration();
                deinitDecl.WithAnnotations(memberAnnotations);

                if (structOrClassKeyword.Kind != SyntaxKind.ClassKeyword)
                {
                    Diagnostics.ReportDeinitOnNonClass(deinitDecl.DeinitKeyword.Location, identifier.Text ?? string.Empty, structOrClassKeyword.Kind);
                }

                if (structDecl_deinit != null)
                {
                    Diagnostics.ReportDuplicateDeinit(deinitDecl.DeinitKeyword.Location, identifier.Text ?? string.Empty);
                }
                else
                {
                    structDecl_deinit = deinitDecl;
                }
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop")
            {
                // ADR-0051: property declaration inside struct/class body.
                if (memberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                var property = ParsePropertyDeclaration(memberAccessibility, memberOpenModifier, memberOverrideModifier);
                property.WithAnnotations(memberAnnotations);
                properties.Add(property);
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "event")
            {
                if (memberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                var eventDecl = ParseEventDeclaration(memberAccessibility, memberOpenModifier, memberOverrideModifier);
                eventDecl.WithAnnotations(memberAnnotations);
                events.Add(eventDecl);
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "shared" && Peek(1).Kind == SyntaxKind.OpenBraceToken)
            {
                // ADR-0053: shared block grouping static member declarations.
                if (memberAccessibility != null || memberOpenModifier != null || memberOverrideModifier != null)
                {
                    var loc = (memberAccessibility ?? memberOpenModifier ?? memberOverrideModifier).Location;
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.IdentifierToken, SyntaxKind.OpenBraceToken);
                }

                if (memberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                var sharedBlock = ParseSharedBlock();
                if (structDecl_sharedBlock != null)
                {
                    Diagnostics.ReportDuplicateSharedBlock(sharedBlock.SharedKeyword.Location);
                }
                else
                {
                    structDecl_sharedBlock = sharedBlock;
                }
            }
            else if (Current.Kind == SyntaxKind.FuncKeyword)
            {
                // Issue #656 / ADR-0065: `func init(...)` is accepted as an
                // alternative spelling of the constructor declaration. The
                // `func` keyword is consumed and the remainder is parsed as
                // a normal `init(...)` constructor.
                if (Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(1).Text == "init" && Peek(2).Kind == SyntaxKind.OpenParenthesisToken)
                {
                    NextToken(); // consume the `func` keyword

                    if (memberOpenModifier != null || memberOverrideModifier != null)
                    {
                        var loc = (memberOpenModifier ?? memberOverrideModifier).Location;
                        Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.OpenParenthesisToken);
                    }

                    if (memberAsyncModifier != null)
                    {
                        Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                    }

                    if (structOrClassKeyword.Kind != SyntaxKind.ClassKeyword)
                    {
                        Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.IdentifierToken);
                    }

                    var constructor = ParseConstructorDeclaration(memberAccessibility, memberConvenienceModifier);
                    constructor.WithAnnotations(memberAnnotations);
                    constructors.Add(constructor);
                }
                else
                {
                    // Issue #938 / ADR-0079: in-body `func` instance methods are
                    // the canonical declaration site for owned `class` AND owned
                    // `struct`/`data struct` types. Both aggregate kinds accept
                    // the member here; the binder records it as an instance
                    // method on the receiver type (by-ref `this` for value types).
                    FunctionDeclarationSyntax method;
                    if (memberUnsafeModifier != null)
                    {
                        this.unsafeDepth++;
                    }

                    try
                    {
                        method = (FunctionDeclarationSyntax)ParseFunctionDeclaration(memberAccessibility, memberOpenModifier, memberOverrideModifier, memberAsyncModifier);
                    }
                    finally
                    {
                        if (memberUnsafeModifier != null)
                        {
                            this.unsafeDepth--;
                        }
                    }

                    method.WithAnnotations(memberAnnotations);
                    if (memberUnsafeModifier != null)
                    {
                        method.UnsafeModifier = memberUnsafeModifier;
                    }

                    methods.Add(method);
                }
            }
            else
            {
                if (memberOpenModifier != null || memberOverrideModifier != null)
                {
                    var loc = (memberOpenModifier ?? memberOverrideModifier).Location;
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.FuncKeyword);
                }

                if (memberAsyncModifier != null)
                {
                    // `async` not followed by `func` — surface as an unexpected token.
                    Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                fields.Add(ParseFieldDeclaration().WithAnnotations(memberAnnotations));
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        var structDecl = new StructDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            dataKeyword,
            inlineKeyword,
            openModifier,
            structOrClassKeyword,
            primaryCtorOpenParen,
            primaryCtorParameters,
            primaryCtorCloseParen,
            baseColon,
            baseTypeIdentifier,
            additionalBaseIdentifiers.ToImmutable(),
            openBrace,
            fields.ToImmutable(),
            properties.ToImmutable(),
            events.ToImmutable(),
            methods.ToImmutable(),
            closeBrace);
        structDecl.BaseTypeClauses = baseTypeClauses;
        structDecl.SharedBlock = structDecl_sharedBlock;
        structDecl.BaseConstructorOpenParenthesisToken = baseCtorOpenParen;
        structDecl.BaseConstructorArguments = baseCtorArguments;
        structDecl.BaseConstructorCloseParenthesisToken = baseCtorCloseParen;
        structDecl.Constructors = constructors.ToImmutable();
        structDecl.Deinitializer = structDecl_deinit;
        structDecl.NestedTypes = nestedTypes.ToImmutable();
        return structDecl;
    }

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
            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "shared" && Peek(1).Kind == SyntaxKind.OpenBraceToken)
            {
                ParseInterfaceSharedBlock(methods, properties, staticFields, ref seenSharedBlock, identifier.Text);
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop")
            {
                properties.Add(ParsePropertyDeclaration(accessibilityModifier: null, openModifier: null, overrideModifier: null));
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "event")
            {
                events.Add(ParseEventDeclaration(accessibilityModifier: null, openModifier: null, overrideModifier: null));
            }
            else if (IsInterfaceMethodSignatureStart())
            {
                methods.Add(ParseInterfaceMethodSignature());
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
}
