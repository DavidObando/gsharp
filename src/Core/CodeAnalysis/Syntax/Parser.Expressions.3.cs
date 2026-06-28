// <copyright file="Parser.Expressions.3.cs" company="GSharp">
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

    private ExpressionSyntax ParseCallExpression()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
        var arguments = ParseArguments();
        var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);
        arguments = MaybeAppendTrailingLambda(arguments);
        return new CallExpressionSyntax(syntaxTree, identifier, openParenthesisToken, arguments, closeParenthesisToken);
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

        // Issue #1294: the `func (` lookahead above also matches a RECEIVER-form
        // method declaration `func (recv Type) Name(...)`, whose leading
        // `(recv Type)` is a receiver clause rather than a function-literal
        // parameter list. This collides with expression-bodied members from
        // issue #1278: an arrow body that ends in a call (`-> Q(b)`) followed by
        // a receiver-form declaration on the next line would otherwise gobble
        // that declaration's `func (recv Type)` as a trailing lambda. A function
        // LITERAL never has a method name after its parameter list (its `)` is
        // followed by `{` or a return-type clause, then `{`); a receiver-form
        // declaration is uniquely `func (recv Type) Identifier (` — an
        // identifier (the method name) immediately followed by its own `(`. When
        // we see that shape, the following `func` is a declaration: leave it for
        // the declaration parser and do not attach it as a trailing lambda.
        var funcOffset = isAsyncLiteral ? 1 : 0;
        if (LooksLikeReceiverMethodDeclaration(funcOffset))
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

    private ExpressionSyntax ParseNameExpression()
    {
        var identifierToken = MatchToken(SyntaxKind.IdentifierToken);
        return new NameExpressionSyntax(syntaxTree, identifierToken);
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
}
