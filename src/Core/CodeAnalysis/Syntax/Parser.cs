// <copyright file="Parser.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// The GSharp language parser.
/// </summary>
public class Parser
{
    private readonly SyntaxTree syntaxTree;
    private readonly ImmutableArray<SyntaxToken> tokens;

    // ADR-0078 / issue #725: when a single source-level declaration desugars
    // into multiple synthesized top-level members (notably discriminated-union
    // enums, which expand into a sealed base + one class per case), the
    // expander stages the additional siblings here. `ParseMembers` drains the
    // queue after each `ParseMember` call so they appear in declaration order.
    private readonly Queue<MemberSyntax> pendingSyntheticMembers = new Queue<MemberSyntax>();

    private int position;

    // Issue #522: depth counter that suppresses trailing object-initializer
    // wrapping (`Call(args) { Prop = value }`). The default of zero allows
    // wrapping in regular expression contexts (variable declarations, return
    // statements, etc.). Body-header parsers (`if Cond { … }`, `for x := range
    // Coll { … }`, `switch Expr { … }`, etc.) push the counter via
    // <see cref="WithSuppressedObjectInitializer"/> so the following `{` is
    // recognised as the body, not as an initializer.
    //
    // Nested expression contexts (parens, brackets, argument lists) call
    // <see cref="WithAllowedObjectInitializer"/> to save+clear the counter so
    // an inner `T() { … }` still works inside `if Foo(T() { X = 1 }) { … }`.
    private int suppressTrailingObjectInitializer;

    // Separate counter that suppresses `Ident {` struct-literal parsing.
    // Only incremented by ParseIfExpression to prevent the condition from
    // consuming the then-block's opening brace as a struct literal.
    // For-range and other body-header contexts must NOT suppress struct
    // literals — e.g. `for v in Numbers{} { body }` is valid.
    private int suppressStructLiteral;

    // ADR-0122 §4 / issue #1034: tracks the unsafe-context nesting depth while
    // parsing. Inside an unsafe context (`unsafe func`/`unsafe {}`/unsafe
    // type), a single-identifier `p->member` is parsed as pointer member
    // access `(*p).member` rather than a single-identifier arrow lambda
    // `p -> body`; outside unsafe, the lambda interpretation is unchanged. A
    // parenthesised lambda `(x) -> body` remains available in unsafe contexts.
    private int unsafeDepth;

    // Issue #1038: depth counter that suppresses the standalone range operator
    // (`lo..hi`) while parsing the bound of an index expression. Inside `[...]`
    // the `..` token is owned by the index-argument parser
    // (<see cref="ParseIndexArgument"/>), so the general-expression range layer
    // (<see cref="ParseRangeExpression"/>) must stand down there to keep the
    // #1016/#1022 index-range/from-end behaviour byte-for-byte unchanged.
    // Nested grouping contexts (parentheses, argument lists) save+clear the
    // counter so a parenthesised or argument-position range (`a[(1..3)]`,
    // `a[f(1..3)]`) is still recognised as a standalone `System.Range` value.
    private int suppressRangeOperator;

    /// <summary>
    /// Initializes a new instance of the <see cref="Parser"/> class.
    /// </summary>
    /// <param name="syntaxTree">The source syntax tree object.</param>
    public Parser(SyntaxTree syntaxTree)
    {
        var tokens = new List<SyntaxToken>();
        var docTokens = ImmutableArray.CreateBuilder<SyntaxToken>();

        var lexer = new Lexer(syntaxTree);
        SyntaxToken token;
        do
        {
            token = lexer.Lex();

            if (token.Kind == SyntaxKind.DocumentationCommentToken)
            {
                docTokens.Add(token);
            }
            else if (token.Kind != SyntaxKind.WhitespaceToken &&
                token.Kind != SyntaxKind.CommentToken &&
                token.Kind != SyntaxKind.BadToken)
            {
                tokens.Add(token);
            }
        }
        while (token.Kind != SyntaxKind.EndOfFileToken);

        this.syntaxTree = syntaxTree;
        this.tokens = tokens.ToImmutableArray();
        DocumentationTokens = docTokens.ToImmutable();
        Diagnostics.AddRange(lexer.Diagnostics);
    }

    /// <summary>
    /// Gets tiagnostic bag associated to this parser.
    /// </summary>
    public DiagnosticBag Diagnostics { get; } = new DiagnosticBag();

    /// <summary>
    /// Gets the documentation comment tokens collected during lexing (ADR-0057 §7).
    /// These are retained in a side-channel so the parser ignores them during
    /// parsing but can provide them for the post-parse attachment pass.
    /// </summary>
    internal ImmutableArray<SyntaxToken> DocumentationTokens { get; }

    private SyntaxToken Current => Peek(0);

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

    private PackageSyntax ParsePackage()
    {
        if (Current.Kind == SyntaxKind.PackageKeyword)
        {
            var packageKeyword = MatchToken(SyntaxKind.PackageKeyword);
            var identifiers = ImmutableArray.CreateBuilder<SyntaxToken>();
            identifiers.Add(MatchToken(SyntaxKind.IdentifierToken));
            while (Current.Kind == SyntaxKind.DotToken)
            {
                identifiers.Add(MatchToken(SyntaxKind.DotToken));
                identifiers.Add(MatchToken(SyntaxKind.IdentifierToken));
            }

            return new PackageSyntax(syntaxTree, packageKeyword, identifiers.ToImmutableArray());
        }

        return null;
    }

    private ImmutableArray<MemberSyntax> ParseImports()
    {
        var importsBuilder = ImmutableArray.CreateBuilder<MemberSyntax>();
        while (Current.Kind == SyntaxKind.ImportKeyword)
        {
            var importKeyword = MatchToken(SyntaxKind.ImportKeyword);

            // Detect the alias form: `import <ident> = <ident>(.<ident>)*`.
            // Lookahead: if the next two tokens are IDENT '=', consume them as alias + equals.
            SyntaxToken aliasIdentifier = null;
            SyntaxToken equalsToken = null;
            if (Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.EqualsToken)
            {
                aliasIdentifier = MatchToken(SyntaxKind.IdentifierToken);
                equalsToken = MatchToken(SyntaxKind.EqualsToken);
            }

            var identifiers = ImmutableArray.CreateBuilder<SyntaxToken>();
            identifiers.Add(MatchToken(SyntaxKind.IdentifierToken));
            while (Current.Kind == SyntaxKind.DotToken)
            {
                identifiers.Add(MatchToken(SyntaxKind.DotToken));
                identifiers.Add(MatchToken(SyntaxKind.IdentifierToken));
            }

            importsBuilder.Add(new ImportSyntax(syntaxTree, importKeyword, aliasIdentifier, equalsToken, identifiers.ToImmutableArray()));
        }

        return importsBuilder.ToImmutable();
    }

    private ImmutableArray<MemberSyntax> ParseMembers()
    {
        var members = ImmutableArray.CreateBuilder<MemberSyntax>();

        // ADR-0066 deferred decision D5 (GS0286): top-level statements within a
        // single .gs file must form a single contiguous block — they may all
        // sit at the top of the file, all at the bottom (the Go-style idiom
        // most G# samples and tests follow), or be the only members — but
        // they must not be interleaved with type / function declarations.
        //
        // Track two booleans rather than the strict C# "TLS must precede any
        // declaration" rule because G#'s established idiom is decls-first /
        // trailing-TLS (~488 sources across samples/ and test fixtures use
        // this layout). The contiguous-block rule still catches the truly
        // confusing case (TLS, decl, TLS) without forcing a coordinated
        // rewrite of the existing corpus.
        var seenTopLevelStatement = false;
        var seenDeclarationAfterTopLevel = false;

        while (Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            var member = ParseMember();

            if (member is GlobalStatementSyntax globalStatement)
            {
                if (seenDeclarationAfterTopLevel)
                {
                    Diagnostics.ReportTopLevelStatementsMustBeContiguous(globalStatement.Statement.Location);
                }

                seenTopLevelStatement = true;
            }
            else if (seenTopLevelStatement)
            {
                seenDeclarationAfterTopLevel = true;
            }

            members.Add(member);

            // ADR-0078 / issue #725: drain any synthetic members produced by
            // the desugaring (e.g. discriminated-union enums expand into a
            // sealed base + one class per case).
            while (pendingSyntheticMembers.Count > 0)
            {
                members.Add(pendingSyntheticMembers.Dequeue());
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        return members.ToImmutable();
    }

    private MemberSyntax ParseMember()
    {
        // ADR-0047 / issue #141: Kotlin-style annotation lead-ins precede any
        // other modifier on a declaration. We collect them once and then
        // attach the list to whichever member node ParseMember produces.
        var annotations = ParseAnnotations();

        SyntaxToken accessibilityModifier = null;
        if (Current.Kind == SyntaxKind.PublicKeyword ||
            Current.Kind == SyntaxKind.InternalKeyword ||
            Current.Kind == SyntaxKind.PrivateKeyword ||
            Current.Kind == SyntaxKind.ProtectedKeyword)
        {
            accessibilityModifier = NextToken();
        }

        // ADR-0122 / issue #1014: an optional `unsafe` contextual modifier may
        // precede `func`, `class`, or `struct` (with or without an
        // accessibility modifier). It introduces an unsafe context in which
        // unmanaged raw pointers (`*T`) and raw-pointer operations are legal.
        SyntaxToken unsafeModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "unsafe"
            && (Peek(1).Kind == SyntaxKind.FuncKeyword
                || Peek(1).Kind == SyntaxKind.AsyncKeyword
                || Peek(1).Kind == SyntaxKind.ClassKeyword
                || Peek(1).Kind == SyntaxKind.StructKeyword))
        {
            unsafeModifier = NextToken();
        }

        // Phase 5.1 / ADR-0023: an optional `async` modifier may precede
        // `func` (with or without an accessibility modifier).
        SyntaxToken asyncModifier = null;
        if (Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
        {
            asyncModifier = NextToken();
        }

        MemberSyntax member;
        if (Current.Kind == SyntaxKind.FuncKeyword)
        {
            if (unsafeModifier != null)
            {
                this.unsafeDepth++;
            }

            try
            {
                member = ParseFunctionDeclaration(accessibilityModifier, openModifier: null, overrideModifier: null, asyncModifier);
            }
            finally
            {
                if (unsafeModifier != null)
                {
                    this.unsafeDepth--;
                }
            }

            if (unsafeModifier != null && member is FunctionDeclarationSyntax unsafeFunc)
            {
                unsafeFunc.UnsafeModifier = unsafeModifier;
            }
        }
        else if (TryDetectAggregateDeclarationHead())
        {
            // ADR-0078 / issue #718: the canonical declaration head is
            //   [visibility]? [open|sealed]? [data]? [inline]? (class|struct|enum|interface) Name ...
            // The aggregate-kind keyword IS the declaration keyword — no leading
            // `type`. Drop into the new aggregate parser path.
            if (unsafeModifier != null)
            {
                this.unsafeDepth++;
            }

            try
            {
                member = ParseAggregateDeclaration(accessibilityModifier);
            }
            finally
            {
                if (unsafeModifier != null)
                {
                    this.unsafeDepth--;
                }
            }

            if (unsafeModifier != null && member is StructDeclarationSyntax unsafeAggregate)
            {
                unsafeAggregate.UnsafeModifier = unsafeModifier;
            }
        }
        else if (Current.Kind == SyntaxKind.TypeKeyword)
        {
            member = ParseTypeAliasDeclaration(accessibilityModifier);
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "record"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            // ADR-0078 / issue #718: the standalone `record` keyword has been
            // removed. Detect `record Name ...` at member-position, emit
            // GS0307 with a migration suggestion, and recover by parsing the
            // declaration as if the user had written `data struct Name ...`.
            member = ReportAndRecoverLegacyRecordHead(accessibilityModifier);
        }
        else if (accessibilityModifier != null &&
            (Current.Kind == SyntaxKind.VarKeyword ||
             Current.Kind == SyntaxKind.LetKeyword ||
             Current.Kind == SyntaxKind.ConstKeyword))
        {
            var declaration = ParseVariableDeclaration(accessibilityModifier);

            // Issue #187: annotations on a top-level `var`/`let`/`const`
            // belong to the variable declaration itself (default target
            // `field` per ADR-0047 §2), not to the wrapping GlobalStatement.
            // Forward the parsed annotations onto the declaration and clear
            // the local so the trailing `member.WithAnnotations(annotations)`
            // does not double-attach.
            if (declaration is VariableDeclarationSyntax variableDeclaration)
            {
                variableDeclaration.WithAnnotations(annotations);
                annotations = ImmutableArray<AnnotationSyntax>.Empty;
            }

            member = new GlobalStatementSyntax(syntaxTree, declaration);
        }
        else
        {
            if (accessibilityModifier != null)
            {
                Diagnostics.ReportAccessibilityModifierNotAllowedHere(accessibilityModifier.Location, accessibilityModifier.Text);
            }

            if (asyncModifier != null)
            {
                // `async` not followed by `func` — surface as an unexpected token.
                Diagnostics.ReportUnexpectedToken(asyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
            }

            member = ParseGlobalStatement();

            // Issue #187: a top-level `var`/`let`/`const` without an
            // accessibility modifier is parsed through ParseGlobalStatement →
            // ParseStatement, which has no awareness of member-level
            // annotations. Forward them onto the inner variable declaration
            // so the binder picks them up via VariableDeclarationSyntax.
            if (!annotations.IsDefaultOrEmpty &&
                member is GlobalStatementSyntax wrappingGlobal &&
                wrappingGlobal.Statement is VariableDeclarationSyntax forwardingDeclaration)
            {
                forwardingDeclaration.WithAnnotations(annotations);
                annotations = ImmutableArray<AnnotationSyntax>.Empty;
            }
        }

        return member.WithAnnotations(annotations);
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

    /// <summary>
    /// ADR-0078 / issue #718: detects whether the current parser position
    /// begins a Kotlin/Swift-style aggregate declaration head — optionally
    /// preceded by modifiers (open, sealed, data, inline, ref) — by scanning
    /// ahead to see if it terminates in one of <c>class</c>, <c>struct</c>,
    /// <c>enum</c>, or <c>interface</c>. The scan does not consume tokens.
    /// Returning false leaves dispatch to the legacy <c>type</c>-keyword path
    /// (which now only handles type aliases and named delegates).
    /// </summary>
    private bool TryDetectAggregateDeclarationHead()
    {
        return TryDetectAggregateDeclarationHead(0);
    }

    /// <summary>
    /// Issue #910: offset-aware variant of <see cref="TryDetectAggregateDeclarationHead()"/>
    /// used by the class/struct body member loop to recognise a nested type
    /// declaration head that may be preceded by an accessibility modifier
    /// (already peeked at <paramref name="startOffset"/>). The scan does not
    /// consume tokens.
    /// </summary>
    private bool TryDetectAggregateDeclarationHead(int startOffset)
    {
        var offset = startOffset;
        var saw = new HashSet<string>(System.StringComparer.Ordinal);
        while (true)
        {
            var k = Peek(offset);
            if (k.Kind == SyntaxKind.ClassKeyword ||
                k.Kind == SyntaxKind.StructKeyword ||
                k.Kind == SyntaxKind.EnumKeyword ||
                k.Kind == SyntaxKind.InterfaceKeyword)
            {
                return true;
            }

            if (k.Kind == SyntaxKind.OpenKeyword || k.Kind == SyntaxKind.SealedKeyword)
            {
                offset++;
                continue;
            }

            if (k.Kind == SyntaxKind.IdentifierToken && (k.Text == "data" || k.Text == "inline" || k.Text == "ref"))
            {
                // Bail out if the same contextual modifier appears twice — we are
                // not in a declaration head; let the legacy / statement parser
                // surface the right diagnostic.
                if (!saw.Add(k.Text))
                {
                    return false;
                }

                offset++;
                continue;
            }

            return false;
        }
    }

    /// <summary>
    /// ADR-0078 / issue #718: parses an aggregate declaration whose head is
    ///   [open|sealed]? [data]? [inline]? [ref]? (class|struct|enum|interface) Name[TParams]? ...
    /// The accessibility modifier was already consumed in <see cref="ParseMember"/>.
    /// </summary>
    private MemberSyntax ParseAggregateDeclaration(SyntaxToken accessibilityModifier)
    {
        SyntaxToken openModifier = null;
        SyntaxToken sealedModifier = null;
        SyntaxToken dataKeyword = null;
        SyntaxToken inlineKeyword = null;
        SyntaxToken refModifier = null;

        // Collect modifiers in any order. Re-issuing of a modifier is reported
        // as an unexpected token but parsing continues for recovery.
        while (true)
        {
            if (Current.Kind == SyntaxKind.OpenKeyword)
            {
                if (openModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword);
                }

                openModifier = NextToken();
                continue;
            }

            if (Current.Kind == SyntaxKind.SealedKeyword)
            {
                if (sealedModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword);
                }

                sealedModifier = NextToken();
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "data")
            {
                if (dataKeyword != null)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.StructKeyword);
                }

                dataKeyword = NextToken();
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "inline")
            {
                if (inlineKeyword != null)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.StructKeyword);
                }

                inlineKeyword = NextToken();
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref")
            {
                if (refModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.StructKeyword);
                }

                refModifier = NextToken();
                continue;
            }

            break;
        }

        // Combination rules (ADR-0078):
        //   - data + inline → GS0311
        //   - open + sealed → GS0312
        // The remaining kind-specific rules (open struct, sealed enum, inline
        // class, ...) are validated below once the aggregate keyword is known.
        if (dataKeyword != null && inlineKeyword != null)
        {
            Diagnostics.ReportDataAndInlineCannotCombine(inlineKeyword.Location);
        }

        if (openModifier != null && sealedModifier != null)
        {
            Diagnostics.ReportOpenAndSealedCannotCombine(sealedModifier.Location);
        }

        var aggregateKw = Current;
        var aggregateKind = aggregateKw.Kind;
        var aggregateText = aggregateKw.Text;

        if (aggregateKind != SyntaxKind.ClassKeyword &&
            aggregateKind != SyntaxKind.StructKeyword &&
            aggregateKind != SyntaxKind.EnumKeyword &&
            aggregateKind != SyntaxKind.InterfaceKeyword)
        {
            // Should not happen — TryDetectAggregateDeclarationHead already
            // verified the lookahead. Defensive recovery: emit and bail.
            Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword);
            NextToken();
            return new GlobalStatementSyntax(syntaxTree, ParseStatement());
        }

        // Per-kind modifier validation.
        switch (aggregateKind)
        {
            case SyntaxKind.ClassKeyword:
                if (inlineKeyword != null)
                {
                    Diagnostics.ReportInlineOnlyValidOnStruct(inlineKeyword.Location);
                }

                if (refModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(refModifier.Location, SyntaxKind.IdentifierToken, SyntaxKind.StructKeyword);
                }

                break;

            case SyntaxKind.StructKeyword:
                if (openModifier != null)
                {
                    Diagnostics.ReportOpenOnlyValidOnClass(openModifier.Location, aggregateText);
                }

                if (sealedModifier != null)
                {
                    Diagnostics.ReportSealedOnlyValidOnClassOrInterface(sealedModifier.Location, aggregateText);
                }

                break;

            case SyntaxKind.EnumKeyword:
                if (openModifier != null)
                {
                    Diagnostics.ReportOpenOnlyValidOnClass(openModifier.Location, aggregateText);
                }

                if (sealedModifier != null)
                {
                    Diagnostics.ReportSealedOnlyValidOnClassOrInterface(sealedModifier.Location, aggregateText);
                }

                if (dataKeyword != null)
                {
                    Diagnostics.ReportUnexpectedToken(dataKeyword.Location, SyntaxKind.IdentifierToken, SyntaxKind.EnumKeyword);
                }

                if (inlineKeyword != null)
                {
                    Diagnostics.ReportInlineOnlyValidOnStruct(inlineKeyword.Location);
                }

                if (refModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(refModifier.Location, SyntaxKind.IdentifierToken, SyntaxKind.EnumKeyword);
                }

                break;

            case SyntaxKind.InterfaceKeyword:
                if (openModifier != null)
                {
                    Diagnostics.ReportOpenOnlyValidOnClass(openModifier.Location, aggregateText);
                }

                if (dataKeyword != null)
                {
                    Diagnostics.ReportUnexpectedToken(dataKeyword.Location, SyntaxKind.IdentifierToken, SyntaxKind.InterfaceKeyword);
                }

                if (inlineKeyword != null)
                {
                    Diagnostics.ReportInlineOnlyValidOnStruct(inlineKeyword.Location);
                }

                if (refModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(refModifier.Location, SyntaxKind.IdentifierToken, SyntaxKind.InterfaceKeyword);
                }

                break;
        }

        // Consume the aggregate keyword and the identifier, then optional type
        // parameters: `class Name[TParams]?`.
        var aggregateKeyword = NextToken();
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeParameterList = ParseOptionalTypeParameterList();

        if (aggregateKind == SyntaxKind.EnumKeyword)
        {
            // Note: the unified parser deliberately allows `enum` to fall
            // through to the inner enum production even when stray modifiers
            // were diagnosed above — recovery only.
            if (typeParameterList != null)
            {
                Diagnostics.ReportUnexpectedToken(typeParameterList.OpenBracketToken.Location, SyntaxKind.OpenSquareBracketToken, SyntaxKind.EnumKeyword);
            }

            return ParseEnumDeclarationNew(accessibilityModifier, sealedModifier, aggregateKeyword, identifier);
        }

        if (aggregateKind == SyntaxKind.InterfaceKeyword)
        {
            return ParseInterfaceDeclarationNew(accessibilityModifier, sealedModifier, aggregateKeyword, identifier, typeParameterList);
        }

        // class / struct path.
        var structDecl = ParseStructDeclarationNew(accessibilityModifier, dataKeyword, inlineKeyword, openModifier, sealedModifier, refModifier, aggregateKeyword, identifier);
        structDecl.TypeParameterList = typeParameterList;
        structDecl.RefModifier = refModifier;
        return structDecl;
    }

    /// <summary>
    /// ADR-0078: parses the body of a class or struct declaration whose
    /// modifiers, aggregate keyword, and identifier have already been consumed
    /// by <see cref="ParseAggregateDeclaration"/>. Delegates into the shared
    /// body parser by passing the aggregate keyword as preconsumed.
    /// </summary>
    private StructDeclarationSyntax ParseStructDeclarationNew(
        SyntaxToken accessibilityModifier,
        SyntaxToken dataKeyword,
        SyntaxToken inlineKeyword,
        SyntaxToken openModifier,
        SyntaxToken sealedModifier,
        SyntaxToken refModifier,
        SyntaxToken aggregateKeyword,
        SyntaxToken identifier)
    {
        var decl = ParseStructDeclaration(
            accessibilityModifier,
            typeKeyword: null,
            identifier,
            dataKeyword,
            inlineKeyword,
            openModifier,
            preconsumedStructOrClassKeyword: aggregateKeyword);
        decl.SealedKeyword = sealedModifier;
        return decl;
    }

    private MemberSyntax ParseEnumDeclarationNew(
        SyntaxToken accessibilityModifier,
        SyntaxToken sealedModifier,
        SyntaxToken enumKeyword,
        SyntaxToken identifier)
    {
        // The aggregate `enum` keyword is already consumed. Read the body
        // directly, since ParseEnumDeclaration assumes it still has to match
        // the keyword.
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var members = ParseEnumMembers();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);

        if (members.Count == 0)
        {
            Diagnostics.ReportEmptyEnumDeclaration(identifier.Location, identifier.Text);
        }

        // ADR-0078 / issue #725: if ANY enum member carries a payload, the
        // entire enum is a discriminated union. Desugar it at parse time into
        //   sealed class EnumName { }
        //   class Case1(params) : EnumName { ... }   // per case
        // Flat (non-payload) cases turn into an empty class with the same
        // base, so a uniform pattern-match works on every case.
        var hasAnyPayload = false;
        for (var i = 0; i < members.Count; i++)
        {
            if (members[i].HasPayload)
            {
                hasAnyPayload = true;
                break;
            }
        }

        if (hasAnyPayload)
        {
            return BuildDiscriminatedUnionDesugaring(accessibilityModifier, sealedModifier, enumKeyword, identifier, openBrace, members, closeBrace);
        }

        var decl = new EnumDeclarationSyntax(syntaxTree, accessibilityModifier, typeKeyword: null, identifier, enumKeyword, openBrace, members, closeBrace);
        decl.SealedKeyword = sealedModifier;
        return decl;
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

    private InterfaceDeclarationSyntax ParseInterfaceDeclarationNew(
        SyntaxToken accessibilityModifier,
        SyntaxToken sealedModifier,
        SyntaxToken interfaceKeyword,
        SyntaxToken identifier,
        TypeParameterListSyntax typeParameterList)
    {
        // The aggregate `interface` keyword is already consumed. Build the
        // body by hand (mirroring ParseInterfaceDeclaration but without the
        // up-front MatchToken on the keyword).
        //
        // Issue #1006: an interface may declare one or more base interfaces via
        // a `: A, B` clause directly after the identifier / type-parameter list,
        // mirroring `interface B : A` in C#. Reuse the same comma-separated
        // type-clause parsing the class/struct path uses; the binder enforces
        // that every entry resolves to an interface.
        SyntaxToken baseColon = null;
        var baseTypeClauseNodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var baseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(ImmutableArray<SyntaxNode>.Empty);
        if (Current.Kind == SyntaxKind.ColonToken)
        {
            baseColon = MatchToken(SyntaxKind.ColonToken);
            var firstBaseType = ParseTypeClause();
            baseTypeClauseNodesAndSeparators.Add(firstBaseType);

            while (Current.Kind == SyntaxKind.CommaToken)
            {
                var comma = MatchToken(SyntaxKind.CommaToken);
                baseTypeClauseNodesAndSeparators.Add(comma);
                var nextType = ParseTypeClause();
                baseTypeClauseNodesAndSeparators.Add(nextType);
            }

            baseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(baseTypeClauseNodesAndSeparators.ToImmutable());
        }

        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        var properties = ImmutableArray.CreateBuilder<PropertyDeclarationSyntax>();
        var events = ImmutableArray.CreateBuilder<EventDeclarationSyntax>();
        var methods = ImmutableArray.CreateBuilder<FunctionDeclarationSyntax>();
        var staticFields = ImmutableArray.CreateBuilder<FieldDeclarationSyntax>();
        var seenSharedBlock = false;
        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "shared" && Peek(1).Kind == SyntaxKind.OpenBraceToken)
            {
                // Issue #865 revision: static-virtual members live in a
                // `shared { … }` block (ADR-0089), consistent with classes/structs.
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
        var interfaceDecl = new InterfaceDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword: null,
            identifier,
            typeParameterList,
            sealedModifier,
            interfaceKeyword,
            openBrace,
            properties.ToImmutable(),
            events.ToImmutable(),
            methods.ToImmutable(),
            closeBrace);
        interfaceDecl.BaseColonToken = baseColon;
        interfaceDecl.BaseTypeClauses = baseTypeClauses;
        interfaceDecl.StaticFields = staticFields.ToImmutable();
        return interfaceDecl;
    }

    private MemberSyntax ParseTypeAliasDeclaration(SyntaxToken accessibilityModifier)
    {
        var typeKeyword = MatchToken(SyntaxKind.TypeKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);

        // Phase 4.3 / ADR-0020: optional type-parameter list directly after the
        // type name: `type Box[T any] = ...`. Reuses the same helpers as
        // generic function declarations.
        var typeParameterList = ParseOptionalTypeParameterList();

        // ADR-0078 / issue #718: the only valid uses of the `type` keyword are
        //   `type Name [TParams]? = SomeType`          — erased type alias
        //   `type Name [TParams]? = delegate func(...)` — named CLR delegate
        // Anything else here is a legacy aggregate declaration (`class Name
        // { … }`, `data class Name { … }`, `data struct Name { … }`, …)
        // and must be rejected with GS0306 / GS0307 plus a migration snippet.
        if (Current.Kind != SyntaxKind.EqualsToken)
        {
            return ReportAndRecoverLegacyAggregateForm(accessibilityModifier, typeKeyword, identifier, typeParameterList);
        }

        var equalsToken = MatchToken(SyntaxKind.EqualsToken);

        // ADR-0059 / issue #255: `type Name [TParams] = delegate func(...) R`
        // declares a named CLR delegate type. The `delegate` contextual keyword
        // (an IdentifierToken whose text is "delegate") differentiates this
        // case from the erased type-alias form below. We require `func` to
        // immediately follow `delegate`; anything else trips GS0233.
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "delegate")
        {
            return ParseDelegateDeclaration(accessibilityModifier, typeKeyword, identifier, typeParameterList, equalsToken);
        }

        var aliasedIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var aliasedType = new TypeClauseSyntax(syntaxTree, aliasedIdentifier);
        return new TypeAliasDeclarationSyntax(syntaxTree, accessibilityModifier, typeKeyword, identifier, equalsToken, aliasedType);
    }

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

    private static string RenderTypeParameterList(TypeParameterListSyntax list)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append('[');
        var first = true;
        foreach (var p in list.Parameters)
        {
            if (!first)
            {
                sb.Append(", ");
            }

            sb.Append(p.Identifier.Text);
            if (p.Constraint != null)
            {
                sb.Append(' ');
                sb.Append(p.Constraint.Text);
            }

            first = false;
        }

        sb.Append(']');
        return sb.ToString();
    }

    private MemberSyntax ParseDelegateDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        TypeParameterListSyntax typeParameterList,
        SyntaxToken equalsToken)
    {
        // `delegate` is a contextual keyword that stays as an IdentifierToken
        // — mirrors the existing data/record/inline/ref contextual-modifier
        // handling in ParseTypeAliasDeclaration. We DO NOT promote it to a
        // dedicated SyntaxKind because that would force adding it to
        // SyntaxFacts.GetKeywordKind, breaking any future use of `delegate`
        // as a plain identifier.
        var delegateKeyword = NextToken();

        if (Current.Kind != SyntaxKind.FuncKeyword)
        {
            Diagnostics.ReportDelegateDeclarationRequiresFunc(Current.Location);
        }

        var funcKeyword = MatchToken(SyntaxKind.FuncKeyword);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseParameterList();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);

        // Return type clause is optional; absence means `void` per the existing
        // `func` declaration convention.
        TypeClauseSyntax returnType = null;
        if (CanStartTypeClause(Current))
        {
            returnType = ParseTypeClause();
        }

        return new DelegateDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            typeParameterList,
            equalsToken,
            delegateKeyword,
            funcKeyword,
            openParen,
            parameters,
            closeParen,
            returnType);
    }

    /// <summary>
    /// Returns true when <paramref name="token"/> can start a TypeClauseSyntax.
    /// Used by the delegate declaration parser to decide whether the optional
    /// return type clause is present.
    /// </summary>
    private static bool CanStartTypeClause(SyntaxToken token)
    {
        switch (token.Kind)
        {
            case SyntaxKind.IdentifierToken:
            case SyntaxKind.FuncKeyword:
            case SyntaxKind.OpenParenthesisToken:
            case SyntaxKind.OpenSquareBracketToken:
            case SyntaxKind.MapKeyword:
            case SyntaxKind.ChanKeyword:
            case SyntaxKind.SequenceKeyword:
            case SyntaxKind.AsyncKeyword:
            case SyntaxKind.StarToken:
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// Issue #490: returns true when <paramref name="token"/> can plausibly begin an expression
    /// — used by <see cref="ParseReturnStatement"/> to disambiguate the contextual <c>ref</c>
    /// modifier from an identifier expression named <c>ref</c>.
    /// </summary>
    private static bool CanStartExpression(SyntaxToken token)
    {
        switch (token.Kind)
        {
            case SyntaxKind.IdentifierToken:
            case SyntaxKind.NumberToken:
            case SyntaxKind.StringToken:
            case SyntaxKind.OpenParenthesisToken:
            case SyntaxKind.OpenSquareBracketToken:
            case SyntaxKind.AmpersandToken:
            case SyntaxKind.StarToken:
            case SyntaxKind.MinusToken:
            case SyntaxKind.PlusToken:
            case SyntaxKind.BangToken:
            case SyntaxKind.TrueKeyword:
            case SyntaxKind.FalseKeyword:
            case SyntaxKind.NilKeyword:
            case SyntaxKind.FuncKeyword:
                return true;
            default:
                return false;
        }
    }

    private EnumDeclarationSyntax ParseEnumDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier)
    {
        var enumKeyword = MatchToken(SyntaxKind.EnumKeyword);
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var members = ParseEnumMembers();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);

        if (members.Count == 0)
        {
            Diagnostics.ReportEmptyEnumDeclaration(identifier.Location, identifier.Text);
        }

        return new EnumDeclarationSyntax(syntaxTree, accessibilityModifier, typeKeyword, identifier, enumKeyword, openBrace, members, closeBrace);
    }

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

        // ADR-0118: indexer member — `prop this[<params>] T { get; set }`.
        // The property name is replaced by the contextual `this` keyword
        // followed by a bracketed index-parameter list.
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "this"
            && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken)
        {
            return ParseIndexerDeclaration(accessibilityModifier, openModifier, overrideModifier, propKeyword);
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
                closeBrace);
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
            closeBraceToken: null);
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
                closeBrace);
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
            closeBraceToken: null);
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
                else if (Current.Kind == SyntaxKind.SemicolonToken)
                {
                    semicolon = NextToken();
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

        SyntaxToken receiverOpenParen = null;
        ParameterSyntax receiver = null;
        SyntaxToken receiverCloseParen = null;

        // Phase 3.B.6 / ADR-0019: optional Go-style receiver clause
        // `func ( recv RecvType ) Name(...)`. We only consume it when the
        // tokens unambiguously look like a receiver: open paren, identifier,
        // a type clause, close paren, followed by an identifier (the name).
        if (Current.Kind == SyntaxKind.OpenParenthesisToken && LooksLikeReceiverClause())
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
        else
        {
            body = ParseBlockStatement();
        }

        var decl = new FunctionDeclarationSyntax(syntaxTree, accessibilityModifier, openModifier, overrideModifier, asyncModifier, functionKeyword, receiverOpenParen, receiver, receiverCloseParen, identifier, typeParameterList, openParenthesisToken, parameters, closeParenthesisToken, type, body);
        decl.ReturnRefModifier = returnRefModifier;
        decl.SemicolonBodyToken = semicolonBody;
        decl.IsConversionOperator = isConversionOperator;
        decl.ConversionIsExplicit = conversionIsExplicit;
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
        // `[ Ident (Ident|class|struct|new())? ( , ... )* ]`. Crucially the *first*
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
        // ADR-0097 / issue #775: also skip `class`, `struct`, and `new()`
        // constraint tokens that may appear after the type-parameter name.
        var ahead = 2;
        while (true)
        {
            var k = Peek(ahead).Kind;
            if (k == SyntaxKind.IdentifierToken || k == SyntaxKind.ClassKeyword || k == SyntaxKind.StructKeyword)
            {
                // `new` is lexed as an identifier; consume an optional `()` pair
                // when this identifier is the contextual `new` constraint keyword.
                if (k == SyntaxKind.IdentifierToken
                    && Peek(ahead).Text == "new"
                    && Peek(ahead + 1).Kind == SyntaxKind.OpenParenthesisToken
                    && Peek(ahead + 2).Kind == SyntaxKind.CloseParenthesisToken)
                {
                    ahead += 3;
                    continue;
                }

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
                || follow.Kind == SyntaxKind.EqualsToken // ADR-0059: `type X[T any] = delegate func(...)` (rejected by binder as GS0234).
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

        if (Current.Kind == SyntaxKind.IdentifierToken)
        {
            // Reserve the `class`/`struct`/`new` constraints (handled below
            // as their own keyword tokens / `new`-contextual identifier) so
            // that we don't accidentally bind them as the legacy
            // any/comparable/interface-name slot.
            if (!IsAdditionalConstraintStart(Current))
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

        // ADR-0097 / issue #775: consume any of `class`, `struct`, `new()`
        // constraints in any order. The binder validates illegal
        // combinations (e.g. `class struct`).
        SyntaxToken classKw = null;
        SyntaxToken structKw = null;
        SyntaxToken newKw = null;
        SyntaxToken newOpenParen = null;
        SyntaxToken newCloseParen = null;
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
                     && Current.Text == "new"
                     && Peek(1).Kind == SyntaxKind.OpenParenthesisToken
                     && Peek(2).Kind == SyntaxKind.CloseParenthesisToken)
            {
                if (newKw == null)
                {
                    newKw = NextToken();
                    newOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken);
                    newCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken);
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

        return new TypeParameterSyntax(
            syntaxTree,
            variance,
            identifier,
            constraint,
            openBracket,
            constraintTypeArgs,
            closeBracket,
            classKw,
            structKw,
            newKw,
            newOpenParen,
            newCloseParen);
    }

    /// <summary>
    /// ADR-0097 / issue #775: returns <see langword="true"/> when
    /// <paramref name="token"/> begins a flag-style constraint
    /// (<c>class</c>, <c>struct</c>, or <c>new(</c>). These are handled
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

        if (token.Kind == SyntaxKind.IdentifierToken && token.Text == "new" && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            return true;
        }

        return false;
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

    private TypeClauseSyntax ParseTypeClause()
    {
        if (Current.Kind == SyntaxKind.FuncKeyword)
        {
            return ParseFunctionTypeClause();
        }

        if (Current.Kind == SyntaxKind.OpenParenthesisToken)
        {
            // ADR-0075 / issue #715: the canonical function-type clause is
            // `(T1, T2, ...) -> R`. Disambiguated from a tuple type clause by
            // bounded look-ahead — if the matching `)` is immediately followed
            // by `->`, we commit to the arrow function form; otherwise fall
            // back to the long-standing tuple-type parse.
            if (LooksLikeArrowFunctionTypeClauseStart())
            {
                return ParseArrowFunctionTypeClause(asyncModifier: null);
            }

            return ParseTupleTypeClause();
        }

        if (Current.Kind == SyntaxKind.MapKeyword)
        {
            return ParseMapTypeClause();
        }

        if (Current.Kind == SyntaxKind.ChanKeyword)
        {
            return ParseChanTypeClause();
        }

        // ADR-0040: sequence type `sequence[T]` — alias for IEnumerable[T].
        if (Current.Kind == SyntaxKind.SequenceKeyword)
        {
            return ParseSequenceTypeClause();
        }

        // ADR-0042 / ADR-0043: `async` as a type-clause prefix is reserved for
        // `async sequence[T]` (alias for IAsyncEnumerable[T]) and
        // `async func(P) R` (alias for func(P) Task[R]). All other forms are
        // rejected with a diagnostic.
        if (Current.Kind == SyntaxKind.AsyncKeyword)
        {
            return ParseAsyncPrefixedTypeClause();
        }

        // ADR-0095 / issue #761: raw function-pointer type clause
        // `unmanaged[CC] (T1, T2, ...) -> R`. `unmanaged` is a contextual
        // keyword — we only commit to this shape when it appears at the
        // start of a type-clause position followed by `[` or `(`. Plain
        // identifiers named `unmanaged` (e.g. a struct member or local)
        // are unaffected because they never reach this parser entry.
        if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "unmanaged"
            && (Peek(1).Kind == SyntaxKind.OpenSquareBracketToken
                || Peek(1).Kind == SyntaxKind.OpenParenthesisToken))
        {
            return ParseFunctionPointerTypeClause();
        }

        // ADR-0039: pointer type `*T` in type-annotation position.
        if (Current.Kind == SyntaxKind.StarToken)
        {
            // ADR-0122 §9 / issue #1035: a *managed* function pointer is
            // spelled `*func(T1, T2) R` — the `*` pointer prefix followed by
            // the `func(...) R` signature. It is consistent with the `*T`
            // pointer syntax and is callable directly via `calli`. We commit
            // to this shape only when `*` is immediately followed by `func`.
            if (Peek(1).Kind == SyntaxKind.FuncKeyword)
            {
                return ParseManagedFunctionPointerTypeClause();
            }

            var star = NextToken();
            var pointee = ParseTypeClause();
            var ptrQuestion = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
            return TypeClauseSyntax.CreatePointer(syntaxTree, star, pointee, ptrQuestion);
        }

        if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
        {
            var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
            SyntaxToken length = null;
            if (Current.Kind != SyntaxKind.CloseSquareBracketToken)
            {
                length = MatchToken(SyntaxKind.NumberToken);
            }

            var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);

            // Issue #1046: a jagged/nested array element — the element type is
            // itself a non-identifier type clause (`[][]T`, `[]*T`, `[]map[K,V]`,
            // `[]chan T`, `[]func(...) R`, `[](T1, T2)`, …). When the token after
            // `]` does not begin a plain (possibly dotted/generic) identifier
            // element, parse the element recursively and store it as a nested
            // type clause via `TypeClauseSyntax.CreateArray`. The common
            // `[]Identifier`/`[]Foo.Bar`/`[]List[int32]` forms keep the existing
            // flat representation so nothing regresses.
            if (Current.Kind != SyntaxKind.IdentifierToken)
            {
                var nestedElement = ParseTypeClause();
                var nestedQuestion = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
                return TypeClauseSyntax.CreateArray(
                    syntaxTree,
                    openBracket,
                    length,
                    closeBracket,
                    nestedElement,
                    nestedQuestion);
            }

            var elementIdentifier = MatchToken(SyntaxKind.IdentifierToken);

            // Issue #526: an array/slice of a nested CLR type — `[]Outer.Inner`.
            var (arrayDots, arrayQualifiers) = ParseQualifierSegments();

            // Phase 4.3c: an array/slice of a constructed generic type —
            // `[]List[int32]`. The optional type-argument list attaches to the
            // (last) element identifier, mirroring the non-array path below.
            SyntaxToken arrayTypeArgOpen = null;
            SeparatedSyntaxList<TypeClauseSyntax> arrayTypeArgs = default;
            SyntaxToken arrayTypeArgClose = null;
            if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
            {
                arrayTypeArgOpen = MatchToken(SyntaxKind.OpenSquareBracketToken);
                var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
                while (Current.Kind != SyntaxKind.CloseSquareBracketToken &&
                       Current.Kind != SyntaxKind.EndOfFileToken)
                {
                    nodesAndSeparators.Add(ParseTypeClause());
                    if (Current.Kind == SyntaxKind.CommaToken)
                    {
                        nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                    }
                    else
                    {
                        break;
                    }
                }

                arrayTypeArgs = new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable());
                arrayTypeArgClose = MatchToken(SyntaxKind.CloseSquareBracketToken);
            }

            var arrayQuestion = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
            return new TypeClauseSyntax(
                syntaxTree,
                openBracket,
                length,
                closeBracket,
                elementIdentifier,
                arrayDots,
                arrayQualifiers,
                arrayTypeArgOpen,
                arrayTypeArgs,
                arrayTypeArgClose,
                arrayQuestion);
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);

        // Issue #526: a dotted-qualifier chain `Outer.Inner` (or `A.B.C`) names a
        // nested CLR type. Consume the `.IDENT` segments greedily — the trailing
        // type-argument list `[T1, ...]` (Phase 4.3c) attaches to the LAST segment,
        // matching how nested generic types are written in source.
        var (qualifierDots, qualifierIdents) = ParseQualifierSegments();

        // Phase 4.3c: optional type-argument list `Foo[T1, T2]` in type position.
        SyntaxToken typeArgOpen = null;
        SeparatedSyntaxList<TypeClauseSyntax> typeArgs = default;
        SyntaxToken typeArgClose = null;
        if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
        {
            typeArgOpen = MatchToken(SyntaxKind.OpenSquareBracketToken);
            var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
            while (Current.Kind != SyntaxKind.CloseSquareBracketToken &&
                   Current.Kind != SyntaxKind.EndOfFileToken)
            {
                nodesAndSeparators.Add(ParseTypeClause());
                if (Current.Kind == SyntaxKind.CommaToken)
                {
                    nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                }
                else
                {
                    break;
                }
            }

            typeArgs = new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable());
            typeArgClose = MatchToken(SyntaxKind.CloseSquareBracketToken);
        }

        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return new TypeClauseSyntax(
            syntaxTree,
            openBracketToken: null,
            lengthToken: null,
            closeBracketToken: null,
            identifier,
            qualifierDots,
            qualifierIdents,
            typeArgOpen,
            typeArgs,
            typeArgClose,
            question);
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

    private TypeClauseSyntax ParseTupleTypeClause()
    {
        // Phase 4.5: tuple type clause `(T1, T2, ...)` with optional trailing `?`.
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNext = true;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseParenthesisToken &&
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

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return new TypeClauseSyntax(
            syntaxTree,
            openParen,
            new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
            closeParen,
            question);
    }

    private TypeClauseSyntax ParseMapTypeClause()
    {
        // ADR-0104 / issue #805: canonical map type clause `map[K,V]` with optional trailing `?`.
        // For one release we still *recognize* the legacy Go-flavored shape
        // `map[K]V` so we can emit GS0366 with a span-accurate "did you mean
        // 'map[K,V]'?" diagnostic, then bind it as if the new spelling had
        // been written. No deprecation window — this is the breaking change
        // for v0.2 called out in ADR-0104.
        var mapKeyword = MatchToken(SyntaxKind.MapKeyword);
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var keyType = ParseTypeClause();

        SyntaxToken commaToken = null;
        SyntaxToken closeBracket;
        TypeClauseSyntax valueType;
        if (Current.Kind == SyntaxKind.CommaToken)
        {
            commaToken = MatchToken(SyntaxKind.CommaToken);
            valueType = ParseTypeClause();
            closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        }
        else
        {
            // Legacy `map[K]V` shape: consume the close-bracket, then the
            // value type that follows, then point GS0366 at the whole span.
            closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
            valueType = ParseTypeClause();

            var legacySpan = TextSpan.FromBounds(mapKeyword.Span.Start, valueType.Span.End);
            var legacyLocation = new TextLocation(syntaxTree.Text, legacySpan);
            var keyText = syntaxTree.Text.ToString(keyType.Span);
            var valueText = syntaxTree.Text.ToString(valueType.Span);
            Diagnostics.ReportLegacyMapTypeClauseSyntax(legacyLocation, keyText, valueText);
        }

        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return new TypeClauseSyntax(
            syntaxTree,
            mapKeyword,
            openBracket,
            keyType,
            commaToken,
            valueType,
            closeBracket,
            question);
    }

    private TypeClauseSyntax ParseChanTypeClause()
    {
        // Phase 5.4 / ADR-0022: channel type clause `chan T` with optional trailing `?`.
        var chanKeyword = MatchToken(SyntaxKind.ChanKeyword);
        var elementType = ParseTypeClause();
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return new TypeClauseSyntax(syntaxTree, chanKeyword, elementType, question);
    }

    private TypeClauseSyntax ParseSequenceTypeClause()
    {
        // ADR-0040: sequence type clause `sequence[T]` with optional trailing `?`.
        var sequenceKeyword = MatchToken(SyntaxKind.SequenceKeyword);
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var elementType = ParseTypeClause();
        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return TypeClauseSyntax.CreateSequence(syntaxTree, sequenceKeyword, openBracket, elementType, closeBracket, question);
    }

    private TypeClauseSyntax ParseAsyncPrefixedTypeClause()
    {
        // ADR-0042: `async sequence[T]` — alias for IAsyncEnumerable[T].
        // ADR-0043: `async func(P) R` — alias for func(P) Task[R] (deprecated, ADR-0075).
        // ADR-0075: `async (P) -> R` — canonical arrow-form async function type clause.
        // No other form is legal as an `async`-prefixed type clause.
        var asyncModifier = MatchToken(SyntaxKind.AsyncKeyword);

        if (Current.Kind == SyntaxKind.FuncKeyword)
        {
            return ParseAsyncFunctionTypeClause(asyncModifier);
        }

        // ADR-0075: arrow-form async function type clause `async (T) -> R`.
        if (Current.Kind == SyntaxKind.OpenParenthesisToken && LooksLikeArrowFunctionTypeClauseStart())
        {
            return ParseArrowFunctionTypeClause(asyncModifier);
        }

        if (Current.Kind != SyntaxKind.SequenceKeyword)
        {
            Diagnostics.ReportAsyncModifierInTypeClauseRequiresSequenceOrFunc(asyncModifier.Location, Current.Kind);
        }

        var sequenceKeyword = MatchToken(SyntaxKind.SequenceKeyword);
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var elementType = ParseTypeClause();
        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return TypeClauseSyntax.CreateAsyncSequence(syntaxTree, asyncModifier, sequenceKeyword, openBracket, elementType, closeBracket, question);
    }

    private TypeClauseSyntax ParseAsyncFunctionTypeClause(SyntaxToken asyncModifier)
    {
        // ADR-0043: `async func(P) R` is a synonym for `func(P) Task[R]`
        // (with carve-outs for void → Task and IAsyncEnumerable[T] → unchanged).
        // ADR-0075 / issue #715: the `func(...)` spelling is deprecated in
        // type position — emit GS0303 so the migrate-to-arrow-form signal
        // surfaces uniformly.
        var funcKeyword = MatchToken(SyntaxKind.FuncKeyword);
        Diagnostics.ReportFunctionTypeClauseFuncKeywordDeprecated(funcKeyword.Location);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var ellipsisTokens = ImmutableArray.CreateBuilder<SyntaxToken>();

        while (Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            // ADR-0102 follow-up / issue #818: per-parameter `...` marker
            // for a variadic parameter in an anonymous function-type clause.
            SyntaxToken ellipsis = null;
            if (Current.Kind == SyntaxKind.EllipsisToken)
            {
                ellipsis = MatchToken(SyntaxKind.EllipsisToken);
            }

            nodesAndSeparators.Add(ParseTypeClause());
            ellipsisTokens.Add(ellipsis);
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var returnTypeClause = ParseOptionalTypeClause();
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return TypeClauseSyntax.CreateAsyncFunction(
            syntaxTree,
            asyncModifier,
            funcKeyword,
            openParen,
            new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
            ellipsisTokens.ToImmutable(),
            closeParen,
            returnTypeClause,
            question);
    }

    private TypeClauseSyntax ParseFunctionTypeClause()
    {
        // Phase 4.7: function type clause `func(T1, T2, ...) R?`. The return
        // type is optional; if absent the function returns void.
        // ADR-0075 / issue #715: the `func(...) R` spelling is the legacy form
        // and is being replaced by the arrow form `(T1, T2, ...) -> R`. The
        // legacy form is still accepted during this release with a deprecation
        // warning (GS0303).
        var funcKeyword = MatchToken(SyntaxKind.FuncKeyword);
        Diagnostics.ReportFunctionTypeClauseFuncKeywordDeprecated(funcKeyword.Location);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var ellipsisTokens = ImmutableArray.CreateBuilder<SyntaxToken>();

        while (Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            // ADR-0102 follow-up / issue #818: per-parameter `...` marker.
            SyntaxToken ellipsis = null;
            if (Current.Kind == SyntaxKind.EllipsisToken)
            {
                ellipsis = MatchToken(SyntaxKind.EllipsisToken);
            }

            nodesAndSeparators.Add(ParseTypeClause());
            ellipsisTokens.Add(ellipsis);
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var returnTypeClause = ParseOptionalTypeClause();
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return TypeClauseSyntax.CreateLegacyFunction(
            syntaxTree,
            funcKeyword,
            openParen,
            new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
            ellipsisTokens.ToImmutable(),
            closeParen,
            returnTypeClause,
            question);
    }

    private TypeClauseSyntax ParseArrowFunctionTypeClause(SyntaxToken asyncModifier)
    {
        // ADR-0075 / issue #715: canonical arrow-form function type clause
        // `[async] (T1, T2, ...) -> R [?]`. The parameter list is always
        // parenthesised (empty is OK); the arrow is mandatory; the return
        // type clause is required (use `void` or the legacy `func(...)`
        // shape for void-returning function types).
        // ADR-0102 follow-up / issue #818: any single parameter slot may
        // be prefixed with `...` to mark it as variadic. Structural rules
        // (at most one, must be last, must be `[]T`) are enforced by the
        // binder so this site only records the per-slot marker tokens.
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var ellipsisTokens = ImmutableArray.CreateBuilder<SyntaxToken>();

        while (Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            SyntaxToken ellipsis = null;
            if (Current.Kind == SyntaxKind.EllipsisToken)
            {
                ellipsis = MatchToken(SyntaxKind.EllipsisToken);
            }

            nodesAndSeparators.Add(ParseTypeClause());
            ellipsisTokens.Add(ellipsis);
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var arrow = MatchToken(SyntaxKind.RightArrowToken);
        var returnTypeClause = ParseTypeClause();
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        if (asyncModifier != null)
        {
            return TypeClauseSyntax.CreateAsyncArrowFunction(
                syntaxTree,
                asyncModifier,
                openParen,
                new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
                ellipsisTokens.ToImmutable(),
                closeParen,
                arrow,
                returnTypeClause,
                question);
        }

        return TypeClauseSyntax.CreateArrowFunction(
            syntaxTree,
            openParen,
            new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
            ellipsisTokens.ToImmutable(),
            closeParen,
            arrow,
            returnTypeClause,
            question);
    }

    /// <summary>
    /// ADR-0095 / issue #761: parses the raw function-pointer type clause
    /// <c>unmanaged[CC] (T1, T2, ...) -&gt; R</c>. The leading
    /// <c>unmanaged</c> identifier is the contextual keyword; the
    /// <c>[CC]</c> slot is required (omitting it produces GS0356 and the
    /// parser fabricates a missing identifier so recovery continues on
    /// the inner signature). The parameter and return type-clause grammar
    /// is the same as the arrow-form function type clause (ADR-0075).
    /// </summary>
    private TypeClauseSyntax ParseFunctionPointerTypeClause()
    {
        // Consume the `unmanaged` identifier as the keyword token. We
        // leave its Kind as IdentifierToken (contextual keyword); the
        // parser's role is to record the role through the dedicated
        // UnmanagedKeyword property on TypeClauseSyntax.
        var unmanagedKeyword = MatchToken(SyntaxKind.IdentifierToken);

        SyntaxToken openBracket = null;
        SyntaxToken callingConvention = null;
        SyntaxToken closeBracket = null;
        if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
        {
            openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
            callingConvention = MatchToken(SyntaxKind.IdentifierToken);
            closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        }
        else
        {
            // ADR-0095 §5 — GS0356: the calling-convention slot is
            // required. Report at the `unmanaged` keyword location so the
            // user sees both the keyword and the proposed remediation.
            Diagnostics.ReportFunctionPointerMissingCallingConvention(unmanagedKeyword.Location);
        }

        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (Current.Kind != SyntaxKind.CloseParenthesisToken
            && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseTypeClause());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var arrow = MatchToken(SyntaxKind.RightArrowToken);
        var returnTypeClause = ParseTypeClause();

        return TypeClauseSyntax.CreateFunctionPointer(
            syntaxTree,
            unmanagedKeyword,
            openBracket,
            callingConvention,
            closeBracket,
            openParen,
            new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
            closeParen,
            arrow,
            returnTypeClause);
    }

    /// <summary>
    /// ADR-0122 §9 / issue #1035: parses the *managed* function-pointer type
    /// clause <c>*func(T1, T2, ...) R</c>. The leading <c>*</c> mirrors the
    /// <c>*T</c> pointer prefix and the <c>func(...) R</c> body mirrors the
    /// named function-type spelling; the return type is optional (void when
    /// absent). The result is a managed function pointer callable directly via
    /// <c>calli</c> with the default managed calling convention.
    /// </summary>
    private TypeClauseSyntax ParseManagedFunctionPointerTypeClause()
    {
        var starToken = MatchToken(SyntaxKind.StarToken);
        var funcKeyword = MatchToken(SyntaxKind.FuncKeyword);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (Current.Kind != SyntaxKind.CloseParenthesisToken
            && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseTypeClause());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var returnTypeClause = ParseOptionalTypeClause();

        return TypeClauseSyntax.CreateManagedFunctionPointer(
            syntaxTree,
            starToken,
            funcKeyword,
            openParen,
            new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
            closeParen,
            returnTypeClause);
    }

    // ADR-0075 / issue #715: bounded look-ahead used in type-clause slots to
    // distinguish the arrow-form function type `(T1, T2) -> R` from a tuple
    // type `(T1, T2)`. The scan never consumes tokens — it only inspects the
    // shape of the parenthesised list to decide which grammar to apply.
    private bool LooksLikeArrowFunctionTypeClauseStart()
    {
        if (Current.Kind != SyntaxKind.OpenParenthesisToken)
        {
            return false;
        }

        var parenDepth = 1;
        var bracketDepth = 0;
        var braceDepth = 0;
        var offset = 1;
        const int maxScan = 4096;
        while (offset < maxScan)
        {
            var k = Peek(offset).Kind;
            if (k == SyntaxKind.EndOfFileToken)
            {
                return false;
            }

            if (k == SyntaxKind.OpenParenthesisToken)
            {
                parenDepth++;
            }
            else if (k == SyntaxKind.CloseParenthesisToken)
            {
                if (bracketDepth == 0 && braceDepth == 0)
                {
                    parenDepth--;
                    if (parenDepth == 0)
                    {
                        break;
                    }
                }
                else
                {
                    parenDepth--;
                }
            }
            else if (k == SyntaxKind.OpenSquareBracketToken)
            {
                bracketDepth++;
            }
            else if (k == SyntaxKind.CloseSquareBracketToken)
            {
                if (bracketDepth > 0)
                {
                    bracketDepth--;
                }
            }
            else if (k == SyntaxKind.OpenBraceToken)
            {
                braceDepth++;
            }
            else if (k == SyntaxKind.CloseBraceToken)
            {
                if (braceDepth > 0)
                {
                    braceDepth--;
                }
            }

            offset++;
        }

        if (parenDepth != 0)
        {
            return false;
        }

        // Peek(offset) is the closing `)`. Commit to the arrow-form function
        // type clause iff the next token is `->`.
        return Peek(offset + 1).Kind == SyntaxKind.RightArrowToken;
    }

    private TypeClauseSyntax ParseOptionalTypeClause()
    {
        if (Current.Kind != SyntaxKind.IdentifierToken &&
            Current.Kind != SyntaxKind.OpenSquareBracketToken &&
            Current.Kind != SyntaxKind.OpenParenthesisToken &&
            Current.Kind != SyntaxKind.FuncKeyword &&
            Current.Kind != SyntaxKind.MapKeyword &&
            Current.Kind != SyntaxKind.ChanKeyword &&
            Current.Kind != SyntaxKind.SequenceKeyword &&
            Current.Kind != SyntaxKind.AsyncKeyword &&
            Current.Kind != SyntaxKind.StarToken)
        {
            return null;
        }

        // ADR-0067 / issue #694: when an identifier in return-type position is a
        // contextual member-position keyword (`event`, `prop`, `init`,
        // `convenience`, `shared`), it actually starts the NEXT member of the
        // enclosing type body — not a return type for the current `func(...)`
        // clause. Bail out so the enclosing struct/class parser can dispatch on
        // the contextual keyword.
        if (Current.Kind == SyntaxKind.IdentifierToken && IsContextualMemberKeyword(Current.Text))
        {
            return null;
        }

        return ParseTypeClause();
    }

    private static bool IsContextualMemberKeyword(string text)
    {
        return text == "event"
            || text == "prop"
            || text == "init"
            || text == "convenience"
            || text == "shared";
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

    private StatementSyntax ParseSingleShortVariableDeclaration()
    {
        // ADR-0077 / issue #717: the legacy short variable-declaration
        // operator `:=` is removed. Emit GS0305 against the `:=` token and
        // recover by synthesising a `var` declaration so downstream binding
        // produces no cascade.
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var colonEquals = MatchToken(SyntaxKind.ColonEqualsToken);
        Diagnostics.ReportColonEqualsRemoved(
            colonEquals.Location,
            $"let {identifier.Text} = …  or  var {identifier.Text} = …");
        var initializer = ParseExpression();
        var equalsToken = SynthesiseEqualsToken(colonEquals);
        return new VariableDeclarationSyntax(
            syntaxTree: syntaxTree,
            keyword: null,
            identifier: identifier,
            typeClause: null,
            equalsToken: equalsToken,
            initializer: initializer);
    }

    private SyntaxToken SynthesiseEqualsToken(SyntaxToken colonEquals)
    {
        return new SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, colonEquals.Position, "=", null);
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

    /// <summary>
    /// ADR-0126 / issue #1027: desugars a prefix (<c>++x</c> / <c>--x</c>) or
    /// postfix (<c>x++</c> / <c>x--</c>) increment/decrement <em>expression</em>
    /// into existing value-producing assignment syntax, mirroring the
    /// statement-level desugar in <see cref="ParseIncrementDecrementStatement"/>
    /// and the compound-assignment desugar in
    /// <see cref="ParseAssignmentExpression"/>.
    /// <para>
    /// The write reuses the read-modify-write nodes that already yield the
    /// mutated (new) value: a bare variable lowers to
    /// <c>operand = operand ± 1</c>, an array element / indexer lowers to the
    /// single-evaluating <see cref="CompoundIndexAssignmentExpressionSyntax"/>
    /// (<c>operand ±= 1</c>), and a field lowers to a
    /// <see cref="MemberFieldAssignmentExpressionSyntax"/>.
    /// </para>
    /// <para>
    /// A <em>prefix</em> form yields that new value directly. A <em>postfix</em>
    /// form must yield the value <em>before</em> mutation, so it wraps the write
    /// in <c>(write) ∓ 1</c> — exact for the integer operand types G# accepts
    /// for <c>++</c>/<c>--</c> (the literal <c>1</c> is <c>int32</c>; floating
    /// point operands are rejected by the binder, so no rounding gap exists).
    /// </para>
    /// </summary>
    /// <param name="operand">The already-parsed lvalue operand.</param>
    /// <param name="op">The <c>++</c> or <c>--</c> operator token.</param>
    /// <param name="isPrefix"><see langword="true"/> for the prefix form.</param>
    /// <returns>The desugared value-producing expression.</returns>
    private ExpressionSyntax BuildIncrementDecrementExpression(ExpressionSyntax operand, SyntaxToken op, bool isPrefix)
    {
        var isIncrement = op.Kind == SyntaxKind.PlusPlusToken;
        var baseOpKind = isIncrement ? SyntaxKind.PlusToken : SyntaxKind.MinusToken;
        var inverseOpKind = isIncrement ? SyntaxKind.MinusToken : SyntaxKind.PlusToken;
        var compoundOpKind = isIncrement ? SyntaxKind.PlusEqualsToken : SyntaxKind.MinusEqualsToken;
        var pos = op.Position;

        LiteralExpressionSyntax OneLiteral() =>
            new LiteralExpressionSyntax(syntaxTree, new SyntaxToken(syntaxTree, SyntaxKind.NumberToken, pos, "1", 1), 1);

        ExpressionSyntax write;
        if (TryLiftTrailingIndexer(operand, out var indexed))
        {
            // Array element / indexer: route through the single-evaluating
            // compound-index assignment so the receiver chain is computed once.
            var compoundToken = new SyntaxToken(syntaxTree, compoundOpKind, pos, SyntaxFacts.GetText(compoundOpKind), null);
            write = new CompoundIndexAssignmentExpressionSyntax(syntaxTree, indexed, compoundToken, OneLiteral());
        }
        else
        {
            var baseOpToken = new SyntaxToken(syntaxTree, baseOpKind, pos, SyntaxFacts.GetText(baseOpKind), null);
            var newValue = new BinaryExpressionSyntax(syntaxTree, operand, baseOpToken, OneLiteral());
            var equalsToken = new SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, pos, SyntaxFacts.GetText(SyntaxKind.EqualsToken), null);

            if (operand is NameExpressionSyntax name)
            {
                write = new AssignmentExpressionSyntax(syntaxTree, name.IdentifierToken, equalsToken, newValue);
            }
            else if (TryLiftTrailingMemberAccess(operand, out var receiver, out var dotToken, out var fieldIdentifier))
            {
                // Prefer the simple `id.field = value` form when the receiver is
                // a bare name: it binds through the field-assignment path that
                // correctly takes the address of a struct-local receiver in
                // value position (the chained member form copies a value-type
                // receiver by value, which would drop the mutation).
                write = receiver is NameExpressionSyntax simpleReceiver
                    ? new FieldAssignmentExpressionSyntax(syntaxTree, simpleReceiver.IdentifierToken, dotToken, fieldIdentifier, equalsToken, newValue)
                    : new MemberFieldAssignmentExpressionSyntax(syntaxTree, receiver, dotToken, fieldIdentifier, equalsToken, newValue);
            }
            else
            {
                Diagnostics.ReportInvalidIncrementDecrementTarget(operand.Location, op.Text);
                return operand;
            }
        }

        if (isPrefix)
        {
            return write;
        }

        // Postfix yields the value before mutation: (write) ∓ 1.
        var inverseOpToken = new SyntaxToken(syntaxTree, inverseOpKind, pos, SyntaxFacts.GetText(inverseOpKind), null);
        return new BinaryExpressionSyntax(syntaxTree, write, inverseOpToken, OneLiteral());
    }

    private bool LooksLikeMultiAssignment()
    {
        // Pattern: ident, ident (, ident)* (= | :=) ...
        if (Current.Kind != SyntaxKind.IdentifierToken ||
            Peek(1).Kind != SyntaxKind.CommaToken)
        {
            return false;
        }

        int i = 2;
        while (i < 256)
        {
            if (Peek(i).Kind != SyntaxKind.IdentifierToken)
            {
                return false;
            }

            var next = Peek(i + 1).Kind;
            if (next == SyntaxKind.CommaToken)
            {
                i += 2;
                continue;
            }

            return next == SyntaxKind.EqualsToken || next == SyntaxKind.ColonEqualsToken;
        }

        return false;
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

    private StatementSyntax ParseVariableDeclaration()
    {
        return ParseVariableDeclaration(accessibilityModifier: null);
    }

    private StatementSyntax ParseVariableDeclaration(SyntaxToken accessibilityModifier)
    {
        SyntaxKind expected;
        switch (Current.Kind)
        {
            case SyntaxKind.ConstKeyword:
                expected = SyntaxKind.ConstKeyword;
                break;
            case SyntaxKind.LetKeyword:
                expected = SyntaxKind.LetKeyword;
                break;
            default:
                expected = SyntaxKind.VarKeyword;
                break;
        }

        var keyword = MatchToken(expected);

        // Phase 4.5: `let (a, b, ...) = expr` deconstructs a tuple-typed
        // initializer. The opening paren must come *directly* after the
        // keyword: an explicit type clause or identifier always starts with
        // an identifier, so this is unambiguous.
        if (expected == SyntaxKind.LetKeyword && Current.Kind == SyntaxKind.OpenParenthesisToken)
        {
            var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
            var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
            nodesAndSeparators.Add(MatchToken(SyntaxKind.IdentifierToken));
            while (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                nodesAndSeparators.Add(MatchToken(SyntaxKind.IdentifierToken));
            }

            var idents = new SeparatedSyntaxList<SyntaxToken>(nodesAndSeparators.ToImmutable());
            var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
            var equalsTok = MatchToken(SyntaxKind.EqualsToken);
            var init = ParseExpression();
            return new TupleDeconstructionStatementSyntax(syntaxTree, keyword, openParen, idents, closeParen, equalsTok, init);
        }

        if (expected == SyntaxKind.LetKeyword && Current.Kind == SyntaxKind.OpenBraceToken)
        {
            var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            var fields = ParseNamedDeconstructionFields();
            var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
            var equalsTok = MatchToken(SyntaxKind.EqualsToken);
            var init = ParseExpression();
            return new NamedDeconstructionStatementSyntax(syntaxTree, keyword, openBrace, fields, closeBrace, equalsTok, init);
        }

        // ADR-0058 / issue #376: optional `scoped` contextual modifier between the
        // keyword and the identifier. Disambiguate: `scoped` is only a modifier when
        // followed by another identifier (the variable name).
        SyntaxToken scopedModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "scoped"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            scopedModifier = NextToken();
        }

        // Issue #491 (ADR-0060 follow-up): optional `ref` contextual modifier on
        // `let`/`var` declarations introduces a ref-aliasing local
        // (`let ref m = lvalue` / `var ref m = lvalue`). Disambiguate: `ref` is
        // only a modifier when followed by another identifier (the variable
        // name). If `ref` IS the variable name (no following identifier), treat
        // it as the identifier itself. Rejected on `const` after binding.
        SyntaxToken refKindModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            refKindModifier = NextToken();
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeClause = ParseOptionalTypeClause();

        // A `var` declaration may omit its initializer when an explicit type
        // clause is present (e.g. `var x int32`), in which case the variable
        // takes that type's default value. `let`/`const` remain immutable, so
        // an initializer stays mandatory for them; and without a type clause
        // there is nothing to infer from, so an initializer is still required.
        // Issue #491: a ref-aliasing local always requires an initializer (it
        // must alias an lvalue) — fall through to MatchToken below if absent.
        if (expected == SyntaxKind.VarKeyword
            && refKindModifier == null
            && typeClause != null
            && Current.Kind != SyntaxKind.EqualsToken)
        {
            var decl = new VariableDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                keyword,
                identifier,
                typeClause,
                equalsToken: null,
                initializer: null);
            decl.ScopedModifier = scopedModifier;
            return decl;
        }

        var equals = MatchToken(SyntaxKind.EqualsToken);
        var initializer = ParseExpression();
        var result = new VariableDeclarationSyntax(syntaxTree, accessibilityModifier, keyword, identifier, typeClause, equals, initializer);
        result.ScopedModifier = scopedModifier;
        result.RefKindModifier = refKindModifier;
        return result;
    }

    private SeparatedSyntaxList<NamedDeconstructionFieldSyntax> ParseNamedDeconstructionFields()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var field = MatchToken(SyntaxKind.IdentifierToken);
            var equals = MatchToken(SyntaxKind.EqualsToken);
            var local = MatchToken(SyntaxKind.IdentifierToken);
            nodesAndSeparators.Add(new NamedDeconstructionFieldSyntax(syntaxTree, field, equals, local));
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<NamedDeconstructionFieldSyntax>(nodesAndSeparators.ToImmutable());
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

    // ──────────────────────────────────────────────────────────────────────
    //  ADR-0071 / issue #708: `if let` and `guard let` binding statements.
    // ──────────────────────────────────────────────────────────────────────
    private IfLetStatementSyntax ParseIfLetStatement()
    {
        var ifKeyword = MatchToken(SyntaxKind.IfKeyword);
        var bindings = ParseIfLetBindingList();
        var thenStatement = ParseStatement();
        var elseClause = ParseElseClause();
        return new IfLetStatementSyntax(syntaxTree, ifKeyword, bindings, thenStatement, elseClause);
    }

    private GuardLetStatementSyntax ParseGuardLetStatement()
    {
        var guardKeyword = MatchToken(SyntaxKind.GuardKeyword);
        var bindings = ParseIfLetBindingList();
        var elseKeyword = MatchToken(SyntaxKind.ElseKeyword);
        var elseStatement = ParseStatement();
        return new GuardLetStatementSyntax(syntaxTree, guardKeyword, bindings, elseKeyword, elseStatement);
    }

    private SeparatedSyntaxList<IfLetBindingClauseSyntax> ParseIfLetBindingList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (true)
        {
            nodesAndSeparators.Add(ParseIfLetBindingClause());
            if (Current.Kind != SyntaxKind.CommaToken)
            {
                break;
            }

            // Only treat a comma as a binding separator if it is followed by
            // another `let` keyword. Anything else (a trailing comma, a list
            // expression) is left to the outer parser to flag.
            if (Peek(1).Kind != SyntaxKind.LetKeyword)
            {
                break;
            }

            nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
        }

        return new SeparatedSyntaxList<IfLetBindingClauseSyntax>(nodesAndSeparators.ToImmutable());
    }

    private IfLetBindingClauseSyntax ParseIfLetBindingClause()
    {
        var letKeyword = MatchToken(SyntaxKind.LetKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeClause = ParseOptionalTypeClauseBeforeEquals();
        var equalsToken = MatchToken(SyntaxKind.EqualsToken);

        // Suppress both trailing object initializers (`Foo() { X = 1 }`) AND
        // bare struct literals (`Ident { }`) so the enclosing `{` is the body
        // of the `if let` / `guard let`, not the initializer's shape.
        suppressTrailingObjectInitializer++;
        suppressStructLiteral++;
        ExpressionSyntax initializer;
        try
        {
            initializer = ParseExpression();
        }
        finally
        {
            suppressStructLiteral--;
            suppressTrailingObjectInitializer--;
        }

        return new IfLetBindingClauseSyntax(syntaxTree, letKeyword, identifier, typeClause, equalsToken, initializer);
    }

    private TypeClauseSyntax ParseOptionalTypeClauseBeforeEquals()
    {
        // A binding clause is always followed by `=`; if we see `=` directly
        // there is no type annotation. Otherwise reuse the regular optional
        // type-clause parser (which already handles `[]T`, `map[K,V]`, `T?`,
        // `chan T`, etc.).
        if (Current.Kind == SyntaxKind.EqualsToken)
        {
            return null;
        }

        return ParseOptionalTypeClause();
    }

    private StatementSyntax ParseForStatement()
    {
        if (Peek(1).Kind == SyntaxKind.OpenBraceToken)
        {
            return ParseForInfiniteStatement();
        }

        if (LooksLikeForRange())
        {
            return ParseForRangeStatement();
        }

        if (LooksLikeForEllipsis())
        {
            return ParseForEllipsisStatement();
        }

        if (LooksLikeForClause())
        {
            return ParseForClauseStatement();
        }

        return ParseForConditionStatement();
    }

    private bool LooksLikeForRange()
    {
        // `for <ident> := range <expr> { ... }`
        // `for <ident>, <ident> := range <expr> { ... }`
        // `for <ident> in <expr> { ... }`
        // `for <ident>, <ident> in <expr> { ... }`
        //
        // NB: `for <ident> in <lo> ... <hi> { ... }` is the integer-range
        // (ellipsis) form (ADR-0077). The shared `in` token means we must
        // peek past the collection / lower-bound expression to see whether
        // an ellipsis follows — if so, this is *not* the range form.
        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        int o = 2;
        bool hasCommaSecondId = false;
        if (Peek(o).Kind == SyntaxKind.CommaToken)
        {
            if (Peek(o + 1).Kind != SyntaxKind.IdentifierToken)
            {
                return false;
            }

            hasCommaSecondId = true;
            o += 2;
        }

        if (Peek(o).Kind == SyntaxKind.IdentifierToken && Peek(o).Text == "in")
        {
            // A `k, v in dict` form never collides with the ellipsis form
            // (ellipsis is single-identifier only) — accept immediately.
            if (hasCommaSecondId)
            {
                return true;
            }

            // Single-identifier `in`: distinguish from `for i in lo ... hi`
            // by scanning ahead for an ellipsis at depth zero before the
            // body's open brace.
            return !HasEllipsisBeforeBrace(o + 1);
        }

        if (Peek(o).Kind != SyntaxKind.ColonEqualsToken)
        {
            return false;
        }

        return Peek(o + 1).Kind == SyntaxKind.RangeKeyword;
    }

    private bool HasEllipsisBeforeBrace(int startOffset)
    {
        int depth = 0;
        for (int i = startOffset; i < 256; i++)
        {
            var k = Peek(i).Kind;
            if (depth == 0)
            {
                if (k == SyntaxKind.EllipsisToken)
                {
                    return true;
                }

                if (k == SyntaxKind.OpenBraceToken ||
                    k == SyntaxKind.SemicolonToken ||
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

    private bool LooksLikeForEllipsis()
    {
        // Canonical: `for <ident> in <expr> ... <expr> { ... }`
        // Legacy (removed by ADR-0077 / issue #717, but still recognised by
        // the parser so it can emit GS0305 instead of a parse cascade):
        //   `for <ident> := <expr> ... <expr> { ... }`
        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        var separator = Peek(2);
        var hasSeparator = separator.Kind == SyntaxKind.ColonEqualsToken
            || (separator.Kind == SyntaxKind.IdentifierToken && separator.Text == "in");
        if (!hasSeparator)
        {
            return false;
        }

        int depth = 0;
        for (int i = 3; i < 256; i++)
        {
            var k = Peek(i).Kind;
            if (depth == 0)
            {
                if (k == SyntaxKind.EllipsisToken)
                {
                    return true;
                }

                if (k == SyntaxKind.OpenBraceToken ||
                    k == SyntaxKind.SemicolonToken ||
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

    private bool LooksLikeForClause()
    {
        // `for [init]; [cond]; [post] { ... }` — a semicolon at depth zero
        // before the opening brace marks the C-style clause form.
        if (Peek(1).Kind == SyntaxKind.SemicolonToken)
        {
            return true;
        }

        int depth = 0;
        for (int i = 1; i < 256; i++)
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

    private StatementSyntax ParseForConditionStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var condition = ParseExpressionInBodyHeader();
        var body = ParseStatement();
        return new ForConditionStatementSyntax(syntaxTree, keyword, condition, body);
    }

    private StatementSyntax ParseForClauseStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);

        StatementSyntax initializer = null;
        if (Current.Kind != SyntaxKind.SemicolonToken)
        {
            initializer = ParseSimpleStatement();
        }

        var firstSemicolon = MatchToken(SyntaxKind.SemicolonToken);

        ExpressionSyntax condition = null;
        if (Current.Kind != SyntaxKind.SemicolonToken)
        {
            condition = ParseExpressionInBodyHeader();
        }

        var secondSemicolon = MatchToken(SyntaxKind.SemicolonToken);

        StatementSyntax post = null;
        if (Current.Kind != SyntaxKind.OpenBraceToken)
        {
            // Issue #1023: the post statement sits immediately before the body
            // `{`. Suppress trailing object-initializer wrapping so an indexer-
            // or call-tailed post (`s += arr[s] { … }`) does not consume the
            // loop body's opening brace as a composite literal.
            suppressTrailingObjectInitializer++;
            try
            {
                post = ParseSimpleStatement();
            }
            finally
            {
                suppressTrailingObjectInitializer--;
            }
        }

        var body = ParseStatement();
        return new ForClauseStatementSyntax(syntaxTree, keyword, initializer, firstSemicolon, condition, secondSemicolon, post, body);
    }

    private StatementSyntax ParseSimpleStatement()
    {
        // A "simple statement" in the for-header / if-init context is one of:
        //   variable declaration      `var x = expr` / `let x = expr` (ADR-0077)
        //   legacy short var decl     `x := expr`    — GS0305, removed
        //   increment/decrement       `x++` / `x--`
        //   assignment                `x = expr`, `x += expr`, ...
        //   expression statement      `f()`
        if (Current.Kind == SyntaxKind.VarKeyword || Current.Kind == SyntaxKind.LetKeyword)
        {
            return ParseVariableDeclaration();
        }

        if (Current.Kind == SyntaxKind.IdentifierToken &&
            Peek(1).Kind == SyntaxKind.ColonEqualsToken)
        {
            return ParseSingleShortVariableDeclaration();
        }

        if (Current.Kind == SyntaxKind.IdentifierToken &&
            (Peek(1).Kind == SyntaxKind.PlusPlusToken || Peek(1).Kind == SyntaxKind.MinusMinusToken))
        {
            return ParseIncrementDecrementStatement();
        }

        return ParseExpressionStatement();
    }

    private StatementSyntax ParseForInfiniteStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var body = ParseStatement();
        return new ForInfiniteStatementSyntax(syntaxTree, keyword, body);
    }

    private StatementSyntax ParseForRangeStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var firstIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken commaToken = null;
        SyntaxToken secondIdentifier = null;
        if (Current.Kind == SyntaxKind.CommaToken)
        {
            commaToken = MatchToken(SyntaxKind.CommaToken);
            secondIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        }

        SyntaxToken colonEqualsToken = null;
        SyntaxToken rangeKeyword = null;
        SyntaxToken inToken = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "in")
        {
            inToken = NextToken();
        }
        else
        {
            // ADR-0077 / issue #717: `for v := range coll` (and its `for k, v :=
            // range dict` sibling) is removed. The canonical `for v in coll`
            // form already exists (ADR-0031); emit GS0305 and recover by
            // synthesising an `in` token so binding still produces a
            // `BoundForRangeStatement` and downstream diagnostics are clean.
            colonEqualsToken = MatchToken(SyntaxKind.ColonEqualsToken);
            rangeKeyword = MatchToken(SyntaxKind.RangeKeyword);
            var snippet = secondIdentifier == null
                ? $"for {firstIdentifier.Text} in …"
                : $"for {firstIdentifier.Text}, {secondIdentifier.Text} in …";
            Diagnostics.ReportColonEqualsRemoved(colonEqualsToken.Location, snippet);
            inToken = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, colonEqualsToken.Position, "in", null);
            colonEqualsToken = null;
            rangeKeyword = null;
        }

        var collection = ParseExpressionInBodyHeader();
        var body = ParseStatement();
        return new ForRangeStatementSyntax(syntaxTree, keyword, firstIdentifier, commaToken, secondIdentifier, colonEqualsToken, rangeKeyword, inToken, collection, body);
    }

    private StatementSyntax ParseForEllipsisStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken colonEqualsToken;
        SyntaxToken inToken = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "in")
        {
            // ADR-0077 / issue #717: `for i in lo ... hi` is the canonical
            // integer-range form. The legacy `:=` spelling is removed below.
            inToken = NextToken();
            colonEqualsToken = null;
        }
        else
        {
            colonEqualsToken = MatchToken(SyntaxKind.ColonEqualsToken);
            Diagnostics.ReportColonEqualsRemoved(
                colonEqualsToken.Location,
                $"for {identifier.Text} in lo ... hi");
            inToken = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, colonEqualsToken.Position, "in", null);
        }

        var lowerBound = ParseExpressionInBodyHeader();
        var toKeyword = MatchToken(SyntaxKind.EllipsisToken);
        var upperBound = ParseExpressionInBodyHeader();
        var body = ParseStatement();
        return new ForEllipsisStatementSyntax(syntaxTree, keyword, identifier, inToken, lowerBound, toKeyword, upperBound, body);
    }

    private StatementSyntax ParseBreakStatement()
    {
        var keyword = MatchToken(SyntaxKind.BreakKeyword);
        var label = TryParseLoopTargetLabel(keyword);
        return new BreakStatementSyntax(syntaxTree, keyword, label);
    }

    private StatementSyntax ParseContinueStatement()
    {
        var keyword = MatchToken(SyntaxKind.ContinueKeyword);
        var label = TryParseLoopTargetLabel(keyword);
        return new ContinueStatementSyntax(syntaxTree, keyword, label);
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

    private StatementSyntax ParseLabeledLoopStatement()
    {
        var label = MatchToken(SyntaxKind.IdentifierToken);
        var colon = MatchToken(SyntaxKind.ColonToken);
        var inner = ParseStatement();
        return new LabeledStatementSyntax(syntaxTree, label, colon, inner);
    }

    private StatementSyntax ParseWhileStatement()
    {
        // ADR-0070: `while cond { body }` — same lowering as `for cond { body }`.
        var keyword = MatchToken(SyntaxKind.WhileKeyword);
        var condition = ParseExpressionInBodyHeader();
        var body = ParseStatement();
        return new WhileStatementSyntax(syntaxTree, keyword, condition, body);
    }

    private StatementSyntax ParseDoWhileStatement()
    {
        // ADR-0070: `do { body } while cond` — post-test loop. The trailing
        // `while` keyword reuses SyntaxKind.WhileKeyword so the lexer is
        // unchanged; the parser disambiguates by remembering it saw `do`.
        var doKeyword = MatchToken(SyntaxKind.DoKeyword);
        var body = ParseStatement();
        var whileKeyword = MatchToken(SyntaxKind.WhileKeyword);
        var condition = ParseExpression();
        return new DoWhileStatementSyntax(syntaxTree, doKeyword, body, whileKeyword, condition);
    }

    private StatementSyntax ParseReturnStatement()
    {
        var keyword = MatchToken(SyntaxKind.ReturnKeyword);
        var keywordLine = syntaxTree.Text.GetLineIndex(keyword.Span.Start);
        var currentLine = syntaxTree.Text.GetLineIndex(Current.Span.Start);
        var isEof = Current.Kind == SyntaxKind.EndOfFileToken;
        var sameLine = !isEof && keywordLine == currentLine;
        SyntaxToken refKeyword = null;
        ExpressionSyntax expression = null;
        if (sameLine)
        {
            // Issue #490 (ADR-0060 follow-up): optional `ref` contextual modifier directly
            // following `return` marks this as a ref-return: `return ref <lvalue>`. The
            // modifier is consumed only when an expression-starting token follows on the
            // same line, preserving backward compatibility for `return ref` where `ref` is
            // itself the identifier being returned (the binder rejects `return ref` with
            // no operand on a ref-returning function).
            if (Current.Kind == SyntaxKind.IdentifierToken
                && Current.Text == "ref"
                && CanStartExpression(Peek(1))
                && syntaxTree.Text.GetLineIndex(Peek(1).Span.Start) == keywordLine)
            {
                refKeyword = NextToken();
            }

            expression = ParseExpression();

            // Phase 4.6: multi-return support. `return e1, e2, ...` lowers to
            // returning a tuple literal so callers can deconstruct or bind it
            // through the standard tuple machinery.
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
                nodesAndSeparators.Add(expression);
                var syntheticOpen = new SyntaxToken(syntaxTree, SyntaxKind.OpenParenthesisToken, keyword.Position, null, null);
                while (Current.Kind == SyntaxKind.CommaToken)
                {
                    nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                    nodesAndSeparators.Add(ParseExpression());
                }

                var syntheticClose = new SyntaxToken(syntaxTree, SyntaxKind.CloseParenthesisToken, Current.Position, null, null);
                var elements = new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable());
                expression = new TupleLiteralExpressionSyntax(syntaxTree, syntheticOpen, elements, syntheticClose);
            }
        }

        return new ReturnStatementSyntax(syntaxTree, keyword, refKeyword, expression);
    }

    private StatementSyntax ParseYieldStatement()
    {
        // ADR-0040: `yield <expr>` statement. The `yield` token is a contextual
        // identifier (not a reserved keyword) to preserve source compatibility.
        var yieldToken = MatchToken(SyntaxKind.IdentifierToken);
        var expression = ParseExpression();
        return new YieldStatementSyntax(syntaxTree, yieldToken, expression);
    }

    /// <summary>
    /// Issue #813: lookahead helper for the contextual <c>yield</c> at statement
    /// start. Returns <see langword="true"/> when the token at <paramref name="parenOffset"/>
    /// is a <c>(</c> that opens a value-tuple literal (i.e. its matching
    /// <c>)</c> follows a top-level <c>,</c>). A tuple-literal yield like
    /// <c>yield (a, b)</c> must be parsed as a yield-statement; without this
    /// disambiguation the existing rule rejected every <c>yield (</c> form
    /// because it treats parens as the start of a function-call expression.
    /// </summary>
    private bool LooksLikeYieldTupleLiteral(int parenOffset)
    {
        if (Peek(parenOffset).Kind != SyntaxKind.OpenParenthesisToken)
        {
            return false;
        }

        var depth = 0;
        var bracketDepth = 0;
        var braceDepth = 0;
        for (var i = parenOffset; i < tokens.Length; i++)
        {
            var t = Peek(i);
            switch (t.Kind)
            {
                case SyntaxKind.OpenParenthesisToken:
                    depth++;
                    break;
                case SyntaxKind.CloseParenthesisToken:
                    depth--;
                    if (depth == 0)
                    {
                        return false;
                    }

                    break;
                case SyntaxKind.OpenSquareBracketToken:
                    bracketDepth++;
                    break;
                case SyntaxKind.CloseSquareBracketToken:
                    bracketDepth--;
                    break;
                case SyntaxKind.OpenBraceToken:
                    braceDepth++;
                    break;
                case SyntaxKind.CloseBraceToken:
                    braceDepth--;
                    break;
                case SyntaxKind.CommaToken:
                    if (depth == 1 && bracketDepth == 0 && braceDepth == 0)
                    {
                        return true;
                    }

                    break;
                case SyntaxKind.EndOfFileToken:
                    return false;
            }
        }

        return false;
    }

    private StatementSyntax ParseSwitchStatement()
    {
        var switchKeyword = MatchToken(SyntaxKind.SwitchKeyword);
        var expression = ParseExpressionInBodyHeader();
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        var cases = ImmutableArray.CreateBuilder<SwitchCaseSyntax>();
        while (Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;
            cases.Add(ParseSwitchCase());

            // Defensive: if ParseSwitchCase failed to consume any token, break to
            // avoid an infinite loop.
            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new SwitchStatementSyntax(syntaxTree, switchKeyword, expression, openBrace, cases.ToImmutable(), closeBrace);
    }

    private SwitchCaseSyntax ParseSwitchCase()
    {
        if (Current.Kind == SyntaxKind.DefaultKeyword)
        {
            var defaultKeyword = MatchToken(SyntaxKind.DefaultKeyword);
            var body = ParseBlockStatement();
            return new SwitchCaseSyntax(syntaxTree, defaultKeyword, value: null, whenKeyword: null, guard: null, body);
        }

        var caseKeyword = MatchToken(SyntaxKind.CaseKeyword);
        var value = ParsePattern();
        var (whenKeyword, guard) = ParseOptionalWhenGuard();
        var caseBody = ParseBlockStatement();
        return new SwitchCaseSyntax(syntaxTree, caseKeyword, value, whenKeyword, guard, caseBody);
    }

    // Issue #991: a contextual `when <bool-expr>` guard may follow the pattern
    // in a switch arm. `when` is not a reserved keyword in G#, so it is matched
    // contextually as an identifier whose text is "when"; this keeps existing
    // identifiers named `when` usable everywhere else. Returns (null, null) when
    // no guard is present.
    private (SyntaxToken WhenKeyword, ExpressionSyntax Guard) ParseOptionalWhenGuard()
    {
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "when")
        {
            var whenKeyword = NextToken();
            var guard = ParseExpression();
            return (whenKeyword, guard);
        }

        return (null, null);
    }

    private PatternSyntax ParsePattern()
    {
        return ParseOrPattern();
    }

    // Combinator precedence (matches C#): `not` binds tightest, then `and`,
    // then `or`. `and` / `or` / `not` are contextual keywords matched as
    // identifiers in pattern position so they remain usable as ordinary
    // identifiers elsewhere.
    private PatternSyntax ParseOrPattern()
    {
        var left = ParseAndPattern();
        while (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "or")
        {
            var operatorToken = NextToken();
            var right = ParseAndPattern();
            left = new BinaryPatternSyntax(syntaxTree, left, operatorToken, right);
        }

        return left;
    }

    private PatternSyntax ParseAndPattern()
    {
        var left = ParseUnaryPattern();
        while (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "and")
        {
            var operatorToken = NextToken();
            var right = ParseUnaryPattern();
            left = new BinaryPatternSyntax(syntaxTree, left, operatorToken, right);
        }

        return left;
    }

    private PatternSyntax ParseUnaryPattern()
    {
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "not")
        {
            var notKeyword = NextToken();
            var operand = ParseUnaryPattern();
            return new NotPatternSyntax(syntaxTree, notKeyword, operand);
        }

        return ParsePrimaryPattern();
    }

    private PatternSyntax ParsePrimaryPattern()
    {
        switch (Current.Kind)
        {
            case SyntaxKind.OpenParenthesisToken:
                return ParseParenthesizedPattern();
            case SyntaxKind.OpenSquareBracketToken:
                return ParseListPattern();
            case SyntaxKind.OpenBraceToken:
                return ParsePropertyPattern();
            case SyntaxKind.IdentifierToken when Peek(1).Kind == SyntaxKind.IsKeyword:
                return ParseTypePattern();
            case SyntaxKind.IdentifierToken when Current.Text == "_" && Peek(1).Kind != SyntaxKind.OpenParenthesisToken && Peek(1).Kind != SyntaxKind.DotToken:
                return new DiscardPatternSyntax(syntaxTree, MatchToken(SyntaxKind.IdentifierToken));
            case SyntaxKind.LessToken:
            case SyntaxKind.LessOrEqualsToken:
            case SyntaxKind.GreaterToken:
            case SyntaxKind.GreaterOrEqualsToken:
            case SyntaxKind.EqualsEqualsToken:
            case SyntaxKind.BangEqualsToken:
                return ParseRelationalPattern();
            default:
                return new ConstantPatternSyntax(syntaxTree, ParseExpression());
        }
    }

    private PatternSyntax ParseParenthesizedPattern()
    {
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var pattern = ParsePattern();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new ParenthesizedPatternSyntax(syntaxTree, openParen, pattern, closeParen);
    }

    private PatternSyntax ParseTypePattern()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var isKeyword = MatchToken(SyntaxKind.IsKeyword);
        var type = ParseTypeClause();
        return new TypePatternSyntax(syntaxTree, identifier, isKeyword, type);
    }

    private PatternSyntax ParseRelationalPattern()
    {
        var operatorToken = NextToken();
        var expression = ParseExpression();
        return new RelationalPatternSyntax(syntaxTree, operatorToken, expression);
    }

    private PatternSyntax ParsePropertyPattern()
    {
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var colon = MatchToken(SyntaxKind.ColonToken);
            var pattern = ParsePattern();
            nodesAndSeparators.Add(new PropertyPatternFieldSyntax(syntaxTree, identifier, colon, pattern));
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var fields = new SeparatedSyntaxList<PropertyPatternFieldSyntax>(nodesAndSeparators.ToImmutable());
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new PropertyPatternSyntax(syntaxTree, openBrace, fields, closeBrace);
    }

    private PatternSyntax ParseListPattern()
    {
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (Current.Kind != SyntaxKind.CloseSquareBracketToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParsePattern());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var elements = new SeparatedSyntaxList<PatternSyntax>(nodesAndSeparators.ToImmutable());
        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        return new ListPatternSyntax(syntaxTree, openBracket, elements, closeBracket);
    }

    private StatementSyntax ParseFallthroughStatement()
    {
        // ADR-0013: `fallthrough` is reserved but unsupported. Consume the token and
        // emit a diagnostic so user code surfaces a clear error.
        var keyword = MatchToken(SyntaxKind.FallthroughKeyword);
        Diagnostics.ReportFallthroughNotSupported(keyword.Location);
        return new ExpressionStatementSyntax(syntaxTree, new LiteralExpressionSyntax(syntaxTree, keyword, value: 0));
    }

    private StatementSyntax ParseTryStatement()
    {
        var tryKeyword = MatchToken(SyntaxKind.TryKeyword);
        var tryBlock = ParseBlockStatement();

        var catchClauses = ImmutableArray.CreateBuilder<CatchClauseSyntax>();
        while (Current.Kind == SyntaxKind.CatchKeyword)
        {
            catchClauses.Add(ParseCatchClause());
        }

        FinallyClauseSyntax finallyClause = null;
        if (Current.Kind == SyntaxKind.FinallyKeyword)
        {
            var finallyKeyword = NextToken();
            var body = ParseBlockStatement();
            finallyClause = new FinallyClauseSyntax(syntaxTree, finallyKeyword, body);
        }

        return new TryStatementSyntax(syntaxTree, tryKeyword, tryBlock, catchClauses.ToImmutable(), finallyClause);
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

    private StatementSyntax ParseThrowStatement()
    {
        var keyword = MatchToken(SyntaxKind.ThrowKeyword);
        var expression = ParseExpression();
        return new ThrowStatementSyntax(syntaxTree, keyword, expression);
    }

    // Issue #1018: parses a throw-expression `throw <expr>` in value position.
    // The operand is parsed at full-expression precedence (greedy), matching
    // C#'s rule that `a ?? throw b ?? c` throws `(b ?? c)`. The throw-expression
    // itself is produced as a primary expression so it composes as the RHS of
    // `??`, a conditional branch, a returned operand, an argument, or an arrow
    // body.
    private ExpressionSyntax ParseThrowExpression()
    {
        var keyword = MatchToken(SyntaxKind.ThrowKeyword);
        var expression = ParseExpression();
        return new ThrowExpressionSyntax(syntaxTree, keyword, expression);
    }

    private StatementSyntax ParseUsingStatement()
    {
        var keyword = MatchToken(SyntaxKind.UsingKeyword);
        if (Current.Kind != SyntaxKind.LetKeyword &&
            Current.Kind != SyntaxKind.VarKeyword &&
            Current.Kind != SyntaxKind.ConstKeyword)
        {
            // Force the expected keyword diagnostic by matching `let`.
            MatchToken(SyntaxKind.LetKeyword);
        }

        var decl = (VariableDeclarationSyntax)ParseVariableDeclaration();
        return new UsingStatementSyntax(syntaxTree, keyword, decl);
    }

    private StatementSyntax ParseAwaitUsingStatement()
    {
        var awaitKeyword = MatchToken(SyntaxKind.AwaitKeyword);
        var usingKeyword = MatchToken(SyntaxKind.UsingKeyword);
        if (Current.Kind != SyntaxKind.LetKeyword &&
            Current.Kind != SyntaxKind.VarKeyword &&
            Current.Kind != SyntaxKind.ConstKeyword)
        {
            MatchToken(SyntaxKind.LetKeyword);
        }

        var decl = (VariableDeclarationSyntax)ParseVariableDeclaration();
        return new AwaitUsingStatementSyntax(syntaxTree, awaitKeyword, usingKeyword, decl);
    }

    private StatementSyntax ParseGoStatement()
    {
        var keyword = MatchToken(SyntaxKind.GoKeyword);
        var expression = ParseExpression();
        return new GoStatementSyntax(syntaxTree, keyword, expression);
    }

    private StatementSyntax ParseDeferStatement()
    {
        var keyword = MatchToken(SyntaxKind.DeferKeyword);
        var expression = ParseExpression();
        return new DeferStatementSyntax(syntaxTree, keyword, expression);
    }

    private StatementSyntax ParseScopeStatement()
    {
        // Phase 5.7 / ADR-0022: `scope { … }` opens a structured-concurrency region.
        var scopeKeyword = MatchToken(SyntaxKind.ScopeKeyword);
        var body = ParseBlockStatement();
        return new ScopeStatementSyntax(syntaxTree, scopeKeyword, body);
    }

    private StatementSyntax ParseAwaitForRangeStatement()
    {
        // Canonical: `await for v in stream { … }` (ADR-0031).
        // Legacy `:=` spelling removed by ADR-0077 / issue #717 — emit GS0305
        // when the parser still encounters it.
        var awaitKeyword = MatchToken(SyntaxKind.AwaitKeyword);
        var forKeyword = MatchToken(SyntaxKind.ForKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken colonEquals = null;
        SyntaxToken rangeKeyword = null;
        SyntaxToken inToken = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "in")
        {
            inToken = NextToken();
        }
        else
        {
            colonEquals = MatchToken(SyntaxKind.ColonEqualsToken);
            rangeKeyword = MatchToken(SyntaxKind.RangeKeyword);
            Diagnostics.ReportColonEqualsRemoved(
                colonEquals.Location,
                $"await for {identifier.Text} in …");
            inToken = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, colonEquals.Position, "in", null);
            colonEquals = null;
            rangeKeyword = null;
        }

        var stream = ParseExpressionInBodyHeader();
        var body = ParseBlockStatement();
        return new AwaitForRangeStatementSyntax(
            syntaxTree, awaitKeyword, forKeyword, identifier, colonEquals, rangeKeyword, inToken, stream, body);
    }

    private StatementSyntax ParseSelectStatement()
    {
        // Phase 5.6 / ADR-0022: `select { case <-ch { … } case ch <- v { … }
        //                                  case v := <-ch { … } default { … } }`.
        var selectKeyword = MatchToken(SyntaxKind.SelectKeyword);
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        var cases = ImmutableArray.CreateBuilder<SelectCaseSyntax>();
        while (Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;
            cases.Add(ParseSelectCase());

            // Defensive: avoid infinite loops if ParseSelectCase failed to advance.
            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new SelectStatementSyntax(syntaxTree, selectKeyword, openBrace, cases.ToImmutable(), closeBrace);
    }

    private SelectCaseSyntax ParseSelectCase()
    {
        if (Current.Kind == SyntaxKind.DefaultKeyword)
        {
            var defaultKeyword = MatchToken(SyntaxKind.DefaultKeyword);
            var body = ParseBlockStatement();
            return new SelectCaseSyntax(
                syntaxTree,
                defaultKeyword,
                SelectCaseKind.Default,
                identifier: null,
                channel: null,
                value: null,
                body);
        }

        var caseKeyword = MatchToken(SyntaxKind.CaseKeyword);

        // case <-ch { ... } — receive, discard.
        if (Current.Kind == SyntaxKind.LeftArrowToken)
        {
            NextToken(); // consume `<-`
            var channel = ParseExpression();
            var body = ParseBlockStatement();
            return new SelectCaseSyntax(
                syntaxTree,
                caseKeyword,
                SelectCaseKind.ReceiveDiscard,
                identifier: null,
                channel,
                value: null,
                body);
        }

        // case let v = <-ch { ... } — receive, bind (ADR-0077).
        if (Current.Kind == SyntaxKind.LetKeyword &&
            Peek(1).Kind == SyntaxKind.IdentifierToken &&
            Peek(2).Kind == SyntaxKind.EqualsToken &&
            Peek(3).Kind == SyntaxKind.LeftArrowToken)
        {
            NextToken(); // consume `let`
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            MatchToken(SyntaxKind.EqualsToken);
            MatchToken(SyntaxKind.LeftArrowToken);
            var channel = ParseExpression();
            var body = ParseBlockStatement();
            return new SelectCaseSyntax(
                syntaxTree,
                caseKeyword,
                SelectCaseKind.ReceiveBind,
                identifier,
                channel,
                value: null,
                body);
        }

        // case v := <-ch { ... } — legacy receive-bind. ADR-0077 / issue #717
        // removes `:=`; emit GS0305 and recover by binding the identifier as
        // a `case let v = <-ch` would.
        if (Current.Kind == SyntaxKind.IdentifierToken &&
            Peek(1).Kind == SyntaxKind.ColonEqualsToken &&
            Peek(2).Kind == SyntaxKind.LeftArrowToken)
        {
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var colonEquals = MatchToken(SyntaxKind.ColonEqualsToken);
            Diagnostics.ReportColonEqualsRemoved(
                colonEquals.Location,
                $"case let {identifier.Text} = <-ch");
            MatchToken(SyntaxKind.LeftArrowToken);
            var channel = ParseExpression();
            var body = ParseBlockStatement();
            return new SelectCaseSyntax(
                syntaxTree,
                caseKeyword,
                SelectCaseKind.ReceiveBind,
                identifier,
                channel,
                value: null,
                body);
        }

        // case ch <- v { ... } — send.
        var sendChannel = ParseExpression();
        MatchToken(SyntaxKind.LeftArrowToken);
        var sendValue = ParseExpression();
        var sendBody = ParseBlockStatement();
        return new SelectCaseSyntax(
            syntaxTree,
            caseKeyword,
            SelectCaseKind.Send,
            identifier: null,
            sendChannel,
            sendValue,
            sendBody);
    }

    private StatementSyntax ParseExpressionStatement()
    {
        var expression = ParseExpression();

        if (Current.Kind == SyntaxKind.QuestionQuestionEqualsToken)
        {
            // ADR-0072 / issue #709: `target ??= value` is also valid as a
            // simple statement inside for-headers and other simple-statement
            // contexts.
            var opToken = NextToken();
            var rhs = ParseExpression();
            return new NullCoalescingAssignmentStatementSyntax(syntaxTree, expression, opToken, rhs);
        }

        return new ExpressionStatementSyntax(syntaxTree, expression);
    }

    private StatementSyntax ParseExpressionOrChannelSendStatement()
    {
        var expression = ParseExpression();
        if (Current.Kind == SyntaxKind.LeftArrowToken)
        {
            // Phase 5.5 / ADR-0022: `ch <- v` is a statement, not an expression.
            var arrow = NextToken();
            var value = ParseExpression();
            return new ChannelSendStatementSyntax(syntaxTree, expression, arrow, value);
        }

        if (Current.Kind == SyntaxKind.QuestionQuestionEqualsToken)
        {
            // ADR-0072 / issue #709: `target ??= value`. The target must be a
            // nullable lvalue. We don't desugar here — the binder validates
            // assignability + nullability and emits a lowered if/assign form.
            var opToken = NextToken();
            var rhs = ParseExpression();
            return new NullCoalescingAssignmentStatementSyntax(syntaxTree, expression, opToken, rhs);
        }

        return new ExpressionStatementSyntax(syntaxTree, expression);
    }

    private ExpressionSyntax ParseExpression()
    {
        return ParseAssignmentExpression();
    }

    private ExpressionSyntax ParseAssignmentExpression()
    {
        if (Peek(0).Kind == SyntaxKind.IdentifierToken &&
            Peek(1).Kind == SyntaxKind.OpenSquareBracketToken &&
            TryFindMatchingCloseBracketFollowedByEquals(out var equalsOffset))
        {
            var identifierToken = NextToken();
            var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
            var index = ParseExpression();
            var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
            var equalsToken = MatchToken(SyntaxKind.EqualsToken);
            var value = ParseAssignmentExpression();
            _ = equalsOffset;
            return new IndexAssignmentExpressionSyntax(
                syntaxTree,
                identifierToken,
                openBracket,
                index,
                closeBracket,
                equalsToken,
                value);
        }

        if (Peek(0).Kind == SyntaxKind.IdentifierToken &&
            Peek(1).Kind == SyntaxKind.DotToken &&
            Peek(2).Kind == SyntaxKind.IdentifierToken &&
            Peek(3).Kind == SyntaxKind.EqualsToken)
        {
            var identifierToken = NextToken();
            var dotToken = MatchToken(SyntaxKind.DotToken);
            var fieldIdentifier = MatchToken(SyntaxKind.IdentifierToken);
            var equalsToken = MatchToken(SyntaxKind.EqualsToken);
            var value = ParseAssignmentExpression();
            return new FieldAssignmentExpressionSyntax(syntaxTree, identifierToken, dotToken, fieldIdentifier, equalsToken, value);
        }

        if (Peek(0).Kind == SyntaxKind.IdentifierToken &&
            Peek(1).Kind == SyntaxKind.EqualsToken)
        {
            var identifierToken = NextToken();
            var operatorToken = NextToken();
            var right = ParseAssignmentExpression();
            return new AssignmentExpressionSyntax(syntaxTree, identifierToken, operatorToken, right);
        }

        if (Peek(0).Kind == SyntaxKind.IdentifierToken &&
            SyntaxFacts.TryGetCompoundAssignmentBaseOperator(Peek(1).Kind, out var baseOpKind))
        {
            // For `+=` and `-=` on a bare identifier, emit an
            // EventSubscriptionExpressionSyntax so the binder can distinguish
            // event subscription (`EventName += handler`) from compound
            // arithmetic assignment (`x += 1`). The binder falls back to
            // compound assignment if the name is not an event.
            if (Peek(1).Kind == SyntaxKind.PlusEqualsToken || Peek(1).Kind == SyntaxKind.MinusEqualsToken)
            {
                var identifierToken = NextToken();
                var opToken = NextToken();
                var rhs = ParseAssignmentExpression();
                var leftName = new NameExpressionSyntax(syntaxTree, identifierToken);
                return new EventSubscriptionExpressionSyntax(syntaxTree, leftName, opToken, rhs);
            }

            var identifierToken2 = NextToken();
            var compoundToken = NextToken();
            var right = ParseAssignmentExpression();

            var leftName2 = new NameExpressionSyntax(syntaxTree, identifierToken2);
            var baseOpToken = new SyntaxToken(syntaxTree, baseOpKind, compoundToken.Position, SyntaxFacts.GetText(baseOpKind), null);
            var binary = new BinaryExpressionSyntax(syntaxTree, leftName2, baseOpToken, right);
            var equalsToken = new SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, compoundToken.Position, SyntaxFacts.GetText(SyntaxKind.EqualsToken), null);
            return new AssignmentExpressionSyntax(syntaxTree, identifierToken2, equalsToken, binary);
        }

        var expression = ParseRangeExpression();

        // Issue #507: indexer assignment whose target is an arbitrary expression
        // (e.g. `obj.Member[k] = v`, `a.b.c[k] = v`, `(GetThing())[i] = v`). The
        // bare-identifier form `id[k] = v` is already handled above as
        // IndexAssignmentExpressionSyntax; this branch handles any other LHS shape
        // whose trailing primary is an index access. Because ParsePostfixChain
        // recursively folds `[...]` into the right-hand side of the most recent
        // `.`, the parsed tree for `obj.Member[k]` is
        // `AccessorExpression(obj, ., IndexExpression(Member, [k]))` — not a
        // top-level IndexExpression. TryLiftTrailingIndexer reshapes such chains
        // into the canonical `IndexExpression(<receiver-chain>, [k])` form before
        // wrapping in MemberIndexAssignmentExpressionSyntax.
        if (Current.Kind == SyntaxKind.EqualsToken
            && TryLiftTrailingIndexer(expression, out var indexedLhs))
        {
            var equalsToken = NextToken();
            var value = ParseAssignmentExpression();
            return new MemberIndexAssignmentExpressionSyntax(syntaxTree, indexedLhs, equalsToken, value);
        }

        // Issue #648: chained member-access assignment whose target is an
        // arbitrary expression (e.g. `a.B.C = v`, `GetObj().Field = v`). The
        // bare-identifier form `id.field = v` is handled above as
        // FieldAssignmentExpressionSyntax; this branch handles any deeper chain
        // where the last segment is a plain member name (NameExpressionSyntax).
        if (Current.Kind == SyntaxKind.EqualsToken
            && TryLiftTrailingMemberAccess(expression, out var memberReceiver, out var memberDot, out var memberField))
        {
            var equalsToken = NextToken();
            var value = ParseAssignmentExpression();
            return new MemberFieldAssignmentExpressionSyntax(syntaxTree, memberReceiver, memberDot, memberField, equalsToken, value);
        }

        // Issue #507 follow-up: compound indexer assignment
        // (`d[k] += v`, `obj.Map[k] -= 1`, ...). Mirrors the bare `=` lift above
        // but routes through CompoundIndexAssignmentExpressionSyntax so the
        // binder can evaluate the receiver chain exactly once via a synthesized
        // temp local before desugaring to `tmp[k] = tmp[k] op v`. The
        // bare-identifier form `id[k] op= v` also lands here (TryLift returns
        // the IndexExpression directly when the expression already IS one).
        if (SyntaxFacts.TryGetCompoundAssignmentBaseOperator(Current.Kind, out _)
            && TryLiftTrailingIndexer(expression, out var compoundIndexedLhs))
        {
            var compoundOpToken = NextToken();
            var compoundRhs = ParseAssignmentExpression();
            return new CompoundIndexAssignmentExpressionSyntax(syntaxTree, compoundIndexedLhs, compoundOpToken, compoundRhs);
        }

        // ADR-0062: general two-arm conditional (ternary) expression
        // `cond ? a : b`. Right-associative; lower precedence than
        // logical-or and higher than assignment. When the `?` tail
        // matches the legacy ADR-0061 inner-modifier form
        // (`cond ? ref a : ref b`), produce a ConditionalRefArgumentExpression
        // for backward compatibility; otherwise produce the general
        // ConditionalExpressionSyntax.
        if (Current.Kind == SyntaxKind.QuestionToken)
        {
            expression = ParseConditionalTail(expression);
        }

        // ADR-0060 §13: indirect assignment `*p = expr`. Detected when the
        // parsed primary is a unary `*` dereference followed by `=`. The
        // binder produces a `BoundIndirectAssignmentExpression` which the
        // emitter lowers to `<load-address> <value> stind.*`.
        if (expression is UnaryExpressionSyntax unaryDeref
            && unaryDeref.OperatorToken.Kind == SyntaxKind.StarToken
            && Current.Kind == SyntaxKind.EqualsToken)
        {
            var equalsToken = NextToken();
            var value = ParseAssignmentExpression();
            return new IndirectAssignmentExpressionSyntax(syntaxTree, unaryDeref, equalsToken, value);
        }

        // Stream B′: `receiver.Event += handler` / `receiver.Event -= handler`
        // is captured as an EventSubscriptionExpressionSyntax once the LHS has
        // been parsed as a member-access chain. The binder later validates that
        // the LHS resolves to a CLR EventInfo.
        if (expression is AccessorExpressionSyntax accessor
            && (Current.Kind == SyntaxKind.PlusEqualsToken || Current.Kind == SyntaxKind.MinusEqualsToken))
        {
            var opToken = NextToken();
            var rhs = ParseAssignmentExpression();
            return new EventSubscriptionExpressionSyntax(syntaxTree, accessor, opToken, rhs);
        }

        return expression;
    }

    // Issue #1038: parse a standalone range expression `lo..hi` (and the open
    // forms `..hi`, `lo..`, `..`) producing a `System.Range` value. The `..`
    // operator binds looser than every binary operator, so `1+2..3+4` parses as
    // `(1+2)..(3+4)`: each bound is a full null-coalescing expression. A from-end
    // `^n` marker is recognised only in the *upper* bound (immediately after
    // `..`), where it is unambiguous with one's-complement; a leading `^` at the
    // very start keeps its one's-complement meaning and the binder rejects such a
    // standalone lower bound with GS0410 (use `arr[^a..]` or parenthesise).
    //
    // While parsing an index bound the range layer is suppressed (see
    // <see cref="suppressRangeOperator"/>) so `a[lo..hi]` / `a[^2..]` stay owned
    // by <see cref="ParseIndexArgument"/>.
    private ExpressionSyntax ParseRangeExpression()
    {
        if (suppressRangeOperator > 0)
        {
            return ParseNullCoalescingExpression();
        }

        ExpressionSyntax lower = null;
        if (Current.Kind != SyntaxKind.DotDotToken)
        {
            lower = ParseNullCoalescingExpression();
        }

        if (Current.Kind != SyntaxKind.DotDotToken)
        {
            // No `..` follows — an ordinary expression (`lower` is non-null here
            // because the open-lower `..` form is handled by the branch above).
            return lower;
        }

        var dotDotToken = NextToken();

        ExpressionSyntax upper = null;
        if (RangeUpperBoundFollows(dotDotToken))
        {
            upper = ParseRangeUpperBound();
        }

        return new RangeExpressionSyntax(syntaxTree, lower, dotDotToken, upper);
    }

    // Issue #1038: decide whether an upper bound follows a standalone `lo..`. The
    // open-ended form `lo..` ends at a closing delimiter, a separator, or a
    // newline (G# treats a line break after `..` as terminating the open range,
    // so `let r = 1..\nfoo()` is `1..` followed by a fresh statement rather than
    // `1..foo()`).
    private bool RangeUpperBoundFollows(SyntaxToken dotDotToken)
    {
        if (IsCurrentOnNewLineAfter(dotDotToken))
        {
            return false;
        }

        switch (Current.Kind)
        {
            case SyntaxKind.CloseParenthesisToken:
            case SyntaxKind.CloseBraceToken:
            case SyntaxKind.CloseSquareBracketToken:
            case SyntaxKind.CommaToken:
            case SyntaxKind.SemicolonToken:
            case SyntaxKind.ColonToken:
            case SyntaxKind.EqualsToken:
            case SyntaxKind.EndOfFileToken:
            case SyntaxKind.DotDotToken:
                return false;
            default:
                return true;
        }
    }

    // Issue #1038: parse the upper bound of a standalone range. A leading `^`
    // here (immediately after `..`) is the from-end marker (`lo..^hi`, `..^3`),
    // reusing the #1022 `FromEndIndexExpressionSyntax`; otherwise the bound is an
    // ordinary null-coalescing expression.
    private ExpressionSyntax ParseRangeUpperBound()
    {
        if (Current.Kind == SyntaxKind.HatToken)
        {
            var hatToken = NextToken();
            var operand = ParseNullCoalescingExpression();
            return new FromEndIndexExpressionSyntax(syntaxTree, hatToken, operand);
        }

        return ParseNullCoalescingExpression();
    }

    // Issue #941: `a ?? b` binary null-coalescing operator. Parsed as its own
    // layer between the binary-operator loop and the assignment/ternary tail so
    // that it (a) binds at a precedence strictly below `||` (the lowest binary
    // operator), and (b) is right-associative, so `a ?? b ?? c` parses as
    // `a ?? (b ?? c)` — matching C#'s `??`. The produced node is an ordinary
    // BinaryExpressionSyntax with a QuestionQuestionToken operator, so the
    // binder/emitter reuse the existing NullCoalesce machinery.
    private ExpressionSyntax ParseNullCoalescingExpression()
    {
        var left = ParseBinaryExpression();

        if (Current.Kind == SyntaxKind.QuestionQuestionToken)
        {
            var operatorToken = NextToken();
            var right = ParseNullCoalescingExpression();
            return new BinaryExpressionSyntax(syntaxTree, left, operatorToken, right);
        }

        return left;
    }

    private ExpressionSyntax ParseBinaryExpression(int parentPrecedence = 0)
    {
        ExpressionSyntax left;
        var unaryOperatorPrecedence = Current.Kind.GetUnaryOperatorPrecedence();
        if (Current.Kind == SyntaxKind.PlusPlusToken || Current.Kind == SyntaxKind.MinusMinusToken)
        {
            // ADR-0126 / issue #1027: prefix increment/decrement `++x` / `--x`.
            // Binds at the unary precedence tier so `++a.b[c]` targets the whole
            // lvalue and `++a + b` parses as `(++a) + b`.
            var prefixOp = NextToken();
            var prefixOperand = ParseBinaryExpression(6);
            left = BuildIncrementDecrementExpression(prefixOperand, prefixOp, isPrefix: true);
        }
        else if (unaryOperatorPrecedence != 0 && unaryOperatorPrecedence >= parentPrecedence)
        {
            var operatorToken = NextToken();
            var operand = ParseBinaryExpression(unaryOperatorPrecedence);

            // ADR-0061: support `&<cond> ? <lvalue> : <lvalue>` as a bare
            // address-of of a conditional lvalue. Without this special case,
            // a stray `?` after `&x` would otherwise be unparseable (there is
            // no general ternary in G#).
            if (operatorToken.Kind == SyntaxKind.AmpersandToken
                && Current.Kind == SyntaxKind.QuestionToken)
            {
                operand = MaybeParseConditionalRefArgumentTail(operand, operatorToken);
            }

            left = new UnaryExpressionSyntax(syntaxTree, operatorToken, operand);
        }
        else if (Current.Kind == SyntaxKind.AwaitKeyword)
        {
            // Phase 5.1 / ADR-0023: `await e` is a prefix expression. Bind at
            // the same precedence as the established unary slot so it composes
            // identically with member access and call: `await f()` parses as
            // `await (f())` and `(await x).Member` requires parens.
            var awaitKeyword = NextToken();
            var operand = ParseBinaryExpression(6);
            left = new AwaitExpressionSyntax(syntaxTree, awaitKeyword, operand);
        }
        else
        {
            left = ParsePrimaryExpression();
        }

        // Phase 3.C.3 / ADR-0001 + Issue #518: postfix null-assertion `!!`.
        // `!!` is a true postfix operator that composes with the other primary
        // continuations (`.`, `?.`, `[`). After consuming `!!` we re-enter the
        // postfix chain so subsequent member access / null-conditional access /
        // indexing all hang off the `!!`-wrapped expression — i.e.
        // `dir.Parent!!.Name` parses as `((dir.Parent)!!).Name` (the binder
        // sees an AccessorExpression whose LeftPart is the `!!` UnaryExpression
        // and falls through to the generic `BindExpression(leftPart)` path).
        // Mixing `!!` with `+`, `==`, ternary etc. just falls out of the
        // outer binary loop because `!!` itself has no precedence — it binds
        // tighter than every binary operator, same as before this fix.
        while (Current.Kind == SyntaxKind.BangBangToken)
        {
            var bangBangToken = NextToken();
            left = new UnaryExpressionSyntax(syntaxTree, bangBangToken, left);
            left = ParsePostfixChain(left);
        }

        // ADR-0126 / issue #1027: postfix increment/decrement `x++` / `x--`.
        // A bare `identifier ++` in statement position is intercepted earlier by
        // ParseIncrementDecrementStatement, so this expression form fires for
        // value positions (`var j = i--`, `while i-- > 0`) and complex targets
        // (`a[i]++`, `obj.f--`). Only a single trailing operator is accepted
        // (C# likewise rejects `i++++`).
        if (Current.Kind == SyntaxKind.PlusPlusToken || Current.Kind == SyntaxKind.MinusMinusToken)
        {
            var postfixOp = NextToken();
            left = BuildIncrementDecrementExpression(left, postfixOp, isPrefix: false);
        }

        while (true)
        {
            // ADR-0122 / issue #1014: a `*` that begins a new source line is a
            // pointer-dereference statement (`*p = v` / `*p`), not a
            // continuation of the previous expression as multiplication. G#
            // is otherwise newline-insensitive, but a leading-`*` continuation
            // is never written (binary operators are placed at line end), so
            // stopping the binary loop here is safe and lets deref-write
            // statements parse after any preceding expression statement.
            if (Current.Kind == SyntaxKind.StarToken && IsCurrentOnNewLineAfter(left))
            {
                break;
            }

            var precedence = Current.Kind.GetBinaryOperatorPrecedence();
            if (precedence == 0 || precedence <= parentPrecedence)
            {
                // Issue #575: expression-level `is`/`as` operators bind at the
                // relational tier (precedence 3, same as <, <=, >, >=). They have
                // a Type RHS instead of an Expression RHS, so they're parsed
                // separately from the standard binary-operator path.
                if (parentPrecedence < 3 && (Current.Kind == SyntaxKind.IsKeyword || Current.Kind == SyntaxKind.AsKeyword))
                {
                    var keyword = NextToken();
                    var typeClause = ParseTypeClause();
                    if (keyword.Kind == SyntaxKind.IsKeyword)
                    {
                        left = new IsExpressionSyntax(syntaxTree, left, keyword, typeClause);
                    }
                    else
                    {
                        left = new AsExpressionSyntax(syntaxTree, left, keyword, typeClause);
                    }

                    continue;
                }

                // ADR-0069 / issue #700: `!is` is recognised as the two-token
                // sequence `!` immediately followed by `is`. It lowers to
                // `!(left is T)` — the same bound tree the binder would produce
                // for the parenthesised form — so every downstream pass
                // (classification, narrowing, emit) handles it identically.
                if (parentPrecedence < 3 && Current.Kind == SyntaxKind.BangToken && Peek(1).Kind == SyntaxKind.IsKeyword)
                {
                    var bangToken = NextToken();
                    var isKeyword = NextToken();
                    var typeClause = ParseTypeClause();
                    var inner = new IsExpressionSyntax(syntaxTree, left, isKeyword, typeClause);
                    left = new UnaryExpressionSyntax(syntaxTree, bangToken, inner);
                    continue;
                }

                break;
            }

            var operatorToken = NextToken();
            var right = ParseBinaryExpression(precedence);
            left = new BinaryExpressionSyntax(syntaxTree, left, operatorToken, right);
        }

        if (parentPrecedence == 0)
        {
            while (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "with" && Peek(1).Kind == SyntaxKind.OpenBraceToken)
            {
                var withToken = MatchToken(SyntaxKind.IdentifierToken);
                var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
                var initializers = ParseFieldEqualsInitializers();
                var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
                left = new WithExpressionSyntax(left, withToken, openBrace, initializers, closeBrace);
            }
        }

        return left;
    }

    private ExpressionSyntax ParsePrimaryExpression()
    {
        switch (Current.Kind)
        {
            case SyntaxKind.OpenParenthesisToken:
                // ADR-0074 / issue #714: `(p1 T1, p2 T2) -> body` is a lambda
                // expression. Disambiguated by bounded look-ahead — see
                // LooksLikeLambdaStart — so a parenthesised expression or
                // tuple literal that is not followed by `->` continues to
                // parse via the existing path.
                if (LooksLikeLambdaStart())
                {
                    return ParseLambdaExpression();
                }

                return ParsePostfixChain(ParseParenthesizedExpression());

            case SyntaxKind.FalseKeyword:
            case SyntaxKind.TrueKeyword:
                return ParsePostfixChain(ParseBooleanLiteral());

            case SyntaxKind.NilKeyword:
                return ParsePostfixChain(ParseNilLiteral());

            // ADR-0054: postfix member/index access does NOT apply directly to a
            // numeric literal (collides with float-literal lexing, e.g. `42.x`).
            // Users write `(42).Member` instead.
            case SyntaxKind.NumberToken:
                return ParseNumberLiteral();

            case SyntaxKind.CharacterToken:
                return ParsePostfixChain(ParseCharacterLiteral());

            case SyntaxKind.StringToken:
                return ParsePostfixChain(ParseStringLiteral());

            case SyntaxKind.InterpolatedStringToken:
                return ParsePostfixChain(ParseInterpolatedStringLiteral());

            case SyntaxKind.OpenSquareBracketToken:
                return ParsePostfixChain(ParseArrayCreationExpression());

            case SyntaxKind.MapKeyword:
                return ParsePostfixChain(ParseMapCreationExpression());

            case SyntaxKind.FuncKeyword:
                return ParsePostfixChain(ParseFunctionLiteralExpression());

            case SyntaxKind.AsyncKeyword when Peek(1).Kind == SyntaxKind.FuncKeyword:
                return ParsePostfixChain(ParseFunctionLiteralExpression());

            case SyntaxKind.AsyncKeyword when LooksLikeLambdaStart(startOffset: 1):
                // ADR-0076 / issue #716: `async (...) -> body` is an async
                // arrow lambda. The parser commits when the post-`async`
                // tokens match a lambda shape.
                return ParseLambdaExpression();

            case SyntaxKind.IdentifierToken when Peek(1).Kind == SyntaxKind.RightArrowToken && this.unsafeDepth == 0:
                // Issue #932: a single-identifier arrow lambda `x -> body` is
                // accepted as shorthand for the parenthesised single-parameter
                // form `(x) -> body`. Disambiguation is unconditional here: in
                // an expression position `IDENT ->` cannot begin any other
                // construct (function-type clauses `(T) -> R` and the
                // deprecated switch-arm `case v -> r` are parsed in their own
                // type/pattern contexts, never via primary-expression
                // dispatch), so committing to a lambda is always correct.
                //
                // ADR-0122 §4 / issue #1034: EXCEPT inside an unsafe context,
                // where `p->member` is pointer member access `(*p).member`. The
                // `unsafeDepth == 0` guard routes `IDENT ->` to the lambda only
                // outside unsafe code; inside unsafe it falls through to the
                // name/postfix path which desugars `->` to a dereference member
                // access. A single-identifier lambda is still expressible inside
                // unsafe code via the parenthesised form `(x) -> body`.
                return ParseSingleIdentifierLambdaExpression();

            case SyntaxKind.SwitchKeyword:
                return ParsePostfixChain(ParseSwitchExpression());

            case SyntaxKind.IfKeyword:
                return ParsePostfixChain(ParseIfExpression());

            case SyntaxKind.ThrowKeyword:
                // Issue #1018: throw-expression in value position
                // (`x ?? throw e`, `cond ? a : throw e`, `return throw e`,
                // arrow bodies, arguments). A `throw` at statement start is
                // intercepted earlier by ParseStatement → ParseThrowStatement,
                // so reaching here always means an expression context.
                return ParseThrowExpression();

            case SyntaxKind.IdentifierToken
                when Current.Text == "stackalloc"
                     && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken:
                // ADR-0124 / issues #1024, #1057: `stackalloc [n]T` is a
                // stack-allocation expression in G#-style array grammar (the
                // bracketed count first, then the element type). `stackalloc`
                // is a contextual keyword recognised only in the precise
                // `stackalloc [` shape, so any existing identifier named
                // `stackalloc` in any other position continues to lex as a
                // plain identifier.
                return ParsePostfixChain(ParseStackAllocExpression());

            case SyntaxKind.IdentifierToken
                when Current.Text == "base" && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken:
                // ADR-0091 / issue #757: explicit-base interface call
                // `base[IFoo].M(args)`. `base` is recognized as a contextual
                // keyword only when followed by `[`; every other position
                // continues to lex it as a plain identifier (so existing
                // shapes like `init(x) : base(x)` and `var base = 5` are
                // unaffected).
                return ParsePostfixChain(ParseBaseInterfaceCallExpression());

            case SyntaxKind.DefaultKeyword:
                // ADR-0100 / issue #795: `default(T)` and bare `default`
                // expressions. The arm-leading `default` of a switch/select
                // case is matched earlier in ParseSwitchCase /
                // ParseSelectCase / ParseSwitchExpressionArm before reaching
                // primary-expression dispatch, so by the time we land here
                // the keyword is in a value position.
                return ParsePostfixChain(ParseDefaultExpression());

            case SyntaxKind.IdentifierToken:
            default:
                return ParseNameOrCallExpression();
        }
    }

    // ADR-0054: chains postfix member access (`.` / `?.`) and indexing
    // (`[]` / `?[]`) onto an already-parsed primary expression. Used by both
    // the name/call path and the other primary-expression cases so accessors
    // work uniformly on parenthesized expressions, literals, and other primaries.
    // ADR-0073 / issue #710: the `?[` token is the prefix of a null-conditional
    // index access and is treated symmetrically to `[`, with the resulting
    // IndexExpressionSyntax carrying IsNullConditional = true.
    private ExpressionSyntax ParsePostfixChain(ExpressionSyntax current)
    {
        while (true)
        {
            if (Current.Kind == SyntaxKind.DotToken || Current.Kind == SyntaxKind.QuestionDotToken)
            {
                var dotToken = NextToken();
                var rightSide = ParseNameOrCallExpression();
                current = new AccessorExpressionSyntax(syntaxTree, current, dotToken, rightSide);
            }
            else if (Current.Kind == SyntaxKind.RightArrowToken)
            {
                // ADR-0122 §4 / issue #1034: the pointer member-access arrow
                // `p->m` is sugar for `(*p).m`. Desugar at parse time into a
                // dereference (`*p`) accessed by a member name, so the binder and
                // emitter reuse the existing `(*p).field` / `(*p).method(...)`
                // bound shape without any new bound-node kinds.
                var arrowToken = NextToken();
                var rightSide = ParseNameOrCallExpression();
                var starToken = new SyntaxToken(syntaxTree, SyntaxKind.StarToken, arrowToken.Position, "*", null);
                var deref = new UnaryExpressionSyntax(syntaxTree, starToken, current);
                current = new AccessorExpressionSyntax(syntaxTree, deref, arrowToken, rightSide);
            }
            else if (Current.Kind == SyntaxKind.OpenSquareBracketToken
                || Current.Kind == SyntaxKind.QuestionOpenBracketToken)
            {
                var openBracket = NextToken();

                // Issue #522: an indexer is a fresh inner expression context.
                var savedSuppress = suppressTrailingObjectInitializer;
                suppressTrailingObjectInitializer = 0;
                ExpressionSyntax index;
                try
                {
                    index = ParseIndexArgument();
                }
                finally
                {
                    suppressTrailingObjectInitializer = savedSuppress;
                }

                var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
                current = new IndexExpressionSyntax(syntaxTree, current, openBracket, index, closeBracket);
            }
            else
            {
                break;
            }
        }

        return current;
    }

    // Issue #1016: parse the argument of an index expression, allowing a
    // range/slice operand (`lo..hi`, `..hi`, `lo..`, `..`) in addition to an
    // ordinary single index. The `..` token is only meaningful in this
    // position, so range parsing is scoped here rather than to the general
    // expression grammar (keeping `.` member-access and float literals
    // unambiguous everywhere else).
    private ExpressionSyntax ParseIndexArgument()
    {
        ExpressionSyntax lower = null;
        if (Current.Kind != SyntaxKind.DotDotToken
            && Current.Kind != SyntaxKind.CloseSquareBracketToken)
        {
            lower = ParseIndexBound();
        }

        if (Current.Kind != SyntaxKind.DotDotToken)
        {
            // No `..` — an ordinary index. `lower` is necessarily non-null here
            // (an empty `[]` falls through to MatchToken's error recovery).
            return lower ?? ParseExpression();
        }

        var dotDotToken = NextToken();

        ExpressionSyntax upper = null;
        if (Current.Kind != SyntaxKind.CloseSquareBracketToken
            && Current.Kind != SyntaxKind.DotDotToken)
        {
            upper = ParseIndexBound();
        }

        return new RangeExpressionSyntax(syntaxTree, lower, dotDotToken, upper);
    }

    // Issue #1022: parse a single index/range bound, recognising a leading `^`
    // as the C# "from-end" index marker (`a[^1]`, `a[1..^1]`) rather than the
    // one's-complement unary operator. The disambiguation is intentionally
    // scoped to this leading position: a `^` anywhere else (including inside the
    // offset expression itself, e.g. `a[^(x ^ y)]`) keeps its ordinary
    // one's-complement / bitwise-XOR meaning.
    //
    // Issue #1038: the bound is parsed with the standalone range layer
    // suppressed, so the `..` between bounds (and the trailing `..` of `a[^2..]`)
    // is owned by <see cref="ParseIndexArgument"/> rather than being absorbed
    // into the bound's own expression. A parenthesised or argument-position
    // range nested inside the bound re-enables the layer at its grouping
    // boundary (`a[(1..3)]`).
    private ExpressionSyntax ParseIndexBound()
    {
        suppressRangeOperator++;
        try
        {
            if (Current.Kind == SyntaxKind.HatToken)
            {
                var hatToken = NextToken();
                var operand = ParseExpression();
                return new FromEndIndexExpressionSyntax(syntaxTree, hatToken, operand);
            }

            return ParseExpression();
        }
        finally
        {
            suppressRangeOperator--;
        }
    }

    // be reused as the LHS of an indexer assignment. Returns true and yields a
    // canonical `IndexExpression(<receiver-chain>, [k])` when the expression's
    // rightmost primary is an index access; returns false otherwise.
    //
    // Shapes handled (rebuilt accessor chain shown after `=>`):
    //   IndexExpression(t, [k])                                 => itself
    //   AccessorExpression(L, ., IndexExpression(t, [k]))       => IndexExpression(AccessorExpression(L, ., t), [k])
    //   AccessorExpression(L, ., AccessorExpression(M, ., IndexExpression(t, [k])))
    //                                                            => IndexExpression(AccessorExpression(L, ., AccessorExpression(M, ., t)), [k])
    //
    // Issue #507 follow-up: null-conditional accessors (`?.`) are lifted too
    // so `obj.A?.B[k] = v` becomes a valid LHS. The binder
    // (BindMemberIndexAssignmentExpression) splits the receiver chain at the
    // leftmost `?.` and emits a null-conditional write that no-ops when the
    // captured intermediate is `nil`.
    private bool TryLiftTrailingIndexer(ExpressionSyntax expression, out IndexExpressionSyntax canonical)
    {
        if (expression is IndexExpressionSyntax direct)
        {
            canonical = direct;
            return true;
        }

        if (expression is AccessorExpressionSyntax accessor
            && TryLiftTrailingIndexer(accessor.RightPart, out var inner))
        {
            var rebuiltReceiver = new AccessorExpressionSyntax(
                syntaxTree,
                accessor.LeftPart,
                accessor.DotToken,
                inner.Target);
            canonical = new IndexExpressionSyntax(
                syntaxTree,
                rebuiltReceiver,
                inner.OpenBracketToken,
                inner.Index,
                inner.CloseBracketToken);
            return true;
        }

        canonical = null;
        return false;
    }

    /// <summary>
    /// Issue #648: decomposes an <see cref="AccessorExpressionSyntax"/> whose
    /// trailing segment is a plain <see cref="NameExpressionSyntax"/> into the
    /// receiver chain, the dot token, and the terminal field identifier. Used to
    /// parse chained member-access assignment (<c>a.B.C = v</c>).
    /// </summary>
    /// <remarks>
    /// The accessor tree right-nests: <c>a.B.C</c> parses as
    /// <c>Accessor(a, ., Accessor(B, ., C))</c>. This method recursively peels
    /// the last <see cref="NameExpressionSyntax"/> off the deepest right-hand
    /// side and rebuilds the remaining chain as the receiver.
    /// </remarks>
    private bool TryLiftTrailingMemberAccess(
        ExpressionSyntax expression,
        out ExpressionSyntax receiver,
        out SyntaxToken dotToken,
        out SyntaxToken fieldIdentifier)
    {
        if (expression is AccessorExpressionSyntax accessor)
        {
            if (accessor.RightPart is NameExpressionSyntax name)
            {
                receiver = accessor.LeftPart;
                dotToken = accessor.DotToken;
                fieldIdentifier = name.IdentifierToken;
                return true;
            }

            if (accessor.RightPart is AccessorExpressionSyntax
                && TryLiftTrailingMemberAccess(accessor.RightPart, out var innerReceiver, out dotToken, out fieldIdentifier))
            {
                receiver = new AccessorExpressionSyntax(
                    syntaxTree,
                    accessor.LeftPart,
                    accessor.DotToken,
                    innerReceiver);
                return true;
            }
        }

        receiver = null;
        dotToken = default;
        fieldIdentifier = default;
        return false;
    }

    private ExpressionSyntax ParseFunctionLiteralExpression()
    {
        // Phase 4.7 + 5.1: function literal `[async] func(p1 T1, p2 T2) R { body }`.
        SyntaxToken asyncModifier = null;
        if (Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
        {
            asyncModifier = NextToken();
        }

        var funcKeyword = MatchToken(SyntaxKind.FuncKeyword);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseParameterList();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var returnType = ParseOptionalTypeClause();
        var body = ParseBlockStatement();
        return new FunctionLiteralExpressionSyntax(syntaxTree, asyncModifier, funcKeyword, openParen, parameters, closeParen, returnType, body);
    }

    // ADR-0074 / issue #714: bounded look-ahead for a lambda expression
    // starting at a `(`. Returns true if the token stream looks like
    // `() -> …`, `(ident type, …) -> …`, or (ADR-0076 / issue #716)
    // `(ident, …) -> …` (untyped — the binder fills the types from the
    // target). The disambiguator commits to a lambda whenever the matching
    // `)` is followed by `->` AND the interior either is empty or starts
    // with a parameter-name identifier; the lone trailing `->` after `)`
    // is unambiguously a lambda operator (it cannot be a binary expression
    // operator outside switch-arm position).
    //
    // ADR-0076 / issue #716: a leading `async` keyword is recognised by
    // the dispatcher in <see cref="ParsePrimaryExpression"/> as
    // `AsyncKeyword + OpenParenthesisToken + LooksLikeLambdaStart(offset:1)`,
    // so this helper takes an optional <paramref name="startOffset"/>.
    private bool LooksLikeLambdaStart(int startOffset = 0)
    {
        if (Peek(startOffset).Kind != SyntaxKind.OpenParenthesisToken)
        {
            return false;
        }

        // Walk forward counting nested grouping tokens until we find the
        // matching `)` for the opening `(`. Bail out if we cannot match.
        var parenDepth = 1;
        var bracketDepth = 0;
        var braceDepth = 0;
        var offset = startOffset + 1;
        const int maxScan = 4096;
        while (offset - startOffset < maxScan)
        {
            var k = Peek(offset).Kind;
            if (k == SyntaxKind.EndOfFileToken)
            {
                return false;
            }

            if (k == SyntaxKind.OpenParenthesisToken)
            {
                parenDepth++;
            }
            else if (k == SyntaxKind.CloseParenthesisToken)
            {
                if (bracketDepth == 0 && braceDepth == 0)
                {
                    parenDepth--;
                    if (parenDepth == 0)
                    {
                        break;
                    }
                }
                else
                {
                    parenDepth--;
                }
            }
            else if (k == SyntaxKind.OpenSquareBracketToken)
            {
                bracketDepth++;
            }
            else if (k == SyntaxKind.CloseSquareBracketToken)
            {
                if (bracketDepth > 0)
                {
                    bracketDepth--;
                }
            }
            else if (k == SyntaxKind.OpenBraceToken)
            {
                braceDepth++;
            }
            else if (k == SyntaxKind.CloseBraceToken)
            {
                if (braceDepth > 0)
                {
                    braceDepth--;
                }
            }

            offset++;
        }

        if (parenDepth != 0)
        {
            return false;
        }

        // Peek(offset) is the closing `)`. The lambda commit requires `->` to
        // immediately follow at the next non-trivia token slot.
        if (Peek(offset + 1).Kind != SyntaxKind.RightArrowToken)
        {
            return false;
        }

        // Empty parameter list `()`: definitively a zero-param lambda.
        if (offset == startOffset + 1)
        {
            return true;
        }

        // Non-empty parameter list: the first interior token must look like a
        // parameter — i.e. an identifier (possibly preceded by `@` annotations
        // or the contextual `scoped`/`ref`/`out`/`in` modifiers used by
        // ParseParameter). ADR-0076 / issue #716: the type clause is OPTIONAL
        // on a lambda parameter, so the token AFTER the identifier may be
        // `,`, `)`, `=`, or anything else — the matching `)` is already
        // known to be followed by `->`, so the parse is unambiguously a
        // lambda once we see an identifier-shaped first slot.
        var j = startOffset + 1;

        // Optional `@Annot[(args)]` annotations before the first parameter.
        while (Peek(j).Kind == SyntaxKind.AtToken)
        {
            j++;
            if (Peek(j).Kind == SyntaxKind.IdentifierToken)
            {
                j++;
                while (Peek(j).Kind == SyntaxKind.DotToken && Peek(j + 1).Kind == SyntaxKind.IdentifierToken)
                {
                    j += 2;
                }

                if (Peek(j).Kind == SyntaxKind.OpenParenthesisToken)
                {
                    var innerDepth = 1;
                    j++;
                    while (j < offset && innerDepth > 0)
                    {
                        var kk = Peek(j).Kind;
                        if (kk == SyntaxKind.OpenParenthesisToken)
                        {
                            innerDepth++;
                        }
                        else if (kk == SyntaxKind.CloseParenthesisToken)
                        {
                            innerDepth--;
                        }

                        j++;
                    }
                }
            }
        }

        // Optional `scoped` / `ref` / `out` / `in` contextual modifier.
        if (Peek(j).Kind == SyntaxKind.IdentifierToken
            && (Peek(j).Text == "scoped" || Peek(j).Text == "ref" || Peek(j).Text == "out" || Peek(j).Text == "in")
            && Peek(j + 1).Kind == SyntaxKind.IdentifierToken)
        {
            j++;
        }

        // The first parameter slot must be an identifier (the parameter name).
        // Anything else (e.g. `(42)`, `(x + y)`) is treated as a parenthesized
        // expression / tuple even though `->` follows — the parser surfaces a
        // better diagnostic from the expression path than from the parameter
        // path.
        if (Peek(j).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        return true;
    }

    private LambdaExpressionSyntax ParseLambdaExpression()
    {
        // ADR-0074 / issue #714: `(p1 T1, p2 T2) -> body` lambda expression.
        // The opening `(` is required; an empty parameter list is permitted.
        // ADR-0076 / issue #716: an optional leading `async` modifier marks
        // an async arrow lambda, and parameter type clauses are optional
        // when a target type is available to infer them (the binder reports
        // GS0304 when no target type is in scope).
        SyntaxToken asyncModifier = null;
        if (Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            asyncModifier = NextToken();
        }

        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseLambdaParameterList();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var arrow = MatchToken(SyntaxKind.RightArrowToken);
        var body = Current.Kind == SyntaxKind.OpenBraceToken
            ? ParseBlockExpression()
            : ParseExpression();
        return new LambdaExpressionSyntax(syntaxTree, asyncModifier, openParen, parameters, closeParen, arrow, body);
    }

    // Issue #932: parses the single-identifier arrow-lambda shorthand
    // `x -> body`, equivalent to the parenthesised `(x) -> body`. The opening
    // and closing parentheses are absent (the corresponding tokens are left
    // null and are skipped by SyntaxNode child enumeration / span computation),
    // and the sole parameter carries no type clause, so the binder infers its
    // type from the target delegate exactly as it does for `(x) -> body` (or
    // reports GS0304 when no target type is in scope).
    private LambdaExpressionSyntax ParseSingleIdentifierLambdaExpression()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var parameter = new ParameterSyntax(syntaxTree, identifier, ellipsisToken: null, type: null);
        var parameters = new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray.Create<SyntaxNode>(parameter));
        var arrow = MatchToken(SyntaxKind.RightArrowToken);
        var body = Current.Kind == SyntaxKind.OpenBraceToken
            ? ParseBlockExpression()
            : ParseExpression();
        return new LambdaExpressionSyntax(syntaxTree, asyncModifier: null, openParenToken: null, parameters, closeParenToken: null, arrow, body);
    }

    // ADR-0076 / issue #716: arrow-lambda parameter lists allow each parameter's
    // type clause to be omitted (`(x) -> body` / `(x, y) -> body`). When the
    // binding supplies a target function type, the binder infers each missing
    // parameter type from the target. Otherwise, GS0304 fires. Parameter
    // default values and annotations remain supported by delegating to the
    // shared ParseLambdaParameter helper.
    private SeparatedSyntaxList<ParameterSyntax> ParseLambdaParameterList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNextParameter = true;
        while (parseNextParameter &&
               Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var parameter = ParseLambdaParameter();
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

    // ADR-0076 / issue #716: a lambda parameter is structurally identical to
    // an ordinary parameter except that the type clause is optional. When the
    // type clause is absent (e.g. the parameter is `(x)`), the binder relies
    // on the target type to fill it in; with no target type, GS0304 fires.
    private ParameterSyntax ParseLambdaParameter()
    {
        // ADR-0047: parameter-level annotations precede the identifier.
        var annotations = ParseAnnotations();

        // ADR-0058 / issue #376: optional `scoped` contextual modifier.
        SyntaxToken scopedModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "scoped"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            scopedModifier = NextToken();
        }

        // ADR-0060: optional `ref`/`out`/`in` contextual modifier.
        SyntaxToken refKindModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken
            && (Current.Text == "ref" || Current.Text == "out" || Current.Text == "in")
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            refKindModifier = NextToken();
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken ellipsis = null;
        if (Current.Kind == SyntaxKind.EllipsisToken)
        {
            ellipsis = MatchToken(SyntaxKind.EllipsisToken);
        }

        // ADR-0076 / issue #716: the type clause is OPTIONAL on a lambda
        // parameter; with no type, the binder uses the target type's
        // corresponding slot, or reports GS0304 when no target is in scope.
        var type = ParseOptionalTypeClause();

        // ADR-0063: optional default-value clause.
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

    private ExpressionSyntax ParseSwitchExpression()
    {
        var switchKeyword = MatchToken(SyntaxKind.SwitchKeyword);
        var expression = ParseExpressionInBodyHeader();
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        var arms = ImmutableArray.CreateBuilder<SwitchExpressionArmSyntax>();
        while (Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;
            arms.Add(ParseSwitchExpressionArm());

            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new SwitchExpressionSyntax(syntaxTree, switchKeyword, expression, openBrace, arms.ToImmutable(), closeBrace);
    }

    private SwitchExpressionArmSyntax ParseSwitchExpressionArm()
    {
        if (Current.Kind == SyntaxKind.DefaultKeyword)
        {
            var defaultKeyword = MatchToken(SyntaxKind.DefaultKeyword);
            var defaultArrow = MatchSwitchExpressionArmSeparator();
            var defaultResult = ParseExpression();
            return new SwitchExpressionArmSyntax(syntaxTree, defaultKeyword, value: null, whenKeyword: null, guard: null, defaultArrow, defaultResult);
        }

        var caseKeyword = MatchToken(SyntaxKind.CaseKeyword);
        var value = ParsePattern();
        var (whenKeyword, guard) = ParseOptionalWhenGuard();
        var arrow = MatchSwitchExpressionArmSeparator();
        var result = ParseExpression();
        return new SwitchExpressionArmSyntax(syntaxTree, caseKeyword, value, whenKeyword, guard, arrow, result);
    }

    // ADR-0074 / issue #714: switch-expression arms accept either `:` (new) or
    // `->` (deprecated). On `->` the parser records GS0302 and continues —
    // both forms produce the same SwitchExpressionArmSyntax node and the
    // separator token's Kind tells callers which form was used.
    private SyntaxToken MatchSwitchExpressionArmSeparator()
    {
        if (Current.Kind == SyntaxKind.ColonToken)
        {
            return MatchToken(SyntaxKind.ColonToken);
        }

        if (Current.Kind == SyntaxKind.RightArrowToken)
        {
            var arrow = MatchToken(SyntaxKind.RightArrowToken);
            Diagnostics.ReportSwitchExpressionArmArrowDeprecated(arrow.Location);
            return arrow;
        }

        return MatchToken(SyntaxKind.ColonToken);
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

    private SeparatedSyntaxList<MapEntrySyntax> ParseMapEntries()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var key = ParseExpression();
            var colon = MatchToken(SyntaxKind.ColonToken);
            var value = ParseExpression();
            nodesAndSeparators.Add(new MapEntrySyntax(syntaxTree, key, colon, value));

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<MapEntrySyntax>(nodesAndSeparators.ToImmutable());
    }

    private ExpressionSyntax ParseArrayCreationExpression()
    {
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        SyntaxToken length = null;
        if (Current.Kind != SyntaxKind.CloseSquareBracketToken)
        {
            length = MatchToken(SyntaxKind.NumberToken);
        }

        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);

        // Issue #1046: a jagged-array literal whose element is itself a
        // non-identifier type clause (`[][]int32{ … }`, `[]*int32{ … }`, …).
        // Parse the element recursively when the token after `]` does not begin
        // a plain identifier element; otherwise keep the flat identifier form.
        if (Current.Kind != SyntaxKind.IdentifierToken)
        {
            var nestedElementType = ParseTypeClause();
            var nestedOpenBrace = MatchToken(SyntaxKind.OpenBraceToken);
            var nestedElements = ParseArrayInitializerElements();
            var nestedCloseBrace = MatchToken(SyntaxKind.CloseBraceToken);
            return new ArrayCreationExpressionSyntax(
                syntaxTree,
                openBracket,
                length,
                closeBracket,
                nestedElementType,
                nestedOpenBrace,
                nestedElements,
                nestedCloseBrace);
        }

        var elementType = MatchToken(SyntaxKind.IdentifierToken);
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var elements = ParseArrayInitializerElements();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new ArrayCreationExpressionSyntax(
            syntaxTree,
            openBracket,
            length,
            closeBracket,
            elementType,
            openBrace,
            elements,
            closeBrace);
    }

    // ADR-0124 / issues #1024, #1057, #1041: parses a stack-allocation
    // expression in G#-style array grammar `stackalloc [n]T` (bracketed count
    // first, then the element type). The leading `stackalloc` is a contextual
    // keyword and the dispatcher in ParsePrimaryExpression only routes here for
    // the exact `stackalloc [` shape. The count is a full expression (so a
    // runtime length such as `stackalloc [count]uint8` is accepted, mirroring
    // the runtime-length array form). An optional brace-delimited initializer
    // (`stackalloc [n]T{ … }`) supplies the element values; the count-inferred
    // shape (`stackalloc []T{ … }`, empty brackets) takes the count from the
    // initializer length (issue #1041).
    private ExpressionSyntax ParseStackAllocExpression()
    {
        var stackAllocKeyword = MatchToken(SyntaxKind.IdentifierToken);
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);

        // The count is optional: the `stackalloc []T{ … }` shape infers it from
        // the initializer length, so an immediate `]` leaves CountExpression null.
        ExpressionSyntax count = null;
        if (Current.Kind != SyntaxKind.CloseSquareBracketToken)
        {
            count = ParseExpression();
        }

        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        var elementType = MatchToken(SyntaxKind.IdentifierToken);

        // The brace-delimited initializer is optional for the count-only form
        // (`stackalloc [n]T`) and required for the count-inferred form
        // (`stackalloc []T{ … }`); the binder enforces that requirement.
        SyntaxToken openBrace = null;
        SeparatedSyntaxList<ExpressionSyntax> elements = null;
        SyntaxToken closeBrace = null;
        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            elements = ParseArrayInitializerElements();
            closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        }

        return new StackAllocExpressionSyntax(
            syntaxTree,
            stackAllocKeyword,
            openBracket,
            count,
            closeBracket,
            elementType,
            openBrace,
            elements,
            closeBrace);
    }

    // ADR-0125 / issue #1026: `fixed name *T = source { … }`. The leading
    // `fixed` is a contextual keyword; the dispatcher in ParseStatement only
    // routes here for the exact `fixed IDENT *` shape. The header mirrors G#'s
    // other paren-less statement headers (`if`/`for`/`while`/`unsafe { }`).
    private StatementSyntax ParseFixedStatement()
    {
        var fixedKeyword = MatchToken(SyntaxKind.IdentifierToken);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeClause = ParseTypeClause();
        var equalsToken = MatchToken(SyntaxKind.EqualsToken);

        // Suppress bare struct literals (`Ident { }`) and trailing object
        // initializers so the `{` after the source expression is parsed as the
        // pinned body block, not as part of the source — mirroring the
        // `if let` / `for` header treatment.
        suppressTrailingObjectInitializer++;
        suppressStructLiteral++;
        ExpressionSyntax pinnedSource;
        try
        {
            pinnedSource = ParseExpression();
        }
        finally
        {
            suppressStructLiteral--;
            suppressTrailingObjectInitializer--;
        }

        var body = ParseBlockStatement();
        return new FixedStatementSyntax(
            syntaxTree,
            fixedKeyword,
            identifier,
            typeClause,
            equalsToken,
            pinnedSource,
            body);
    }

    private SeparatedSyntaxList<ExpressionSyntax> ParseArrayInitializerElements()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseExpression());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable());
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

    private ExpressionSyntax ParseNameOrCallExpression()
    {
        ExpressionSyntax current;
        if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "make"
            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken
            && Peek(2).Kind == SyntaxKind.ChanKeyword)
        {
            // Phase 5.4 / ADR-0022: contextual `make(chan T)` / `make(chan T, capacity)`.
            current = ParseMakeChannelExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "typeof"
            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            // Issue #143: contextual `typeof(T)` — argument is a type clause.
            current = ParseTypeOfExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "nameof"
            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            // Issue #143: contextual `nameof(expr)` — argument is a name reference.
            current = ParseNameOfExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            current = ParseCallExpression();
            current = MaybeWrapWithObjectInitializer(current);
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Peek(1).Kind == SyntaxKind.QuestionToken
            && Peek(2).Kind == SyntaxKind.OpenParenthesisToken)
        {
            // Issue #663: `string?(expr)` — nullable-type conversion call.
            current = ParseNullableTypeCallExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken
            && LooksLikeGenericCallSite(1))
        {
            current = ParseGenericCallExpression();
            current = MaybeWrapWithObjectInitializer(current);
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Peek(1).Kind == SyntaxKind.OpenBraceToken
            && suppressStructLiteral == 0
            && IsStructLiteralFollowingBrace(2))
        {
            current = ParseStructLiteralExpression();
        }
        else
        {
            current = ParseNameExpression();
        }

        return ParsePostfixChain(current);
    }

    // Phase 4.1 / ADR-0020: bounded-lookahead disambiguation between
    // `name [ expr ]` (indexing) and `name [ TypeClause, ... ] ( args )`
    // (generic instantiation followed by call). `bracketOffset` is the
    // offset of the `[` token relative to Current.
    //
    // The comma-loop below intentionally supports any arity, including the
    // multi-type-arg shape `Dictionary[K, V]()` / `Dictionary[K, V, W]()`,
    // so the parser commits to a generic call site as long as every
    // comma-separated item inside the brackets parses as a type clause
    // (via `TryScanTypeClause`) and the token after the matching `]` is
    // one of the ADR-0020 follow-set markers (`(`, `{`, `.`). Regression
    // coverage lives in test/Core.Tests/CodeAnalysis/Syntax/Issue693MultiTypeArgGenericCallParserTests.cs
    // and end-to-end emit coverage in
    // test/Compiler.Tests/Emit/Issue693DictionaryConstructionEmitTests.cs.
    //
    // Issue #942: the `.` follow-set marker is genuinely ambiguous with
    // indexer-then-member access. A single bracketed argument that is also a
    // legal expression (e.g. `xs[i]`, `xs[i].ToString()`) scans as a lone
    // type clause and would otherwise be mis-committed to a generic
    // type-argument list, so the trailing `.Member` mis-binds. An indexer can
    // only ever hold a *single* index expression, never a comma-separated
    // list, so we restrict the `.` follow-set to the unambiguous multi-arg
    // shape (`Pair[int, string].zero`). A single bracketed argument followed
    // by `.` is parsed as an indexer-then-member access, matching the
    // literal-index behaviour (`xs[0].ToString()`). The `(`/`{` markers stay
    // arity-agnostic: `Map[int](xs)` and `List[int]{...}` remain generic
    // instantiations regardless of arity.
    private bool LooksLikeGenericCallSite(int bracketOffset)
    {
        if (Peek(bracketOffset).Kind != SyntaxKind.OpenSquareBracketToken)
        {
            return false;
        }

        var pos = bracketOffset + 1;
        if (Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken)
        {
            return false;
        }

        var typeArgumentCount = 0;
        while (true)
        {
            if (!TryScanTypeClause(ref pos))
            {
                return false;
            }

            typeArgumentCount++;

            if (Peek(pos).Kind == SyntaxKind.CommaToken)
            {
                pos++;
                continue;
            }

            if (Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken)
            {
                pos++;
                break;
            }

            return false;
        }

        // Follow-set per ADR-0020: '(' (call), '{' (composite literal), '.' (member access).
        var nextKind = Peek(pos).Kind;
        if (nextKind == SyntaxKind.OpenParenthesisToken)
        {
            return true;
        }

        if (nextKind == SyntaxKind.OpenBraceToken)
        {
            // Issue #1023: in a statement-header controlling expression
            // (`if`/`while`/`for` clauses, `switch`/`match` subject, …) the
            // trailing `{` opens the statement body, not a composite literal.
            // The same Go-style suppression that blocks `Type { … }` /
            // `Call() { … }` here must also block the generic-composite
            // `name[args] { … }` shape, so an indexer-tailed header such as
            // `for …; s += arr[s] { … }` binds `[s]` as an indexer and lets
            // `{` open the loop body. Nested contexts (parens, brackets,
            // argument lists) clear the counter, so `List[int]{…}` still
            // parses inside those.
            if (suppressTrailingObjectInitializer > 0)
            {
                return false;
            }

            return true;
        }

        // Issue #942: only a multi-type-argument list (which cannot be an
        // indexer) commits to a generic call site on a trailing `.`. A single
        // bracketed argument followed by `.` is an indexer-then-member access.
        return nextKind == SyntaxKind.DotToken && typeArgumentCount > 1;
    }

    private bool TryScanTypeClause(ref int pos)
    {
        // Optional leading bracketed segment: '[' ']' or '[' Number ']' for slice/array shapes.
        if (Peek(pos).Kind == SyntaxKind.OpenSquareBracketToken)
        {
            pos++;
            if (Peek(pos).Kind == SyntaxKind.NumberToken)
            {
                pos++;
            }

            if (Peek(pos).Kind != SyntaxKind.CloseSquareBracketToken)
            {
                return false;
            }

            pos++;
        }

        // ADR-0075: `async (T) -> R` and `func(T) R` start a function-type clause.
        // Handle the optional leading `async` modifier here so the next token
        // is the actual head of the function-type clause.
        if (Peek(pos).Kind == SyntaxKind.AsyncKeyword)
        {
            pos++;
        }

        // ADR-0075: `(T1, T2, ...) -> R` arrow function-type clause, or a
        // tuple-type clause `(T1, T2, ...)`. Both start with '('.
        if (Peek(pos).Kind == SyntaxKind.OpenParenthesisToken)
        {
            pos++;
            if (Peek(pos).Kind != SyntaxKind.CloseParenthesisToken)
            {
                while (true)
                {
                    if (!TryScanTypeClause(ref pos))
                    {
                        return false;
                    }

                    if (Peek(pos).Kind == SyntaxKind.CommaToken)
                    {
                        pos++;
                        continue;
                    }

                    break;
                }
            }

            if (Peek(pos).Kind != SyntaxKind.CloseParenthesisToken)
            {
                return false;
            }

            pos++;

            // If `->` follows, this is an arrow function-type clause; scan the return type.
            if (Peek(pos).Kind == SyntaxKind.RightArrowToken)
            {
                pos++;
                if (!TryScanTypeClause(ref pos))
                {
                    return false;
                }
            }

            // Optional trailing `?` for nullables (tuples and function types both support `?`).
            if (Peek(pos).Kind == SyntaxKind.QuestionToken)
            {
                pos++;
            }

            return true;
        }

        // Phase 4.7: legacy `func(T) R` function-type clause.
        if (Peek(pos).Kind == SyntaxKind.FuncKeyword)
        {
            pos++;
            if (Peek(pos).Kind != SyntaxKind.OpenParenthesisToken)
            {
                return false;
            }

            pos++;
            if (Peek(pos).Kind != SyntaxKind.CloseParenthesisToken)
            {
                while (true)
                {
                    if (!TryScanTypeClause(ref pos))
                    {
                        return false;
                    }

                    if (Peek(pos).Kind == SyntaxKind.CommaToken)
                    {
                        pos++;
                        continue;
                    }

                    break;
                }
            }

            if (Peek(pos).Kind != SyntaxKind.CloseParenthesisToken)
            {
                return false;
            }

            pos++;

            // Optional return type for the legacy func form.
            if (Peek(pos).Kind == SyntaxKind.IdentifierToken
                || Peek(pos).Kind == SyntaxKind.OpenParenthesisToken)
            {
                if (!TryScanTypeClause(ref pos))
                {
                    return false;
                }
            }

            if (Peek(pos).Kind == SyntaxKind.QuestionToken)
            {
                pos++;
            }

            return true;
        }

        if (Peek(pos).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        pos++;

        // Nested type-argument list, e.g. `List[int]`.
        if (Peek(pos).Kind == SyntaxKind.OpenSquareBracketToken)
        {
            pos++;
            while (true)
            {
                if (!TryScanTypeClause(ref pos))
                {
                    return false;
                }

                if (Peek(pos).Kind == SyntaxKind.CommaToken)
                {
                    pos++;
                    continue;
                }

                if (Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken)
                {
                    pos++;
                    break;
                }

                return false;
            }
        }

        // Optional trailing `?` for nullables.
        if (Peek(pos).Kind == SyntaxKind.QuestionToken)
        {
            pos++;
        }

        return true;
    }

    private ExpressionSyntax ParseGenericCallExpression()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeArguments = ParseTypeArgumentList();

        // Phase 4.3 / ADR-0020: a `[…]` type-argument list followed by `{` is a
        // generic struct/class composite literal (`Result[int, string]{...}`).
        // Issue #479 / ADR-0117: the same `Type[args]{…}` shape is a collection
        // initializer (`List[int32]{1, 2, 3}`, `Dictionary[K, V]{"a": 1}`,
        // `Dictionary[K, V]{ ["a"] = 1 }`) when the brace contents are NOT a
        // `Field: value` struct-literal field list. The parser synthesizes an
        // empty-argument constructor call as the initializer's target.
        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            if (BraceLooksLikeGenericCollectionInitializer())
            {
                var ctorCall = SynthesizeEmptyArgConstructorCall(identifier, typeArguments);
                return ParseCollectionInitializerExpression(ctorCall);
            }

            var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            var initializers = ParseStructLiteralInitializers();
            var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
            var literal = new StructLiteralExpressionSyntax(syntaxTree, identifier, openBrace, initializers, closeBrace);
            literal.TypeArgumentList = typeArguments;
            return literal;
        }

        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var arguments = ParseArguments();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        arguments = MaybeAppendTrailingLambda(arguments);
        return new CallExpressionSyntax(syntaxTree, identifier, typeArguments, openParen, arguments, closeParen);
    }

    // Issue #479 / ADR-0117: builds the synthetic zero-argument constructor
    // call that backs the no-parentheses collection-initializer spelling
    // (`List[int32]{…}`). The synthetic parentheses are positioned at the end
    // of the type-argument list so the node's span stays monotonic.
    private CallExpressionSyntax SynthesizeEmptyArgConstructorCall(SyntaxToken identifier, TypeArgumentListSyntax typeArguments)
    {
        var position = typeArguments.CloseBracketToken.Span.End;
        var openParen = new SyntaxToken(syntaxTree, SyntaxKind.OpenParenthesisToken, position, "(", null);
        var closeParen = new SyntaxToken(syntaxTree, SyntaxKind.CloseParenthesisToken, position, ")", null);
        var emptyArguments = new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty);
        return new CallExpressionSyntax(syntaxTree, identifier, typeArguments, openParen, emptyArguments, closeParen);
    }

    // Issue #479 / ADR-0117: in the `Type[args]{…}` generic-composite position
    // the `{` introduces a struct-literal field list when it is empty (all
    // defaults) or its first entry is `Identifier :`. Every other shape — a
    // bare element (`1`), a non-identifier-keyed entry (`"a": 1`), or an
    // indexed entry (`["a"] = 1`) — is a collection initializer.
    private bool BraceLooksLikeGenericCollectionInitializer()
    {
        var k1 = Peek(1).Kind;
        if (k1 == SyntaxKind.CloseBraceToken)
        {
            return false;
        }

        if (k1 == SyntaxKind.OpenSquareBracketToken)
        {
            return true;
        }

        if (k1 == SyntaxKind.IdentifierToken && Peek(2).Kind == SyntaxKind.ColonToken)
        {
            return false;
        }

        return true;
    }

    // Issue #479 / ADR-0117: recognises a collection-initializer `{` after a
    // constructor call (`List[int32](){…}`, `Dictionary[K, V](cmp){…}`). To
    // avoid colliding with a statement body (`foo() { stmt }`) we require an
    // unambiguous collection marker: an indexed-entry `[`, a single literal
    // element, or a top-level `,`/`:` separator inside the braces.
    private bool LooksLikeCollectionInitializerBrace()
    {
        var k1 = Peek(1).Kind;
        if (k1 == SyntaxKind.CloseBraceToken)
        {
            return false;
        }

        if (k1 == SyntaxKind.OpenSquareBracketToken)
        {
            return true;
        }

        if (IsLiteralStartToken(k1) && Peek(2).Kind == SyntaxKind.CloseBraceToken)
        {
            return true;
        }

        var depth = 0;
        for (var i = 1; ; i++)
        {
            var kind = Peek(i).Kind;
            if (kind == SyntaxKind.EndOfFileToken)
            {
                return false;
            }

            if (kind == SyntaxKind.OpenBraceToken
                || kind == SyntaxKind.OpenParenthesisToken
                || kind == SyntaxKind.OpenSquareBracketToken)
            {
                depth++;
            }
            else if (kind == SyntaxKind.CloseParenthesisToken
                || kind == SyntaxKind.CloseSquareBracketToken)
            {
                depth--;
            }
            else if (kind == SyntaxKind.CloseBraceToken)
            {
                if (depth == 0)
                {
                    return false;
                }

                depth--;
            }
            else if (depth == 0 && (kind == SyntaxKind.CommaToken || kind == SyntaxKind.ColonToken))
            {
                return true;
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

    // Issue #479 / ADR-0117: parses the `{ elements }` collection initializer
    // applied to an already-parsed constructor-call target.
    private ExpressionSyntax ParseCollectionInitializerExpression(ExpressionSyntax target)
    {
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var elements = ParseCollectionElements();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new CollectionInitializerExpressionSyntax(syntaxTree, target, openBrace, elements, closeBrace);
    }

    private SeparatedSyntaxList<CollectionElementSyntax> ParseCollectionElements()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext
               && Current.Kind != SyntaxKind.CloseBraceToken
               && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseCollectionElement());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<CollectionElementSyntax>(nodesAndSeparators.ToImmutable());
    }

    private CollectionElementSyntax ParseCollectionElement()
    {
        // Element values live inside the braces — a fresh expression context
        // where trailing object/collection initializers are again allowed.
        var savedSuppress = suppressTrailingObjectInitializer;
        suppressTrailingObjectInitializer = 0;
        try
        {
            // Indexed entry `[key] = value`.
            if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
            {
                var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
                var key = ParseExpression();
                var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
                var equals = MatchToken(SyntaxKind.EqualsToken);
                var value = ParseExpression();
                return new IndexedCollectionElementSyntax(syntaxTree, openBracket, key, closeBracket, equals, value);
            }

            var first = ParseExpression();

            // Key/value entry `key: value`.
            if (Current.Kind == SyntaxKind.ColonToken)
            {
                var colon = MatchToken(SyntaxKind.ColonToken);
                var value = ParseExpression();
                return new KeyedCollectionElementSyntax(syntaxTree, first, colon, value);
            }

            // Bare sequence/set element.
            return new ExpressionCollectionElementSyntax(syntaxTree, first);
        }
        finally
        {
            suppressTrailingObjectInitializer = savedSuppress;
        }
    }

    /// <summary>
    /// ADR-0091 / issue #757: parses an explicit-base interface call
    /// <c>base[IFoo].Method(args)</c>. Commit is decided by the caller in
    /// <see cref="ParsePrimaryExpression"/> when the current identifier is
    /// the contextual <c>base</c> keyword and the next token is <c>[</c>.
    /// The optional generic type-argument list on the method identifier is
    /// parsed but is rejected by the binder in this PR (reserved for a
    /// future explicit-base generic-method extension).
    /// </summary>
    private ExpressionSyntax ParseBaseInterfaceCallExpression()
    {
        // Consume the `base` identifier token. We synthesize a fresh token to
        // make sure the kind stays IdentifierToken (avoiding any keyword
        // re-classification down the line).
        var baseKeyword = MatchToken(SyntaxKind.IdentifierToken);
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var interfaceTypeClause = ParseTypeClause();
        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        var dot = MatchToken(SyntaxKind.DotToken);
        var methodIdentifier = MatchToken(SyntaxKind.IdentifierToken);

        TypeArgumentListSyntax methodTypeArgumentList = null;
        if (Current.Kind == SyntaxKind.OpenSquareBracketToken && LooksLikeGenericCallSite(0))
        {
            methodTypeArgumentList = ParseTypeArgumentList();
        }

        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var arguments = ParseArguments();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new BaseInterfaceCallExpressionSyntax(
            syntaxTree,
            baseKeyword,
            openBracket,
            interfaceTypeClause,
            closeBracket,
            dot,
            methodIdentifier,
            methodTypeArgumentList,
            openParen,
            arguments,
            closeParen);
    }

    private TypeArgumentListSyntax ParseTypeArgumentList()
    {
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
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

        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        return new TypeArgumentListSyntax(syntaxTree, openBracket, new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()), closeBracket);
    }

    private ExpressionSyntax ParseCallExpression()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
        var arguments = ParseArguments();
        var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);
        arguments = MaybeAppendTrailingLambda(arguments);
        return new CallExpressionSyntax(syntaxTree, identifier, openParenthesisToken, arguments, closeParenthesisToken);
    }

    // Issue #663: `string?(expr)` — nullable-type conversion call form.
    // Consumes `Identifier ? ( args )` and builds a CallExpressionSyntax
    // carrying the `?` token so the binder can wrap the resolved type in
    // NullableTypeSymbol.
    private ExpressionSyntax ParseNullableTypeCallExpression()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var questionToken = MatchToken(SyntaxKind.QuestionToken);
        var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
        var arguments = ParseArguments();
        var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);
        arguments = MaybeAppendTrailingLambda(arguments);
        return new CallExpressionSyntax(syntaxTree, identifier, questionToken, typeArgumentList: null, openParenthesisToken, arguments, closeParenthesisToken);
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

    // Recognises an object-initializer `{` after a constructor call. To avoid
    // colliding with statement-bodied constructs of the form `if Cond() { ... }`
    // we require either `{}` (empty) or `{ Identifier =` so a `{ Identifier .`
    // (member access in a body) is not absorbed.
    private bool LooksLikeObjectInitializerBrace()
    {
        var k1 = Peek(1).Kind;
        if (k1 == SyntaxKind.CloseBraceToken)
        {
            return true;
        }

        return k1 == SyntaxKind.IdentifierToken && Peek(2).Kind == SyntaxKind.EqualsToken;
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

    // Parses an expression in a body-header context (the condition of an `if`,
    // the collection of a `for-range`, etc.) — trailing `Call() { ... }`
    // object initializers are suppressed so the following `{` is recognised
    // as the body of the surrounding statement.
    private ExpressionSyntax ParseExpressionInBodyHeader()
    {
        suppressTrailingObjectInitializer++;
        try
        {
            return ParseExpression();
        }
        finally
        {
            suppressTrailingObjectInitializer--;
        }
    }

    private ExpressionSyntax ParseMakeChannelExpression()
    {
        // Phase 5.4 / ADR-0022: `make(chan T)` / `make(chan T, capacity)`.
        var makeIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var channelType = ParseChanTypeClause();
        SyntaxToken comma = null;
        ExpressionSyntax capacity = null;
        if (Current.Kind == SyntaxKind.CommaToken)
        {
            comma = MatchToken(SyntaxKind.CommaToken);
            capacity = ParseExpression();
        }

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new MakeChannelExpressionSyntax(syntaxTree, makeIdentifier, openParen, channelType, comma, capacity, closeParen);
    }

    private ExpressionSyntax ParseTypeOfExpression()
    {
        // Issue #143: `typeof(T)` — the argument is a type clause, not an expression.
        var typeOfIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var typeClause = ParseTypeClause();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new TypeOfExpressionSyntax(syntaxTree, typeOfIdentifier, openParen, typeClause, closeParen);
    }

    private DefaultExpressionSyntax ParseDefaultExpression()
    {
        // ADR-0100 / issue #795: `default(T)` and bare `default` expression.
        // Both shapes start with the `default` keyword. The optional
        // `(TypeClause)` makes the form explicit; the bare form leaves the
        // type to be supplied by the surrounding target-type context
        // (let/var initializer with explicit type, `return`, typed call
        // argument, sibling branch of `?:`). Bare-form bind-time errors
        // are surfaced as GS0362.
        var defaultKeyword = MatchToken(SyntaxKind.DefaultKeyword);
        if (Current.Kind != SyntaxKind.OpenParenthesisToken)
        {
            return new DefaultExpressionSyntax(syntaxTree, defaultKeyword, openParenthesis: null, typeClause: null, closeParenthesis: null);
        }

        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var typeClause = ParseTypeClause();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new DefaultExpressionSyntax(syntaxTree, defaultKeyword, openParen, typeClause, closeParen);
    }

    private ExpressionSyntax ParseNameOfExpression()
    {
        // Issue #143: `nameof(expr)` — the argument is a name reference. We
        // parse it as a general expression; the binder validates that it
        // reduces to a name (identifier / member access / generic name) and
        // emits a diagnostic otherwise.
        var nameOfIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var argument = ParseExpression();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new NameOfExpressionSyntax(syntaxTree, nameOfIdentifier, openParen, argument, closeParen);
    }

    // Phase 4.9: Kotlin-style trailing-lambda call syntax. When a call's
    // closing paren is immediately followed by a `func(...) {...}` literal,
    // the literal is desugared into an additional last positional argument.
    // Useful for DSL-flavoured call sites like `runBlocking() func() { ... }`
    // and `xs.forEach() func(x int) { ... }`. The bare-parens form
    // (`f func(...) {...}` with no `()`) is intentionally out of scope for
    // v0 to keep the call grammar unambiguous with statement-level function
    // literals.
    private SeparatedSyntaxList<ExpressionSyntax> MaybeAppendTrailingLambda(
        SeparatedSyntaxList<ExpressionSyntax> arguments)
    {
        // Only `func(...) {...}` or `async func(...) {...}` (function LITERALS)
        // attach as a trailing lambda; `func Name(...)` (a function DECLARATION)
        // must stay as the following statement-level declaration.
        var isSyncLiteral = Current.Kind == SyntaxKind.FuncKeyword
                            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken;
        var isAsyncLiteral = Current.Kind == SyntaxKind.AsyncKeyword
                             && Peek(1).Kind == SyntaxKind.FuncKeyword
                             && Peek(2).Kind == SyntaxKind.OpenParenthesisToken;
        if (!isSyncLiteral && !isAsyncLiteral)
        {
            return arguments;
        }

        var lambda = ParseFunctionLiteralExpression();
        var existing = arguments.GetWithSeparators();
        var builder = ImmutableArray.CreateBuilder<SyntaxNode>(existing.Length + 2);
        builder.AddRange(existing);
        if (existing.Length > 0 && existing[existing.Length - 1] is not SyntaxToken)
        {
            var syntheticComma = new SyntaxToken(
                syntaxTree,
                SyntaxKind.CommaToken,
                lambda.Span.Start,
                null,
                null);
            builder.Add(syntheticComma);
        }

        builder.Add(lambda);
        return new SeparatedSyntaxList<ExpressionSyntax>(builder.ToImmutable());
    }

    private SeparatedSyntaxList<ExpressionSyntax> ParseArguments()
    {
        // Issue #522: arguments are fresh expression contexts — even when the
        // surrounding statement is a body-header (`if`/`for`/`switch`), a
        // call argument such as `Foo(T() { X = 1 })` should still admit a
        // trailing object initializer.
        var savedSuppress = suppressTrailingObjectInitializer;
        suppressTrailingObjectInitializer = 0;

        // Issue #1038: an argument list is a fresh context, so a standalone
        // range argument (`f(1..3)`) is recognised even inside an index bound.
        var savedRange = suppressRangeOperator;
        suppressRangeOperator = 0;
        try
        {
            return ParseArgumentsCore();
        }
        finally
        {
            suppressTrailingObjectInitializer = savedSuppress;
            suppressRangeOperator = savedRange;
        }
    }

    private SeparatedSyntaxList<ExpressionSyntax> ParseArgumentsCore()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNextArgument = true;
        while (parseNextArgument &&
               Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            ExpressionSyntax expression;
            if (Current.Kind == SyntaxKind.IdentifierToken
                && (Peek(1).Kind == SyntaxKind.EqualsToken || Peek(1).Kind == SyntaxKind.ColonToken))
            {
                var name = MatchToken(SyntaxKind.IdentifierToken);

                // Issue #343: a call-site named argument uses `name: value`.
                // The pre-existing `name = value` form remains accepted for
                // back-compat (used by `.copy(...)` sugar and attribute args).
                // ADR-0080 / issue #720: the `=` form is deprecated and emits
                // a one-release warning (GS0315) before removal.
                SyntaxToken separator;
                if (Current.Kind == SyntaxKind.ColonToken)
                {
                    separator = MatchToken(SyntaxKind.ColonToken);
                }
                else
                {
                    separator = MatchToken(SyntaxKind.EqualsToken);
                    Diagnostics.ReportNamedArgumentEqualsSeparatorDeprecated(separator.Location, name.Text);
                }

                // ADR-0060: a named argument may carry a ref-kind modifier in
                // its value position (e.g. `name = ref x`). V1 rejects this
                // shape at bind time per ADR §4 / §8 (composition with named
                // arguments is a follow-up); the parser still accepts it so
                // the diagnostic carries a precise location.
                ExpressionSyntax value;
                if (TryParseRefArgument(out var refValue))
                {
                    value = refValue;
                }
                else
                {
                    value = ParseExpression();
                }

                expression = new NamedArgumentExpressionSyntax(syntaxTree, name, separator, value);
            }
            else if (TryParseRefArgument(out var refArg))
            {
                expression = refArg;
            }
            else
            {
                expression = ParseExpression();
            }

            nodesAndSeparators.Add(expression);

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                var comma = MatchToken(SyntaxKind.CommaToken);
                nodesAndSeparators.Add(comma);
            }
            else
            {
                parseNextArgument = false;
            }
        }

        return new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable());
    }

    // ADR-0060: at the start of each argument position, recognise the
    // contextual ref-kind modifiers `ref`/`out`/`in` and wrap the payload
    // in a `RefArgumentExpressionSyntax`. Disambiguation rules per ADR §1:
    //   ref/in <ident> | (              -> ref-kind argument
    //   out var <ident>                 -> out inline-var
    //   out let <ident>                 -> out inline-let
    //   out _                           -> out discard
    //   out <ident>                     -> out lvalue
    // Otherwise the identifier `ref`/`out`/`in` is left as a plain expression
    // (e.g. a user-defined parameter actually named `out`).
    private bool TryParseRefArgument(out RefArgumentExpressionSyntax result)
    {
        result = null;
        if (Current.Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        var text = Current.Text;
        if (text != "ref" && text != "out" && text != "in")
        {
            return false;
        }

        var nextKind = Peek(1).Kind;
        var nextText = Peek(1).Text;

        if (text == "out")
        {
            // `out var <ident>`, `out let <ident>`, `out _`, `out <ident>`,
            // or `out (`. Reject the `out` if the next token isn't a legal
            // payload start (so a parameter actually named `out` still binds).
            bool payloadIsDecl = (nextKind == SyntaxKind.VarKeyword || nextKind == SyntaxKind.LetKeyword)
                && Peek(2).Kind == SyntaxKind.IdentifierToken;
            bool payloadIsDiscard = nextKind == SyntaxKind.IdentifierToken && nextText == "_";
            bool payloadIsLvalueStart = nextKind == SyntaxKind.IdentifierToken || nextKind == SyntaxKind.OpenParenthesisToken;

            // ADR-0061: `out` may also be followed by a conditional-ref
            // condition expression — relax the disambiguation for literal
            // keywords and number/unary tokens that can never be an
            // out-parameter target. A `?` later turns these into the
            // conditional form; without `?` the binder reports the standard
            // non-lvalue diagnostic.
            bool payloadIsConditionalConditionStart = nextKind == SyntaxKind.TrueKeyword
                || nextKind == SyntaxKind.FalseKeyword
                || nextKind == SyntaxKind.NumberToken
                || nextKind == SyntaxKind.BangToken
                || nextKind == SyntaxKind.MinusToken;

            // A bare identifier follower could be the parameter name (use `out`).
            // It is treated as `out lvalue` only when the lookahead is unambiguous.
            // We follow the ADR's rule: if the modifier is followed by an
            // identifier (not the named-argument `=` form), recognise it as
            // a ref-kind argument. A trailing `=` (named argument) is already
            // handled above; anything else with an ident lookahead is `out`.
            if (!(payloadIsDecl || payloadIsDiscard || payloadIsLvalueStart || payloadIsConditionalConditionStart))
            {
                return false;
            }

            var outToken = NextToken();
            if (payloadIsDecl)
            {
                var keyword = NextToken();
                var ident = MatchToken(SyntaxKind.IdentifierToken);
                TypeClauseSyntax declType = null;
                if (CurrentTokenStartsTypeClause())
                {
                    declType = ParseTypeClause();
                }

                result = new RefArgumentExpressionSyntax(syntaxTree, outToken, keyword, ident, discardToken: null, declType);
                return true;
            }

            if (payloadIsDiscard)
            {
                var underscore = NextToken();
                TypeClauseSyntax declType = null;
                if (CurrentTokenStartsTypeClause())
                {
                    declType = ParseTypeClause();
                }

                result = new RefArgumentExpressionSyntax(syntaxTree, outToken, declarationKeyword: null, declarationIdentifier: null, discardToken: underscore, declType);
                return true;
            }

            var lvalue = ParseExpression();
            lvalue = MaybeParseConditionalRefArgumentTail(lvalue, outToken);
            result = new RefArgumentExpressionSyntax(syntaxTree, outToken, lvalue);
            return true;
        }

        // `ref` / `in` — legal followers are an identifier (lvalue), a
        // parenthesised lvalue, or (ADR-0061) any token that can start a
        // conditional ref-argument's condition expression — literal keywords,
        // number tokens, or unary operators that combine to form a bool
        // condition. The conditional form requires a `?` later on the line;
        // when one is absent these cases are rejected at bind time as
        // expected ("cannot take address of non-lvalue").
        if (!(nextKind == SyntaxKind.IdentifierToken
              || nextKind == SyntaxKind.OpenParenthesisToken
              || nextKind == SyntaxKind.TrueKeyword
              || nextKind == SyntaxKind.FalseKeyword
              || nextKind == SyntaxKind.NumberToken
              || nextKind == SyntaxKind.BangToken
              || nextKind == SyntaxKind.MinusToken))
        {
            return false;
        }

        var modifier = NextToken();
        var inner = ParseExpression();
        inner = MaybeParseConditionalRefArgumentTail(inner, modifier);
        result = new RefArgumentExpressionSyntax(syntaxTree, modifier, inner);
        return true;
    }

    // ADR-0062: parse a ternary tail `? a : b` starting at the current `?`
    // token, given the already-parsed condition expression. Right-associative.
    // When the inner branches use legacy ADR-0061 inner ref-kind modifiers,
    // returns a ConditionalRefArgumentExpressionSyntax (for back-compat) so
    // the binder can reject mismatches; otherwise returns the general
    // ConditionalExpressionSyntax (ADR-0062).
    private ExpressionSyntax ParseConditionalTail(ExpressionSyntax condition)
    {
        var questionToken = NextToken();
        var whenTrueMod = TryConsumeInnerRefModifier();
        var whenTrue = ParseAssignmentExpression();
        var colonToken = MatchToken(SyntaxKind.ColonToken);
        var whenFalseMod = TryConsumeInnerRefModifier();
        var whenFalse = ParseAssignmentExpression();

        if (whenTrueMod != null || whenFalseMod != null)
        {
            // Legacy ADR-0061 inner-modifier shape: keep producing the
            // dedicated ref-arg node so the binder retains GS0262 etc.
            return new ConditionalRefArgumentExpressionSyntax(
                syntaxTree,
                condition,
                questionToken,
                whenTrueMod,
                whenTrue,
                colonToken,
                whenFalseMod,
                whenFalse);
        }

        return new ConditionalExpressionSyntax(
            syntaxTree,
            condition,
            questionToken,
            whenTrue,
            colonToken,
            whenFalse);
    }

    // ADR-0061 transitional: kept only to avoid touching the few callers
    // that still want the legacy ref-only node when the `?` follows
    // certain ref-context shapes. Forwards to ParseConditionalTail.
    private ExpressionSyntax MaybeParseConditionalRefArgumentTail(ExpressionSyntax condition, SyntaxToken outerModifier)
    {
        if (Current.Kind != SyntaxKind.QuestionToken)
        {
            return condition;
        }

        _ = outerModifier; // bind-time check uses outer modifier; parser only records.
        return ParseConditionalTail(condition);
    }

    // ADR-0061: parse an optional inner `ref`/`in`/`out` modifier on a branch
    // of a conditional ref-argument. Returns the consumed token or null.
    private SyntaxToken TryConsumeInnerRefModifier()
    {
        if (Current.Kind != SyntaxKind.IdentifierToken)
        {
            return null;
        }

        var text = Current.Text;
        if (text != "ref" && text != "in" && text != "out")
        {
            return null;
        }

        var nextKind = Peek(1).Kind;

        // Only treat as a modifier if the next token starts a legal lvalue
        // payload (identifier or `(`). Otherwise leave it as a plain identifier.
        if (!(nextKind == SyntaxKind.IdentifierToken || nextKind == SyntaxKind.OpenParenthesisToken))
        {
            return null;
        }

        return NextToken();
    }

    // Issue #669: parse an if-expression of the form
    // `if cond { expr }`, `if cond { expr } else { expr }`,
    // or `if cond { expr } else if ... { expr } else { expr }`.
    private IfExpressionSyntax ParseIfExpression()
    {
        var ifKeyword = MatchToken(SyntaxKind.IfKeyword);
        suppressTrailingObjectInitializer++;
        suppressStructLiteral++;
        ExpressionSyntax condition;
        try
        {
            condition = ParseExpression();
        }
        finally
        {
            suppressStructLiteral--;
            suppressTrailingObjectInitializer--;
        }

        var thenBlock = ParseBlockExpression();

        SyntaxToken elseKeyword = null;
        ExpressionSyntax elseExpression = null;
        if (Current.Kind == SyntaxKind.ElseKeyword)
        {
            elseKeyword = NextToken();
            if (Current.Kind == SyntaxKind.IfKeyword)
            {
                elseExpression = ParseIfExpression();
            }
            else
            {
                elseExpression = ParseBlockExpression();
            }
        }

        return new IfExpressionSyntax(syntaxTree, ifKeyword, condition, thenBlock, elseKeyword, elseExpression);
    }

    // Issue #669: parse a block expression `{ stmt*; expr? }`.
    // The last item in the block, if it is an expression statement, becomes
    // the trailing value-producing expression of the block.
    private BlockExpressionSyntax ParseBlockExpression()
    {
        var statements = ImmutableArray.CreateBuilder<StatementSyntax>();
        ExpressionSyntax trailingExpression = null;

        var openBraceToken = MatchToken(SyntaxKind.OpenBraceToken);

        while (Current.Kind != SyntaxKind.EndOfFileToken &&
               Current.Kind != SyntaxKind.CloseBraceToken)
        {
            var startToken = Current;

            var statement = ParseBlockExpressionItem();
            statements.Add(statement);

            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBraceToken = MatchToken(SyntaxKind.CloseBraceToken);

        // If the last statement is an expression statement, treat its
        // expression as the block's trailing value-producing expression.
        if (statements.Count > 0 && statements[^1] is ExpressionStatementSyntax exprStmt)
        {
            statements.RemoveAt(statements.Count - 1);
            trailingExpression = exprStmt.Expression;
        }

        return new BlockExpressionSyntax(syntaxTree, openBraceToken, statements.ToImmutable(), trailingExpression, closeBraceToken);
    }

    // Issue #669: parse a single item inside a block expression. This is
    // similar to ParseStatement() but recognizes `if` as potentially
    // an if-expression (when followed by the block-expression shape).
    private StatementSyntax ParseBlockExpressionItem()
    {
        // If the current token is `if` and this could be an if-expression
        // (value-producing), parse it as an expression statement wrapping
        // an IfExpressionSyntax. This handles nested `if` in block position.
        if (Current.Kind == SyntaxKind.IfKeyword && LooksLikeIfExpression())
        {
            var ifExpr = ParseIfExpression();
            return new ExpressionStatementSyntax(syntaxTree, ifExpr);
        }

        return ParseStatement();
    }

    // Issue #669: lookahead to determine if an `if` at the current position
    // looks like an if-expression rather than an if-statement. We check
    // whether `if <expr> {` pattern is followed by a `}` at the same brace
    // depth, and then either by `else` or by the end of the enclosing block.
    // Simple heuristic: an if-expression body is always a brace block
    // (not a bare statement), so `if expr {` is the if-expression shape.
    // If-statements in G# also use `if expr {`, so we disambiguate by
    // context: in a block expression, we always prefer the expression parse.
    private bool LooksLikeIfExpression()
    {
        // In block-expression context, all `if` forms can be treated as
        // expressions. If the if has no else (statement-only form), the binder
        // will reject it with GS0276 when in value position; but in non-value
        // trailing position it would just produce a null trailing expression
        // which the binder handles. We always prefer the expression parse here.
        return true;
    }

    // ADR-0060 helper for the optional `out var name T` / `out let name T` /
    // `out name T` type-clause: returns true when the current token is an
    // identifier that could start a G# type clause (excluding `,` / `)`).
    private bool CurrentTokenStartsTypeClause()
    {
        switch (Current.Kind)
        {
            case SyntaxKind.FuncKeyword:
            case SyntaxKind.OpenParenthesisToken:
            case SyntaxKind.MapKeyword:
            case SyntaxKind.ChanKeyword:
            case SyntaxKind.SequenceKeyword:
            case SyntaxKind.AsyncKeyword:
            case SyntaxKind.StarToken:
            case SyntaxKind.OpenSquareBracketToken:
            case SyntaxKind.IdentifierToken:
                return true;
            default:
                return false;
        }
    }

    private ExpressionSyntax ParseNameExpression()
    {
        var identifierToken = MatchToken(SyntaxKind.IdentifierToken);
        return new NameExpressionSyntax(syntaxTree, identifierToken);
    }

    private bool IsStructLiteralFollowingBrace(int braceOffsetPlusOne)
    {
        // braceOffsetPlusOne is the offset of the token AFTER the '{'. A struct
        // literal is either empty (`}`) or starts with `Identifier :` (a field init).
        var k0 = Peek(braceOffsetPlusOne).Kind;
        if (k0 == SyntaxKind.CloseBraceToken)
        {
            return true;
        }

        if (k0 == SyntaxKind.IdentifierToken && Peek(braceOffsetPlusOne + 1).Kind == SyntaxKind.ColonToken)
        {
            return true;
        }

        return false;
    }

    private ExpressionSyntax ParseStructLiteralExpression()
    {
        var typeIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var initializers = ParseStructLiteralInitializers();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new StructLiteralExpressionSyntax(syntaxTree, typeIdentifier, openBrace, initializers, closeBrace);
    }

    private SeparatedSyntaxList<FieldInitializerSyntax> ParseStructLiteralInitializers()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseFieldInitializer());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<FieldInitializerSyntax>(nodesAndSeparators.ToImmutable());
    }

    private FieldInitializerSyntax ParseFieldInitializer()
    {
        var fieldId = MatchToken(SyntaxKind.IdentifierToken);
        var colon = MatchToken(SyntaxKind.ColonToken);
        var value = ParseExpression();
        return new FieldInitializerSyntax(syntaxTree, fieldId, colon, value);
    }

    private SeparatedSyntaxList<FieldInitializerSyntax> ParseFieldEqualsInitializers()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var fieldId = MatchToken(SyntaxKind.IdentifierToken);
            var equals = MatchToken(SyntaxKind.EqualsToken);
            var value = ParseExpression();
            nodesAndSeparators.Add(new FieldInitializerSyntax(syntaxTree, fieldId, equals, value));
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<FieldInitializerSyntax>(nodesAndSeparators.ToImmutable());
    }

    private ExpressionSyntax ParseParenthesizedExpression()
    {
        var left = MatchToken(SyntaxKind.OpenParenthesisToken);

        // Issue #522: a parenthesised expression is a fresh inner context —
        // even inside an `if (T() { X = 1 }) { body }` style header, the
        // inner call should still admit a trailing object initializer.
        ExpressionSyntax expression;
        var savedSuppress = suppressTrailingObjectInitializer;
        suppressTrailingObjectInitializer = 0;

        // Issue #1038: a parenthesised expression is a fresh context, so a
        // parenthesised range (`a[(1..3)]`) is recognised as a standalone
        // `System.Range` value even inside an index bound.
        var savedRange = suppressRangeOperator;
        suppressRangeOperator = 0;
        try
        {
            expression = ParseExpression();
        }
        finally
        {
            suppressTrailingObjectInitializer = savedSuppress;
            suppressRangeOperator = savedRange;
        }

        // ADR-0061: `(cond ? lvalue : lvalue)` parses as a conditional ref-arg
        // expression when a `?` immediately follows the inner expression. The
        // resulting node is only legal in ref-argument / `&` operand contexts;
        // the binder rejects it otherwise.
        if (Current.Kind == SyntaxKind.QuestionToken)
        {
            expression = MaybeParseConditionalRefArgumentTail(expression, outerModifier: null);
        }

        // Phase 4.5: `(a, b, ...)` is a tuple literal. Detection is purely
        // post-fix: parse the first expression, then if a comma follows we
        // collect the remaining tuple elements; otherwise this is a regular
        // parenthesized expression.
        if (Current.Kind == SyntaxKind.CommaToken)
        {
            var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
            nodesAndSeparators.Add(expression);
            while (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                nodesAndSeparators.Add(ParseExpression());
            }

            var rightParen = MatchToken(SyntaxKind.CloseParenthesisToken);
            return new TupleLiteralExpressionSyntax(
                syntaxTree,
                left,
                new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable()),
                rightParen);
        }

        var right = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new ParenthesizedExpressionSyntax(syntaxTree, left, expression, right);
    }

    private ExpressionSyntax ParseBooleanLiteral()
    {
        var isTrue = Current.Kind == SyntaxKind.TrueKeyword;
        var keywordToken = isTrue ? MatchToken(SyntaxKind.TrueKeyword) : MatchToken(SyntaxKind.FalseKeyword);
        return new LiteralExpressionSyntax(syntaxTree, keywordToken, isTrue);
    }

    private ExpressionSyntax ParseNilLiteral()
    {
        var keywordToken = MatchToken(SyntaxKind.NilKeyword);
        return new LiteralExpressionSyntax(syntaxTree, keywordToken, null);
    }

    private ExpressionSyntax ParseNumberLiteral()
    {
        var numberToken = MatchToken(SyntaxKind.NumberToken);
        return new LiteralExpressionSyntax(syntaxTree, numberToken);
    }

    private ExpressionSyntax ParseCharacterLiteral()
    {
        var charToken = MatchToken(SyntaxKind.CharacterToken);
        return new LiteralExpressionSyntax(syntaxTree, charToken);
    }

    private ExpressionSyntax ParseStringLiteral()
    {
        var stringToken = MatchToken(SyntaxKind.StringToken);
        return new LiteralExpressionSyntax(syntaxTree, stringToken);
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

    // ADR-0055 §C: builds the source text used to parse a hole expression with
    // correct absolute positions. The returned text equals the outer text up to
    // <paramref name="holeOffset"/> — but with every non-newline character
    // blanked to a space so the prefix produces no tokens — followed by the
    // expression source itself. The expression's first character thus lands at
    // its true outer offset, and preserved newlines keep line/column accurate.
    private static string BuildHolePaddedText(SourceText outerText, int holeOffset, string exprText)
    {
        var builder = new System.Text.StringBuilder(holeOffset + exprText.Length);
        for (var i = 0; i < holeOffset; i++)
        {
            var c = outerText[i];
            builder.Append(c == '\r' || c == '\n' ? c : ' ');
        }

        builder.Append(exprText);
        return builder.ToString();
    }

    // ADR-0055 delimiter-aware hole splitter. Finds the first top-level `,`
    // (alignment) and first top-level `:` (format), tracking ()/[]/{} depth
    // and skipping nested "…"/'…' literals. The expression clause is the text
    // before whichever delimiter appears first.
    private static void SplitHole(string hole, out string expr, out string alignment, out string format)
    {
        var depth = 0;
        var commaIndex = -1;
        var colonIndex = -1;
        for (var i = 0; i < hole.Length; i++)
        {
            var c = hole[i];
            if (c == '"' || c == '\'')
            {
                // Skip the nested literal, honoring `""`/`\` escapes loosely.
                var quote = c;
                i++;
                while (i < hole.Length && hole[i] != quote)
                {
                    if (hole[i] == '\\' && i + 1 < hole.Length)
                    {
                        i++;
                    }

                    i++;
                }

                continue;
            }

            if (c == '(' || c == '[' || c == '{')
            {
                depth++;
            }
            else if (c == ')' || c == ']' || c == '}')
            {
                depth--;
            }
            else if (depth == 0 && c == ',' && commaIndex < 0 && colonIndex < 0)
            {
                commaIndex = i;
            }
            else if (depth == 0 && c == ':' && colonIndex < 0)
            {
                colonIndex = i;
                break;
            }
        }

        alignment = null;
        format = null;
        if (commaIndex < 0 && colonIndex < 0)
        {
            expr = hole;
            return;
        }

        var exprEnd = commaIndex >= 0 ? commaIndex : colonIndex;
        expr = hole.Substring(0, exprEnd);
        if (commaIndex >= 0)
        {
            var alignEnd = colonIndex >= 0 ? colonIndex : hole.Length;
            alignment = hole.Substring(commaIndex + 1, alignEnd - commaIndex - 1);
        }

        if (colonIndex >= 0)
        {
            format = hole.Substring(colonIndex + 1);
        }
    }

    private static ExpressionSyntax ExtractFirstExpression(SyntaxTree innerTree)
    {
        foreach (var member in innerTree.Root.Members)
        {
            if (member is GlobalStatementSyntax gs && gs.Statement is ExpressionStatementSyntax es)
            {
                return es.Expression;
            }
        }

        return null;
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
