// <copyright file="Parser.Statements.cs" company="GSharp">
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


    /// <summary>
    /// Gets the documentation comment tokens collected during lexing (ADR-0057 §7).
    /// These are retained in a side-channel so the parser ignores them during
    /// parsing but can provide them for the post-parse attachment pass.
    /// </summary>
    internal ImmutableArray<SyntaxToken> DocumentationTokens { get; }

    /// <summary>
    /// ADR-0078 / issue #718: emit GS0306 (or GS0307 for <c>record</c>) on a
    /// legacy aggregate declaration head (<c>type Name [mods]? &lt;kind&gt; ...</c>)
    /// and recover by consuming the modifier/keyword/body sequence as if the
    /// declaration had been written in the new grammar. The recovered syntax
    /// node feeds the rest of the pipeline so that downstream tests see one
    /// high-quality diagnostic instead of a cascade.
    /// </summary>
    private MemberSyntax ReportAndRecoverLegacyAggregateForm(
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        TypeParameterListSyntax typeParameterList)
    {
        // Collect any legacy modifiers in their original order so the migration
        // suggestion preserves the spelling the user typed.
        var seenSpellings = new List<string>();
        SyntaxToken openModifier = null;
        SyntaxToken sealedModifier = null;
        SyntaxToken dataKeyword = null;
        SyntaxToken inlineKeyword = null;
        SyntaxToken refModifier = null;
        SyntaxToken recordKeyword = null;
        var hadRecord = false;

        while (true)
        {
            if (Current.Kind == SyntaxKind.OpenKeyword)
            {
                openModifier = NextToken();
                seenSpellings.Add("open");
                continue;
            }

            if (Current.Kind == SyntaxKind.SealedKeyword)
            {
                sealedModifier = NextToken();
                seenSpellings.Add("sealed");
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "data")
            {
                dataKeyword = NextToken();
                seenSpellings.Add("data");
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "inline")
            {
                inlineKeyword = NextToken();
                seenSpellings.Add("inline");
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref")
            {
                refModifier = NextToken();
                seenSpellings.Add("ref");
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "record")
            {
                recordKeyword = NextToken();
                hadRecord = true;
                continue;
            }

            break;
        }

        SyntaxToken aggregateKeyword = null;
        string kindText = null;

        if (hadRecord)
        {
            // `record` becomes `data class` in the new spelling (ref-typed
            // equality-bearing aggregate). We synthesise the class keyword so
            // recovery can run the class-body parser.
            kindText = "data class";
            aggregateKeyword = new SyntaxToken(syntaxTree, SyntaxKind.ClassKeyword, recordKeyword.Position, "class", null);
            if (dataKeyword == null)
            {
                dataKeyword = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, recordKeyword.Position, "data", null);
            }

            Diagnostics.ReportRecordKeywordRemoved(typeKeyword.Location, identifier.Text);
        }
        else if (Current.Kind == SyntaxKind.ClassKeyword ||
                 Current.Kind == SyntaxKind.StructKeyword ||
                 Current.Kind == SyntaxKind.EnumKeyword ||
                 Current.Kind == SyntaxKind.InterfaceKeyword)
        {
            aggregateKeyword = NextToken();
            kindText = aggregateKeyword.Text;

            var modifierSpelling = seenSpellings.Count == 0 ? string.Empty : string.Join(' ', seenSpellings) + " ";
            var typeParamSuffix = typeParameterList == null
                ? string.Empty
                : RenderTypeParameterList(typeParameterList);
            var migration = $"{modifierSpelling}{kindText} {identifier.Text}{typeParamSuffix}";
            Diagnostics.ReportOldTypeDeclarationFormRemoved(typeKeyword.Location, migration);
        }
        else
        {
            // No `=` AND no aggregate keyword: probably a malformed alias.
            // Emit a generic unexpected-token diagnostic and stop.
            Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.EqualsToken);
            return new TypeAliasDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                typeKeyword,
                identifier,
                new SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, Current.Position, "=", null),
                new TypeClauseSyntax(syntaxTree, new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, Current.Position, identifier.Text, null)));
        }

        // Recover by feeding the synthesised modifiers + aggregate keyword
        // into the new-grammar aggregate parser so the rest of the file can
        // still be analysed.
        switch (aggregateKeyword.Kind)
        {
            case SyntaxKind.EnumKeyword:
                {
                    if (typeParameterList != null)
                    {
                        Diagnostics.ReportUnexpectedToken(typeParameterList.OpenBracketToken.Location, SyntaxKind.OpenSquareBracketToken, SyntaxKind.EnumKeyword);
                    }

                    return ParseEnumDeclarationNew(accessibilityModifier, sealedModifier, aggregateKeyword, identifier);
                }

            case SyntaxKind.InterfaceKeyword:
                return ParseInterfaceDeclarationNew(accessibilityModifier, sealedModifier, aggregateKeyword, identifier, typeParameterList);

            default:
                {
                    var structDecl = ParseStructDeclarationNew(accessibilityModifier, dataKeyword, inlineKeyword, openModifier, sealedModifier, refModifier, aggregateKeyword, identifier);
                    structDecl.TypeParameterList = typeParameterList;
                    structDecl.RefModifier = refModifier;
                    return structDecl;
                }
        }
    }

    /// <summary>
    /// Issue #296: matches a base-type name that may be fully qualified
    /// (e.g. <c>System.IO.MemoryStream</c>). The dotted segments are folded
    /// into a single <see cref="SyntaxKind.IdentifierToken"/> whose text is the
    /// dotted name, so the binder resolves it via the imported/alias-aware type
    /// resolution path. A bare identifier (e.g. <c>MemoryStream</c>) is returned
    /// unchanged.
    /// </summary>
    private SyntaxToken MatchQualifiedTypeName()
    {
        var first = MatchToken(SyntaxKind.IdentifierToken);
        if (Current.Kind != SyntaxKind.DotToken || Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return first;
        }

        var text = first.Text;
        while (Current.Kind == SyntaxKind.DotToken && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            NextToken();
            var segment = MatchToken(SyntaxKind.IdentifierToken);
            text += "." + segment.Text;
        }

        return new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, first.Position, text, null);
    }

    private SharedBlockSyntax ParseSharedBlock()
    {
        var sharedKeyword = NextToken(); // consume the contextual "shared" identifier
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        var fields = ImmutableArray.CreateBuilder<FieldDeclarationSyntax>();
        var properties = ImmutableArray.CreateBuilder<PropertyDeclarationSyntax>();
        var events = ImmutableArray.CreateBuilder<EventDeclarationSyntax>();
        var methods = ImmutableArray.CreateBuilder<FunctionDeclarationSyntax>();

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

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop")
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
            closeBrace);
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

    private BlockStatementSyntax ParseBlockStatement()
    {
        var statements = ImmutableArray.CreateBuilder<StatementSyntax>();

        var openBraceToken = MatchToken(SyntaxKind.OpenBraceToken);

        while (Current.Kind != SyntaxKind.EndOfFileToken &&
               Current.Kind != SyntaxKind.CloseBraceToken)
        {
            var startToken = Current;

            var statement = ParseStatement();
            statements.Add(statement);

            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBraceToken = MatchToken(SyntaxKind.CloseBraceToken);

        return new BlockStatementSyntax(syntaxTree, openBraceToken, statements.ToImmutable(), closeBraceToken);
    }

    private MemberSyntax ParseGlobalStatement()
    {
        var statement = ParseStatement();
        return new GlobalStatementSyntax(syntaxTree, statement);
    }

    private StatementSyntax ParseStatement()
    {
        // Issue #187 / ADR-0047 §2: a local `var`/`let`/`const` can be
        // preceded by Kotlin-style `@` annotations (default target `field`).
        // Other statement kinds do not accept annotations — for those we
        // still parse the leading `@...` (to drive a normal binder
        // diagnostic against the synthesized declaration) but fall through
        // to the regular dispatch and drop the annotations on the floor
        // after reporting via ReportAnnotationsNotAllowedOnStatement.
        ImmutableArray<AnnotationSyntax> leadingAnnotations = ImmutableArray<AnnotationSyntax>.Empty;
        if (Current.Kind == SyntaxKind.AtToken)
        {
            leadingAnnotations = ParseAnnotations();
            if (Current.Kind != SyntaxKind.ConstKeyword &&
                Current.Kind != SyntaxKind.LetKeyword &&
                Current.Kind != SyntaxKind.VarKeyword)
            {
                if (leadingAnnotations.Length > 0)
                {
                    Diagnostics.ReportAnnotationsNotAllowedOnStatement(leadingAnnotations[0].AtToken.Location);
                }

                leadingAnnotations = ImmutableArray<AnnotationSyntax>.Empty;
            }
        }

        // ADR-0122 / issue #1014: an `unsafe { … }` block introduces an unsafe
        // context for its statements. `unsafe` is a contextual keyword — only
        // an `unsafe` immediately followed by `{` is treated as the block form.
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "unsafe"
            && Peek(1).Kind == SyntaxKind.OpenBraceToken)
        {
            var unsafeKeyword = NextToken();
            this.unsafeDepth++;
            BlockStatementSyntax unsafeBlock;
            try
            {
                unsafeBlock = ParseBlockStatement();
            }
            finally
            {
                this.unsafeDepth--;
            }

            unsafeBlock.UnsafeKeyword = unsafeKeyword;
            return unsafeBlock;
        }

        // ADR-0125 / issue #1026: a `fixed name *T = source { … }` pinning
        // statement. `fixed` is a contextual keyword — only the precise
        // `fixed IDENT *` shape (the binding name followed by a pointer type)
        // commits here, so existing identifiers named `fixed` are unaffected.
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "fixed"
            && Peek(1).Kind == SyntaxKind.IdentifierToken
            && Peek(2).Kind == SyntaxKind.StarToken)
        {
            return ParseFixedStatement();
        }

        switch (Current.Kind)
        {
            case SyntaxKind.OpenBraceToken:
                return ParseBlockStatement();
            case SyntaxKind.ConstKeyword:
            case SyntaxKind.LetKeyword:
            case SyntaxKind.VarKeyword:
                var declaration = ParseVariableDeclaration();
                if (declaration is VariableDeclarationSyntax variableDeclaration &&
                    !leadingAnnotations.IsDefaultOrEmpty)
                {
                    variableDeclaration.WithAnnotations(leadingAnnotations);
                }

                return declaration;
            case SyntaxKind.IfKeyword:
                if (Peek(1).Kind == SyntaxKind.LetKeyword)
                {
                    return ParseIfLetStatement();
                }

                return ParseIfStatement();
            case SyntaxKind.GuardKeyword:
                return ParseGuardLetStatement();
            case SyntaxKind.ForKeyword:
                return ParseForStatement();
            case SyntaxKind.WhileKeyword:
                return ParseWhileStatement();
            case SyntaxKind.DoKeyword:
                return ParseDoWhileStatement();
            case SyntaxKind.BreakKeyword:
                return ParseBreakStatement();
            case SyntaxKind.ContinueKeyword:
                return ParseContinueStatement();
            case SyntaxKind.ReturnKeyword:
                return ParseReturnStatement();
            case SyntaxKind.SwitchKeyword:
                return ParseSwitchStatement();
            case SyntaxKind.FallthroughKeyword:
                return ParseFallthroughStatement();
            case SyntaxKind.TryKeyword:
                return ParseTryStatement();
            case SyntaxKind.ThrowKeyword:
                return ParseThrowStatement();
            case SyntaxKind.UsingKeyword:
                return ParseUsingStatement();
            case SyntaxKind.DeferKeyword:
                return ParseDeferStatement();
            case SyntaxKind.GoKeyword:
                return ParseGoStatement();
            case SyntaxKind.SelectKeyword:
                return ParseSelectStatement();
            case SyntaxKind.ScopeKeyword:
                return ParseScopeStatement();
            case SyntaxKind.AwaitKeyword:
                if (Peek(1).Kind == SyntaxKind.ForKeyword)
                {
                    return ParseAwaitForRangeStatement();
                }

                if (Peek(1).Kind == SyntaxKind.UsingKeyword)
                {
                    return ParseAwaitUsingStatement();
                }

                goto default;
            default:
                // ADR-0040: contextual `yield` keyword — parse as yield statement
                // when `yield` appears at statement start and is not followed by
                // an assignment operator or other identifier-consuming syntax.
                if (Current.Kind == SyntaxKind.SequenceKeyword &&
                    Peek(1).Kind != SyntaxKind.ColonEqualsToken &&
                    Peek(1).Kind != SyntaxKind.PlusPlusToken &&
                    Peek(1).Kind != SyntaxKind.MinusMinusToken &&
                    Peek(1).Kind != SyntaxKind.CommaToken &&
                    Peek(1).Kind != SyntaxKind.DotToken &&
                    Peek(1).Kind != SyntaxKind.OpenParenthesisToken &&
                    Peek(1).Kind != SyntaxKind.EqualsToken)
                {
                    // "sequence" at statement start is not a yield — fall through.
                }

                if (Current.Kind == SyntaxKind.IdentifierToken &&
                    Current.Text == "yield" &&
                    Peek(1).Kind != SyntaxKind.ColonEqualsToken &&
                    Peek(1).Kind != SyntaxKind.PlusPlusToken &&
                    Peek(1).Kind != SyntaxKind.MinusMinusToken &&
                    Peek(1).Kind != SyntaxKind.CommaToken &&
                    Peek(1).Kind != SyntaxKind.DotToken &&
                    Peek(1).Kind != SyntaxKind.EqualsToken &&
                    Peek(1).Kind != SyntaxKind.OpenSquareBracketToken &&
                    (Peek(1).Kind != SyntaxKind.OpenParenthesisToken || LooksLikeYieldTupleLiteral(1)))
                {
                    // Issue #813: `yield (a, b)` is a yield-statement that
                    // yields a value-tuple literal — required for iterators
                    // whose element type is `(T1, T2, …)` (e.g. the
                    // dogfooded `Indexed` / `Pairwise` ports). Without the
                    // tuple-literal lookahead, `yield (` was uniformly
                    // forwarded to expression-statement parsing where it
                    // became the call `yield(args)` and reported GS0130.
                    return ParseYieldStatement();
                }

                if (Current.Kind == SyntaxKind.IdentifierToken &&
                    Peek(1).Kind == SyntaxKind.ColonToken)
                {
                    // ADR-0070: `label: loop-statement`. We accept any inner
                    // statement here and rely on the binder to issue GS0294
                    // when the inner statement is not a loop — this gives a
                    // single high-quality diagnostic rather than a cascade of
                    // confused parser errors.
                    return ParseLabeledLoopStatement();
                }

                if (Current.Kind == SyntaxKind.IdentifierToken &&
                    Peek(1).Kind == SyntaxKind.ColonEqualsToken)
                {
                    // We do this outside of "ParseExpressionStatement" because
                    // short variable declarations aren't expressions but
                    // statements.
                    return ParseSingleShortVariableDeclaration();
                }

                if (Current.Kind == SyntaxKind.IdentifierToken &&
                    (Peek(1).Kind == SyntaxKind.PlusPlusToken || Peek(1).Kind == SyntaxKind.MinusMinusToken))
                {
                    return ParseIncrementDecrementStatement();
                }

                if (LooksLikeMultiAssignment())
                {
                    return ParseMultiAssignmentStatement();
                }

                return ParseExpressionOrChannelSendStatement();
        }
    }

    private StatementSyntax ParseIncrementDecrementStatement()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var op = NextToken();
        var baseOpKind = op.Kind == SyntaxKind.PlusPlusToken ? SyntaxKind.PlusToken : SyntaxKind.MinusToken;

        var leftName = new NameExpressionSyntax(syntaxTree, identifier);
        var baseOpToken = new SyntaxToken(syntaxTree, baseOpKind, op.Position, SyntaxFacts.GetText(baseOpKind), null);
        var oneToken = new SyntaxToken(syntaxTree, SyntaxKind.NumberToken, op.Position, "1", 1);
        var oneLiteral = new LiteralExpressionSyntax(syntaxTree, oneToken, 1);
        var binary = new BinaryExpressionSyntax(syntaxTree, leftName, baseOpToken, oneLiteral);
        var equalsToken = new SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, op.Position, SyntaxFacts.GetText(SyntaxKind.EqualsToken), null);
        var assignment = new AssignmentExpressionSyntax(syntaxTree, identifier, equalsToken, binary);
        return new ExpressionStatementSyntax(syntaxTree, assignment);
    }

    private StatementSyntax ParseMultiAssignmentStatement()
    {
        var targets = ParseMultiTargetList();
        SyntaxToken op;
        if (Current.Kind == SyntaxKind.ColonEqualsToken)
        {
            // ADR-0077 / issue #717: the legacy multi-target short variable-
            // declaration `a, b := e1, e2` is removed. Emit GS0305 and recover
            // by treating the operator as `=`; the binder still routes through
            // BindMultiAssignmentStatement and reports any follow-on errors
            // (e.g. undeclared targets) without spurious cascades.
            var colonEquals = MatchToken(SyntaxKind.ColonEqualsToken);
            var targetSnippet = BuildMultiTargetSnippet(targets);
            Diagnostics.ReportColonEqualsRemoved(
                colonEquals.Location,
                $"var {targetSnippet[0]} = …  // one declaration per identifier");
            op = SynthesiseEqualsToken(colonEquals);
        }
        else
        {
            op = MatchToken(SyntaxKind.EqualsToken);
        }

        var values = ParseMultiValueList();
        return new MultiAssignmentStatementSyntax(syntaxTree, targets, op, values);
    }

    private StatementSyntax ParseIfStatement()
    {
        var keyword = MatchToken(SyntaxKind.IfKeyword);

        StatementSyntax initializer = null;
        SyntaxToken semicolon = null;
        if (HasIfInitClause())
        {
            initializer = ParseSimpleStatement();
            semicolon = MatchToken(SyntaxKind.SemicolonToken);
        }

        var condition = ParseExpressionInBodyHeader();
        var statement = ParseStatement();
        var elseClause = ParseElseClause();
        return new IfStatementSyntax(syntaxTree, keyword, initializer, semicolon, condition, statement, elseClause);
    }

    private bool HasIfInitClause()
    {
        // Mirrors LooksLikeForClause: scan ahead from the position
        // after `if` looking for a depth-zero semicolon before the
        // opening brace of the then-block.
        int depth = 0;
        for (int i = 0; i < 256; i++)
        {
            var k = Peek(i).Kind;
            if (depth == 0)
            {
                if (k == SyntaxKind.SemicolonToken)
                {
                    return true;
                }

                if (k == SyntaxKind.OpenBraceToken ||
                    k == SyntaxKind.EndOfFileToken)
                {
                    return false;
                }
            }

            if (k == SyntaxKind.OpenParenthesisToken)
            {
                depth++;
            }
            else if (k == SyntaxKind.CloseParenthesisToken && depth > 0)
            {
                depth--;
            }
        }

        return false;
    }

    private ElseClauseSyntax ParseElseClause()
    {
        if (Current.Kind != SyntaxKind.ElseKeyword)
        {
            return null;
        }

        var keyword = NextToken();
        var statement = ParseStatement();
        return new ElseClauseSyntax(syntaxTree, keyword, statement);
    }
}
