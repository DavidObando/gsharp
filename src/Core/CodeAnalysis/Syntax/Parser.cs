// <copyright file="Parser.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// The GSharp language parser.
/// </summary>
public partial class Parser
{
    // Issue #1602: hard limit on the recursion depth of the recursive-descent
    // parser. Without a guard, a few kilobytes of deeply nested input
    // (`a[a[a[…`, `((((…`, `!!!!…`) drive the parser into an uncatchable
    // StackOverflowException that kills the whole process (compiler, REPL, or
    // language server). Every self-nesting parse family (expressions, type
    // clauses, statements, patterns, nested type declarations, and the
    // speculative TryScan* lookahead helpers) ticks this counter on entry via
    // <see cref="EnsureNestedParseAllowed"/>; past the limit the parse is
    // abandoned, GS0417 is reported once, and a minimal compilation unit is
    // returned (see <see cref="ParseCompilationUnit"/>), mirroring Roslyn's
    // CS8078 ("an expression is too long or complex to compile").
    private const int MaxRecursionDepth = 500;

    // Issue #1602: recursion depth below which the (cheap, but not free)
    // adaptive <see cref="RuntimeHelpers.EnsureSufficientExecutionStack"/>
    // probe is skipped. Shallow parses never pay for the stack check; deep
    // parses get a belt-and-suspenders guarantee even on threads with small
    // stacks, where MaxRecursionDepth ticks alone might not be conservative
    // enough.
    private const int UncheckedRecursionDepth = 64;

    // Issue #1607: shared bound for speculative "does this look like X"
    // token-lookahead scans (matching-bracket / matching-brace searches).
    // A well-formed construct always resolves within a few dozen tokens;
    // this cap only fires on malformed/unbalanced input, turning an O(n)
    // scan-to-EOF (which is O(n^2) in aggregate since these run per
    // position) into an O(1) bailout. Mirrors the existing maxScan used by
    // LooksLikeLambdaStart / LooksLikeArrowFunctionTypeClauseStart.
    private const int LookaheadMaxScan = 4096;

    private readonly SyntaxTree syntaxTree;

    // ADR-0078 / issue #725: when a single source-level declaration desugars
    // into multiple synthesized top-level members (notably discriminated-union
    // enums, which expand into a sealed base + one class per case), the
    // expander stages the additional siblings here. `ParseMembers` drains the
    // queue after each `ParseMember` call so they appear in declaration order.
    private readonly Queue<MemberSyntax> pendingSyntheticMembers = new Queue<MemberSyntax>();

    private ImmutableArray<SyntaxToken> tokens;

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

    // Within a body-header controlling expression, an EMPTY `Ident{}` that is
    // immediately followed by a body `{` is genuinely ambiguous. In a for-in
    // collection it is a struct-literal collection (`for v in Numbers{} { .. }`);
    // in a boolean if/while condition a struct literal is never valid, so the
    // identifier is the condition and `{}` is the empty body
    // (`if disposing {} { .. }`). This flag is set only while parsing a for-in
    // collection so the empty-then-body form is treated as a struct literal
    // there and only there (#1575 follow-up).
    private bool allowEmptyStructLiteralInHeader;

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

    // Issue #1602: current recursion depth of the guarded parse families. See
    // MaxRecursionDepth above.
    private int recursionDepth;

    /// <summary>
    /// Initializes a new instance of the <see cref="Parser"/> class.
    /// </summary>
    /// <param name="syntaxTree">The source syntax tree object.</param>
    public Parser(SyntaxTree syntaxTree)
        : this(syntaxTree, 0, syntaxTree.Text.Length)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="Parser"/> class that parses only the
    /// <paramref name="start"/>-<paramref name="end"/> window of <paramref name="syntaxTree"/>'s
    /// text. Used to re-parse an interpolated-string hole's expression directly out of the
    /// outer source so resulting nodes carry true absolute positions without copying/padding
    /// the file prefix (issue #1605).
    /// </summary>
    /// <param name="syntaxTree">The source syntax tree object.</param>
    /// <param name="start">The absolute position to start parsing from.</param>
    /// <param name="end">The absolute position, exclusive, at which parsing stops.</param>
    public Parser(SyntaxTree syntaxTree, int start, int end)
    {
        var tokens = new List<SyntaxToken>();
        var docTokens = ImmutableArray.CreateBuilder<SyntaxToken>();

        var lexer = new Lexer(syntaxTree, start, end);
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
    /// Issue #1602: mirrors Roslyn's ParseWithStackGuard — when the recursion
    /// guard (see <see cref="EnsureNestedParseAllowed"/>) detects input nested
    /// beyond <see cref="MaxRecursionDepth"/> (or the thread's remaining
    /// execution stack), the parse is abandoned wholesale, GS0417 is reported,
    /// and a minimal (empty) compilation unit is returned, so the parse always
    /// terminates normally with diagnostics instead of killing the process
    /// with an uncatchable <see cref="StackOverflowException"/>.
    /// </summary>
    /// <returns>A compilation unit.</returns>
    public CompilationUnitSyntax ParseCompilationUnit()
    {
        try
        {
            return ParseCompilationUnitCore();
        }
        catch (InsufficientExecutionStackException)
        {
            // The position was left at the token where the guard tripped, so
            // the diagnostic points at the offending nesting depth.
            Diagnostics.ReportNestingTooDeep(new TextLocation(syntaxTree.Text, Current.Span));
            var endOfFileToken = tokens[tokens.Length - 1];
            return new CompilationUnitSyntax(syntaxTree, ImmutableArray<MemberSyntax>.Empty, endOfFileToken);
        }
    }

    private CompilationUnitSyntax ParseCompilationUnitCore()
    {
        var package = ParsePackage();
        var imports = ParseImports();
        var assemblyAttributes = ParseFileLevelAssemblyAttributes();
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
        return new CompilationUnitSyntax(syntaxTree, assemblyAttributes, junction.ToImmutable(), endOfFileToken);
    }

    /// <summary>
    /// Parses a leading run of file-level <c>@assembly:Name(...)</c>
    /// annotations, sitting after <c>import</c>s and before the first member.
    /// This is the producer-side opt-in surface for assembly-scoped custom
    /// attributes (chiefly <c>@assembly:InternalsVisibleTo("Foo.Tests")</c> —
    /// see ADR-0047 §2/§7 and issue #1929/#1953). Only annotations that
    /// explicitly carry the <c>assembly:</c> use-site target are consumed
    /// here; anything else is left for <see cref="ParseMembers"/> to attach
    /// to the next declaration as usual.
    /// </summary>
    private ImmutableArray<AnnotationSyntax> ParseFileLevelAssemblyAttributes()
    {
        if (Current.Kind != SyntaxKind.AtToken)
        {
            return ImmutableArray<AnnotationSyntax>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<AnnotationSyntax>();
        while (Current.Kind == SyntaxKind.AtToken
            && Peek(1).Kind == SyntaxKind.IdentifierToken
            && Peek(1).Text == "assembly"
            && Peek(2).Kind == SyntaxKind.ColonToken)
        {
            builder.Add(ParseAnnotation());
        }

        return builder.ToImmutable();
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
        // precede `func` (with or without an accessibility / async modifier).
        // It introduces an unsafe context in which unmanaged raw pointers
        // (`*T`) and raw-pointer operations are legal. The `unsafe` class/struct
        // modifier (issue #1202) is handled inside ParseAggregateDeclaration so
        // it composes with `open`/`sealed`/etc. in any order.
        SyntaxToken unsafeModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "unsafe"
            && (Peek(1).Kind == SyntaxKind.FuncKeyword
                || Peek(1).Kind == SyntaxKind.AsyncKeyword))
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
            //   [visibility]? [unsafe]? [open|sealed]? [data]? [inline]? (class|struct|enum|interface) Name ...
            // The aggregate-kind keyword IS the declaration keyword — no leading
            // `type`. Drop into the new aggregate parser path. A leading
            // `unsafe` modifier (issue #1202) is consumed inside
            // ParseAggregateDeclaration so it composes with the other modifiers.
            member = ParseAggregateDeclaration(accessibilityModifier);
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

        // Issue #1913: a C# 11 generic attribute (`[Tag<int>]`) translates to
        // `@Tag[int32]` — G# spells every generic type-argument list in
        // SQUARE brackets, the same as an ordinary generic type reference
        // (`List[int32]`), never angle brackets. Reuse the exact same
        // bracket-list parser an ordinary type clause's last segment uses
        // (`ParseOptionalSegmentTypeArguments`) rather than hand-rolling a
        // second implementation.
        ParseOptionalSegmentTypeArguments(out var typeArgumentOpen, out var typeArguments, out var typeArgumentClose);

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
            closeParen,
            typeArgumentOpen,
            typeArguments,
            typeArgumentClose);
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

    // Issue #1602: guards entry into a self-nesting parse family. When the
    // recursion-depth limit (or the runtime's remaining execution stack) is
    // exhausted, the whole parse is abandoned with an
    // <see cref="InsufficientExecutionStackException"/> that is caught in
    // <see cref="ParseCompilationUnit"/>, which reports GS0417 and returns a
    // minimal compilation unit — the same strategy as Roslyn's
    // ParseWithStackGuard. Bailing out wholesale (rather than recovering with
    // a placeholder node) matters: the parser's iterative error-recovery loops
    // would otherwise keep folding the remaining nested input into an
    // unboundedly DEEP syntax tree, which the recursive binder could not
    // survive either. Speculative lookahead (TryScanTypeClause) does not
    // throw; it fails silently instead.
    private void EnsureNestedParseAllowed()
    {
        if (recursionDepth >= MaxRecursionDepth)
        {
            throw new InsufficientExecutionStackException();
        }

        if (recursionDepth >= UncheckedRecursionDepth)
        {
            // Adaptive belt-and-suspenders: even below the deterministic
            // limit, bail out early when the actual thread stack is running
            // low (small-stack threads, deep surrounding call chains).
            RuntimeHelpers.EnsureSufficientExecutionStack();
        }
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
    /// Issue #1351: replaces the current fused <c>?[</c>
    /// (<see cref="SyntaxKind.QuestionOpenBracketToken"/>) with two distinct
    /// tokens — a <c>?</c> (<see cref="SyntaxKind.QuestionToken"/>) followed by
    /// a <c>[</c> (<see cref="SyntaxKind.OpenSquareBracketToken"/>) — at the
    /// current parse position. The lexer fuses these for null-conditional
    /// indexing (<c>a?[i]</c>); in a nullable-array type clause whose element is
    /// itself an array (<c>[]?[]T</c>) they must be parsed separately.
    /// </summary>
    private void SplitQuestionOpenBracketToken()
    {
        var fused = tokens[position];
        var question = new SyntaxToken(syntaxTree, SyntaxKind.QuestionToken, fused.Position, "?", null);
        var open = new SyntaxToken(syntaxTree, SyntaxKind.OpenSquareBracketToken, fused.Position + 1, "[", null);
        tokens = tokens.SetItem(position, question).Insert(position + 1, open);
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
