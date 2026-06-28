// <copyright file="Parser.Utilities.cs" company="GSharp">
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
    /// Creates a compilation unit by parsing the members as read in the source text.
    /// </summary>
    /// <returns>A compilation unit.</returns>
    public CompilationUnitSyntax ParseCompilationUnit()
    {
        var package = ParsePackage();
        var imports = ParseImports();
        var members = ParseMembers();
        var endOfFileToken = MatchToken(SyntaxKind.EndOfFileToken);
        var junction = ImmutableArray.CreateBuilder<MemberSyntax>();
        if (package != null)
        {
            junction.Add(package);
        }

        if (imports.Any())
        {
            junction.AddRange(imports);
        }

        junction.AddRange(members);
        return new CompilationUnitSyntax(syntaxTree, junction.ToImmutable(), endOfFileToken);
    }

    /// <summary>
    /// Parses zero or more Kotlin-style annotations (ADR-0047) at the current
    /// position. Stops at the first token that is not <c>@</c>. The returned
    /// list is empty when no annotation lead-in is present.
    /// </summary>
    private ImmutableArray<AnnotationSyntax> ParseAnnotations()
    {
        if (Current.Kind != SyntaxKind.AtToken)
        {
            return ImmutableArray<AnnotationSyntax>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<AnnotationSyntax>();
        while (Current.Kind == SyntaxKind.AtToken)
        {
            builder.Add(ParseAnnotation());
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Parses a single annotation: <c>@</c> [target-kind <c>:</c>] dotted-name
    /// [<c>(</c> arguments <c>)</c>]. Pre: <c>Current.Kind == AtToken</c>.
    /// </summary>
    private AnnotationSyntax ParseAnnotation()
    {
        var atToken = MatchToken(SyntaxKind.AtToken);

        // Optional use-site target: `kind:` where kind is one of the canonical
        // contextual identifiers in ADR-0047 §2. The colon is what makes the
        // token mean "target" — without the colon the token is the first
        // segment of the annotation name. We accept any token kind whose text
        // matches a canonical kind, so reserved keywords like `type` and
        // `return` work even though the lexer never demotes them to
        // identifiers — they are contextual only here.
        AnnotationTargetSyntax target = null;
        if (Peek(1).Kind == SyntaxKind.ColonToken &&
            (Current.Kind == SyntaxKind.IdentifierToken ||
             IsValidAnnotationTargetKind(Current.Text)))
        {
            var kindToken = NextToken();
            var colonToken = NextToken();

            // Normalize the kind to an IdentifierToken so downstream consumers
            // can rely on a uniform shape regardless of whether the source
            // spelled `type:` (keyword) or `field:` (plain identifier).
            var kindIdentifier = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, kindToken.Position, kindToken.Text, null);
            target = new AnnotationTargetSyntax(syntaxTree, kindIdentifier, colonToken);

            if (!IsValidAnnotationTargetKind(kindToken.Text))
            {
                Diagnostics.ReportAnnotationTargetInvalid(kindToken.Location, kindToken.Text);
            }
        }

        // Dotted attribute name. At least one segment must be present.
        var nameSegments = ImmutableArray.CreateBuilder<SyntaxToken>();
        var dotTokens = ImmutableArray.CreateBuilder<SyntaxToken>();

        if (Current.Kind != SyntaxKind.IdentifierToken)
        {
            Diagnostics.ReportAnnotationExpected(atToken.Location);

            // Synthesize a single bad identifier so downstream consumers
            // still see a structurally valid annotation node.
            var bad = MatchToken(SyntaxKind.IdentifierToken);
            nameSegments.Add(bad);
        }
        else
        {
            nameSegments.Add(NextToken());
            while (Current.Kind == SyntaxKind.DotToken && Peek(1).Kind == SyntaxKind.IdentifierToken)
            {
                dotTokens.Add(NextToken());
                nameSegments.Add(NextToken());
            }
        }

        // Optional argument list. The opening `(` must appear with no
        // intervening tokens (we use it to disambiguate "annotation with no
        // args" from "annotation followed by something that opens a `(`").
        SyntaxToken openParen = null;
        SeparatedSyntaxList<ExpressionSyntax> arguments = new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty);
        SyntaxToken closeParen = null;
        if (Current.Kind == SyntaxKind.OpenParenthesisToken)
        {
            openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
            arguments = ParseArguments();
            closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        }

        return new AnnotationSyntax(
            syntaxTree,
            atToken,
            target,
            nameSegments.ToImmutable(),
            dotTokens.ToImmutable(),
            openParen,
            arguments,
            closeParen);
    }

    private static bool IsValidAnnotationTargetKind(string text)
    {
        // The closed kind set from ADR-0047 §2.
        switch (text)
        {
            case "field":
            case "param":
            case "return":
            case "type":
            case "method":
            case "property":
            case "event":
            case "module":
            case "assembly":
            case "genericparam":
                return true;
            default:
                return false;
        }
    }

    private StructDeclarationSyntax BuildDiscriminatedUnionDesugaring(
        SyntaxToken accessibilityModifier,
        SyntaxToken sealedModifier,
        SyntaxToken enumKeyword,
        SyntaxToken identifier,
        SyntaxToken openBrace,
        SeparatedSyntaxList<EnumMemberSyntax> members,
        SyntaxToken closeBrace)
    {
        // ADR-0078 / issue #725: synthesize `sealed class EnumName {}` as the
        // base, and queue `class CaseName[(params)] : EnumName { }` per case.
        // The Parser.pendingSyntheticMembers queue is drained after the
        // current ParseMember call returns, so the synthetic classes appear
        // immediately after the base in declaration order.
        var classKeyword = new SyntaxToken(syntaxTree, SyntaxKind.ClassKeyword, enumKeyword.Position, "class", null);
        var effectiveSealed = sealedModifier ?? new SyntaxToken(syntaxTree, SyntaxKind.SealedKeyword, enumKeyword.Position, "sealed", null);

        var baseDecl = new StructDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword: null,
            identifier,
            dataKeyword: null,
            inlineKeyword: null,
            openModifier: null,
            structKeyword: classKeyword,
            primaryConstructorOpenParen: null,
            primaryConstructorParameters: new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty),
            primaryConstructorCloseParen: null,
            baseColonToken: null,
            baseTypeIdentifier: null,
            additionalBaseTypeIdentifiers: ImmutableArray<SyntaxToken>.Empty,
            openBraceToken: openBrace,
            fields: ImmutableArray<FieldDeclarationSyntax>.Empty,
            properties: ImmutableArray<PropertyDeclarationSyntax>.Empty,
            events: ImmutableArray<EventDeclarationSyntax>.Empty,
            methods: ImmutableArray<FunctionDeclarationSyntax>.Empty,
            closeBraceToken: closeBrace);
        baseDecl.SealedKeyword = effectiveSealed;

        for (var i = 0; i < members.Count; i++)
        {
            var member = members[i];
            var caseClassKeyword = new SyntaxToken(syntaxTree, SyntaxKind.ClassKeyword, member.Identifier.Position, "class", null);
            var colon = new SyntaxToken(syntaxTree, SyntaxKind.ColonToken, member.Identifier.Position, ":", null);

            var primaryOpen = member.HasPayload ? member.PayloadOpenParenthesis : null;
            var primaryClose = member.HasPayload ? member.PayloadCloseParenthesis : null;
            var primaryParams = member.HasPayload
                ? member.PayloadParameters
                : new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty);

            var caseDecl = new StructDeclarationSyntax(
                syntaxTree,
                accessibilityModifier: null,
                typeKeyword: null,
                member.Identifier,
                dataKeyword: null,
                inlineKeyword: null,
                openModifier: null,
                structKeyword: caseClassKeyword,
                primaryConstructorOpenParen: primaryOpen,
                primaryConstructorParameters: primaryParams,
                primaryConstructorCloseParen: primaryClose,
                baseColonToken: colon,
                baseTypeIdentifier: identifier,
                additionalBaseTypeIdentifiers: ImmutableArray<SyntaxToken>.Empty,
                openBraceToken: openBrace,
                fields: ImmutableArray<FieldDeclarationSyntax>.Empty,
                properties: ImmutableArray<PropertyDeclarationSyntax>.Empty,
                events: ImmutableArray<EventDeclarationSyntax>.Empty,
                methods: ImmutableArray<FunctionDeclarationSyntax>.Empty,
                closeBraceToken: closeBrace);

            var baseTypeClause = new TypeClauseSyntax(syntaxTree, identifier);
            caseDecl.BaseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(ImmutableArray.Create<SyntaxNode>(baseTypeClause));

            pendingSyntheticMembers.Enqueue(caseDecl);
        }

        return baseDecl;
    }

    /// <summary>
    /// ADR-0078 / issue #718: recover from the removed standalone <c>record</c>
    /// keyword at member position. Emits GS0307 and parses the rest of the
    /// declaration as if the user had written <c>data struct Name ...</c>.
    /// </summary>
    private MemberSyntax ReportAndRecoverLegacyRecordHead(SyntaxToken accessibilityModifier)
    {
        var recordToken = NextToken();
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        Diagnostics.ReportRecordKeywordRemoved(recordToken.Location, identifier.Text);

        // Recover by parsing the body as a `data struct Name ...` so downstream
        // analysis can still proceed against the (renamed) declaration.
        var syntheticData = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, recordToken.Position, "data", null);
        var syntheticStruct = new SyntaxToken(syntaxTree, SyntaxKind.StructKeyword, recordToken.Position, "struct", null);
        return ParseStructDeclarationNew(
            accessibilityModifier,
            dataKeyword: syntheticData,
            inlineKeyword: null,
            openModifier: null,
            sealedModifier: null,
            refModifier: null,
            aggregateKeyword: syntheticStruct,
            identifier: identifier);
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

        if (token.Kind == SyntaxKind.IdentifierToken && token.Text == "init" && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #526: consumes a dotted-qualifier chain (zero or more <c>.IDENT</c> pairs)
    /// in a type-clause position. Lookahead-only: stops when the next token is not a
    /// <c>.</c> followed by an identifier so we never miscount a member-access on a
    /// value-typed identifier as a qualifier.
    /// </summary>
    /// <returns>The collected dot tokens and qualifier identifier tokens, both empty when no chain is present.</returns>
    private (ImmutableArray<SyntaxToken> Dots, ImmutableArray<SyntaxToken> Identifiers) ParseQualifierSegments()
    {
        ImmutableArray<SyntaxToken>.Builder dotBuilder = null;
        ImmutableArray<SyntaxToken>.Builder identifierBuilder = null;

        while (Current.Kind == SyntaxKind.DotToken && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            dotBuilder ??= ImmutableArray.CreateBuilder<SyntaxToken>();
            identifierBuilder ??= ImmutableArray.CreateBuilder<SyntaxToken>();
            dotBuilder.Add(NextToken());
            identifierBuilder.Add(NextToken());
        }

        var dots = dotBuilder == null ? ImmutableArray<SyntaxToken>.Empty : dotBuilder.ToImmutable();
        var identifiers = identifierBuilder == null ? ImmutableArray<SyntaxToken>.Empty : identifierBuilder.ToImmutable();
        return (dots, identifiers);
    }

    private SyntaxToken SynthesiseEqualsToken(SyntaxToken colonEquals)
    {
        return new SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, colonEquals.Position, "=", null);
    }

    private static string[] BuildMultiTargetSnippet(SeparatedSyntaxList<ExpressionSyntax> targets)
    {
        var names = new string[Math.Max(1, targets.Count)];
        for (var i = 0; i < targets.Count; i++)
        {
            if (targets[i] is NameExpressionSyntax name)
            {
                names[i] = name.IdentifierToken.Text;
            }
            else
            {
                names[i] = "x";
            }
        }

        return names;
    }

    private SeparatedSyntaxList<ExpressionSyntax> ParseMultiTargetList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (true)
        {
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            nodesAndSeparators.Add(new NameExpressionSyntax(syntaxTree, identifier));

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                continue;
            }

            break;
        }

        return new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable());
    }

    private SeparatedSyntaxList<ExpressionSyntax> ParseMultiValueList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (true)
        {
            nodesAndSeparators.Add(ParseExpression());

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                continue;
            }

            break;
        }

        return new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable());
    }

    private SyntaxToken TryParseLoopTargetLabel(SyntaxToken keyword)
    {
        // ADR-0070: an optional bare identifier on the same source line names
        // a labeled enclosing loop. Restricting the label to the same line
        // avoids accidentally swallowing the next statement.
        if (Current.Kind != SyntaxKind.IdentifierToken)
        {
            return null;
        }

        var keywordLine = syntaxTree.Text.GetLineIndex(keyword.Span.Start);
        var currentLine = syntaxTree.Text.GetLineIndex(Current.Span.Start);
        if (keywordLine != currentLine)
        {
            return null;
        }

        return NextToken();
    }

    private CatchClauseSyntax ParseCatchClause()
    {
        var catchKeyword = MatchToken(SyntaxKind.CatchKeyword);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeClause = ParseOptionalTypeClause();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var body = ParseBlockStatement();
        return new CatchClauseSyntax(syntaxTree, catchKeyword, openParen, identifier, typeClause, closeParen, body);
    }

    private ExpressionSyntax ParseMapCreationExpression()
    {
        // ADR-0104: map literal `map[K,V]{k1: v1, k2: v2, …}`.
        var typeClause = ParseMapTypeClause();
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var entries = ParseMapEntries();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new MapCreationExpressionSyntax(syntaxTree, typeClause, openBrace, entries, closeBrace);
    }

    private ExpressionSyntax ParseArrayCreationExpression()
    {
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);

        // Parse the optional length. A lone numeric literal immediately followed
        // by `]` is captured as the literal `LengthToken` so the existing
        // constant-count literal form (`[N]T{…}`, with its GS0115 check) and the
        // count-inferred slice form (`[]T{…}`, empty brackets) are unchanged.
        // Any other (runtime) length expression — issue #1272 — is captured as a
        // full `LengthExpression`.
        SyntaxToken lengthToken = null;
        ExpressionSyntax lengthExpression = null;
        if (Current.Kind != SyntaxKind.CloseSquareBracketToken)
        {
            if (Current.Kind == SyntaxKind.NumberToken && Peek(1).Kind == SyntaxKind.CloseSquareBracketToken)
            {
                lengthToken = MatchToken(SyntaxKind.NumberToken);
            }
            else
            {
                lengthExpression = ParseExpression();
            }
        }

        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);

        // Issue #1046: a jagged-array literal whose element is itself a
        // non-identifier type clause (`[][]int32{ … }`, `[]*int32{ … }`, …).
        // Parse the element recursively when the token after `]` does not begin
        // a plain identifier element; otherwise keep the flat identifier form.
        if (Current.Kind != SyntaxKind.IdentifierToken)
        {
            var nestedElementType = ParseTypeClause();
            var (nestedOpenBrace, nestedElements, nestedCloseBrace, nestedHasElements) = ParseOptionalArrayInitializer();

            // Issue #1272: the no-initializer (or empty-initializer) form with a
            // length yields the runtime/zero-initialised allocation `[n][]T`.
            if (!nestedHasElements && (lengthExpression != null || lengthToken != null))
            {
                return new ArrayCreationExpressionSyntax(
                    syntaxTree,
                    openBracket,
                    lengthExpression ?? new LiteralExpressionSyntax(syntaxTree, lengthToken),
                    closeBracket,
                    nestedElementType,
                    nestedOpenBrace,
                    nestedElements,
                    nestedCloseBrace);
            }

            return new ArrayCreationExpressionSyntax(
                syntaxTree,
                openBracket,
                lengthExpression == null ? lengthToken : ToLengthLiteralToken(lengthExpression),
                closeBracket,
                nestedElementType,
                nestedOpenBrace ?? MatchToken(SyntaxKind.OpenBraceToken),
                nestedElements ?? new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty),
                nestedCloseBrace ?? MatchToken(SyntaxKind.CloseBraceToken));
        }

        var elementType = MatchToken(SyntaxKind.IdentifierToken);

        // Issue #1212: an element-nullable array literal `[]T?{ … }` /
        // `[N]T?{ … }`. The `?` binds to the element identifier, so route the
        // element through a nullable-suffixed type clause (the nested-element
        // path) instead of the bare-identifier fast path, yielding a
        // `Slice(Nullable(T))` / `Array(Nullable(T), N)`.
        if (Current.Kind == SyntaxKind.QuestionToken)
        {
            var questionToken = MatchToken(SyntaxKind.QuestionToken);
            var elementClause = new TypeClauseSyntax(syntaxTree, openBracketToken: null, lengthToken: null, closeBracketToken: null, elementType, questionToken);
            var (nElemOpenBrace, nElemElements, nElemCloseBrace, nElemHasElements) = ParseOptionalArrayInitializer();

            if (!nElemHasElements && (lengthExpression != null || lengthToken != null))
            {
                return new ArrayCreationExpressionSyntax(
                    syntaxTree,
                    openBracket,
                    lengthExpression ?? new LiteralExpressionSyntax(syntaxTree, lengthToken),
                    closeBracket,
                    elementClause,
                    nElemOpenBrace,
                    nElemElements,
                    nElemCloseBrace);
            }

            return new ArrayCreationExpressionSyntax(
                syntaxTree,
                openBracket,
                lengthExpression == null ? lengthToken : ToLengthLiteralToken(lengthExpression),
                closeBracket,
                elementClause,
                nElemOpenBrace ?? MatchToken(SyntaxKind.OpenBraceToken),
                nElemElements ?? new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty),
                nElemCloseBrace ?? MatchToken(SyntaxKind.CloseBraceToken));
        }

        var (openBrace, elements, closeBrace, hasElements) = ParseOptionalArrayInitializer();

        // Issue #1272: `[n]T` (no initializer) or `[n]T{}` (empty initializer)
        // with a runtime length is the zero-initialised allocation form. A lone
        // numeric literal length without a non-empty initializer (`[5]T`,
        // `[5]T{}`) is likewise a (constant-length) zero-initialised allocation.
        if (!hasElements && (lengthExpression != null || lengthToken != null))
        {
            return new ArrayCreationExpressionSyntax(
                syntaxTree,
                openBracket,
                lengthExpression ?? new LiteralExpressionSyntax(syntaxTree, lengthToken),
                closeBracket,
                elementType,
                openBrace,
                elements,
                closeBrace);
        }

        return new ArrayCreationExpressionSyntax(
            syntaxTree,
            openBracket,
            lengthExpression == null ? lengthToken : ToLengthLiteralToken(lengthExpression),
            closeBracket,
            elementType,
            openBrace ?? MatchToken(SyntaxKind.OpenBraceToken),
            elements ?? new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty),
            closeBrace ?? MatchToken(SyntaxKind.CloseBraceToken));
    }

    private bool TryFindMatchingCloseBracketFollowedByEquals(out int offset)
    {
        offset = 0;
        var depth = 0;
        for (var i = 1; ; i++)
        {
            var kind = Peek(i).Kind;
            if (kind == SyntaxKind.EndOfFileToken)
            {
                return false;
            }

            if (kind == SyntaxKind.OpenSquareBracketToken)
            {
                depth++;
            }
            else if (kind == SyntaxKind.CloseSquareBracketToken)
            {
                depth--;
                if (depth == 0)
                {
                    if (Peek(i + 1).Kind == SyntaxKind.EqualsToken)
                    {
                        offset = i + 1;
                        return true;
                    }

                    return false;
                }
            }
        }
    }

    private static bool IsLiteralStartToken(SyntaxKind kind)
    {
        return kind == SyntaxKind.NumberToken
            || kind == SyntaxKind.StringToken
            || kind == SyntaxKind.InterpolatedStringToken
            || kind == SyntaxKind.TrueKeyword
            || kind == SyntaxKind.FalseKeyword
            || kind == SyntaxKind.NilKeyword;
    }

    // Issue #522: when the token following a constructor call's `)` is `{`
    // and the brace contents look like an object initializer (`Identifier =`
    // or empty `}`), wrap the call in an ObjectCreationExpressionSyntax. We
    // peek with the same surgical lookahead used by IsStructLiteralFollowingBrace
    // so unrelated trailing braces (e.g. an `if Cond() { body }` statement
    // body) are not mis-eaten.
    private ExpressionSyntax MaybeWrapWithObjectInitializer(ExpressionSyntax target)
    {
        if (Current.Kind != SyntaxKind.OpenBraceToken)
        {
            return target;
        }

        // Body-header contexts (if/for/while/switch condition) suppress the
        // wrap so the following `{` is recognised as the statement body.
        if (suppressTrailingObjectInitializer > 0)
        {
            return target;
        }

        if (!LooksLikeObjectInitializerBrace())
        {
            // Issue #479 / ADR-0117: a collection initializer applied to a
            // constructor call (`List[int32](){…}`, `Dictionary[K, V](cmp){…}`).
            if (LooksLikeCollectionInitializerBrace())
            {
                return ParseCollectionInitializerExpression(target);
            }

            return target;
        }

        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var initializers = ParseObjectInitializerList();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new ObjectCreationExpressionSyntax(syntaxTree, target, openBrace, initializers, closeBrace);
    }

    private SeparatedSyntaxList<PropertyInitializerSyntax> ParseObjectInitializerList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext
               && Current.Kind != SyntaxKind.CloseBraceToken
               && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var propertyId = MatchToken(SyntaxKind.IdentifierToken);
            var equals = MatchToken(SyntaxKind.EqualsToken);

            // Initializer values live inside the braces — a fresh expression
            // context where trailing object initializers are again allowed
            // (so a nested `Inner = U() { X = 1 }` works even when the outer
            // object initializer was parsed inside a body-header context).
            ExpressionSyntax value;
            var savedSuppress = suppressTrailingObjectInitializer;
            suppressTrailingObjectInitializer = 0;
            try
            {
                value = ParseExpression();
            }
            finally
            {
                suppressTrailingObjectInitializer = savedSuppress;
            }

            nodesAndSeparators.Add(new PropertyInitializerSyntax(syntaxTree, propertyId, equals, value));

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<PropertyInitializerSyntax>(nodesAndSeparators.ToImmutable());
    }

    private ExpressionSyntax ParseInterpolatedStringLiteral()
    {
        var token = MatchToken(SyntaxKind.InterpolatedStringToken);
        var fragments = (ImmutableArray<InterpolationFragment>)token.Value;
        var segments = ImmutableArray.CreateBuilder<InterpolatedStringSegment>(fragments.Length);
        foreach (var fragment in fragments)
        {
            if (!fragment.IsExpression)
            {
                segments.Add(InterpolatedStringSegment.FromText(fragment.Text));
                continue;
            }

            // ADR-0055: a hole is `expr [ , alignment ] [ : format ]`. Split
            // the captured hole text into its expression / alignment / format
            // clauses with a delimiter-aware scanner that ignores `,`/`:`
            // nested inside (), [], {}, or string/char literals so that
            // `a.GetType()`, `dict["k"]`, and `cond ? "a" : "b"` (parenthesized)
            // are not mis-split.
            SplitHole(fragment.Text, out var exprText, out var alignmentText, out var formatText);

            // ADR-0055 §C: anchor diagnostics on the hole itself (using the
            // hole's true source offset) rather than the whole string token.
            var holeSpan = new TextSpan(fragment.Position, System.Math.Max(1, fragment.Text.Length));
            var holeLocation = new TextLocation(syntaxTree.Text, holeSpan);
            if (string.IsNullOrWhiteSpace(exprText))
            {
                Diagnostics.ReportEmptyInterpolationHole(holeLocation);
            }

            if (formatText != null && formatText.Length == 0)
            {
                Diagnostics.ReportEmptyInterpolationFormat(holeLocation);
            }

            int? alignment = null;
            if (alignmentText != null)
            {
                if (int.TryParse(alignmentText.Trim(), System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out var a))
                {
                    alignment = a;
                }
                else
                {
                    Diagnostics.ReportInvalidInterpolationAlignment(holeLocation, alignmentText);
                }
            }

            // ADR-0055 §C: parse the captured expression with span remapping so
            // every inner token, node, and diagnostic carries its true absolute
            // position in the outer file. The hole's expression clause begins at
            // fragment.Position; we re-create a source text in which everything
            // before that offset is blanked to spaces (newlines preserved, so
            // line/column also match) and the expression text sits at its real
            // offset. Inner spans are therefore absolute outer-file spans.
            var innerText = SourceText.From(BuildHolePaddedText(syntaxTree.Text, fragment.Position, exprText), syntaxTree.Text.FileName);
            var innerTree = SyntaxTree.Parse(innerText);
            Diagnostics.AddRange(innerTree.Diagnostics);
            var innerExpression = ExtractFirstExpression(innerTree);
            if (innerExpression == null)
            {
                // Fall back to a synthetic missing-name node anchored on the
                // hole (at its true offset) so binders still see a valid
                // (error-producing) expression syntax.
                var synthetic = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, fragment.Position, exprText, null);
                innerExpression = new NameExpressionSyntax(syntaxTree, synthetic);
            }

            segments.Add(InterpolatedStringSegment.FromExpression(innerExpression, alignment, formatText));
        }

        return new InterpolatedStringExpressionSyntax(syntaxTree, token, segments.ToImmutable());
    }

    private SyntaxToken Peek(int offset)
    {
        var index = position + offset;
        if (index >= tokens.Length)
        {
            return tokens[tokens.Length - 1];
        }

        return tokens[index];
    }

    private SyntaxToken NextToken()
    {
        var current = Current;
        position++;
        return current;
    }

    /// <summary>
    /// ADR-0122 / issue #1014: returns whether <see cref="Current"/> begins on a
    /// later source line than the end of <paramref name="node"/>. Used to treat a
    /// leading-<c>*</c> token as a pointer-dereference statement boundary rather
    /// than a multiplication continuation.
    /// </summary>
    /// <param name="node">The expression parsed so far on the current line.</param>
    /// <returns><c>true</c> when the current token is on a new line.</returns>
    private bool IsCurrentOnNewLineAfter(SyntaxNode node)
    {
        if (node == null)
        {
            return false;
        }

        var text = syntaxTree.Text;
        var previousLine = text.GetLineIndex(System.Math.Max(0, node.Span.End - 1));
        var currentLine = text.GetLineIndex(Current.Position);
        return currentLine > previousLine;
    }

    private SyntaxToken MatchToken(SyntaxKind kind)
    {
        if (Current.Kind == kind)
        {
            return NextToken();
        }

        Diagnostics.ReportUnexpectedToken(new TextLocation(syntaxTree.Text, Current.Span), Current.Kind, kind);
        return new SyntaxToken(syntaxTree, kind, Current.Position, null, null);
    }
}
