// <copyright file="Parser.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    using System.Collections.Generic;
    using System.Collections.Immutable;
    using System.Linq;
    using GSharp.Core.CodeAnalysis.Text;

    /// <summary>
    /// The GSharp language parser.
    /// </summary>
    public class Parser
    {
        private readonly SourceText text;
        private readonly ImmutableArray<SyntaxToken> tokens;
        private int position;

        /// <summary>
        /// Initializes a new instance of the <see cref="Parser"/> class.
        /// </summary>
        /// <param name="text">The source document.</param>
        public Parser(SourceText text)
        {
            var tokens = new List<SyntaxToken>();

            var lexer = new Lexer(text);
            SyntaxToken token;
            do
            {
                token = lexer.Lex();

                if (token.Kind != SyntaxKind.WhitespaceToken &&
                    token.Kind != SyntaxKind.CommentToken &&
                    token.Kind != SyntaxKind.BadToken)
                {
                    tokens.Add(token);
                }
            }
            while (token.Kind != SyntaxKind.EndOfFileToken);

            this.text = text;
            this.tokens = tokens.ToImmutableArray();
            Diagnostics.AddRange(lexer.Diagnostics);
        }

        /// <summary>
        /// Gets tiagnostic bag associated to this parser.
        /// </summary>
        public DiagnosticBag Diagnostics { get; } = new DiagnosticBag();

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
            return new CompilationUnitSyntax(junction.ToImmutable(), endOfFileToken);
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

                return new PackageSyntax(packageKeyword, identifiers.ToImmutableArray());
            }

            return null;
        }

        private ImmutableArray<MemberSyntax> ParseImports()
        {
            var importsBuilder = ImmutableArray.CreateBuilder<MemberSyntax>();
            while (Current.Kind == SyntaxKind.ImportKeyword)
            {
                var importKeyword = MatchToken(SyntaxKind.ImportKeyword);
                var identifiers = ImmutableArray.CreateBuilder<SyntaxToken>();
                identifiers.Add(MatchToken(SyntaxKind.IdentifierToken));
                while (Current.Kind == SyntaxKind.DotToken)
                {
                    identifiers.Add(MatchToken(SyntaxKind.DotToken));
                    identifiers.Add(MatchToken(SyntaxKind.IdentifierToken));
                }

                importsBuilder.Add(new ImportSyntax(importKeyword, identifiers.ToImmutableArray()));
            }

            return importsBuilder.ToImmutable();
        }

        private ImmutableArray<MemberSyntax> ParseMembers()
        {
            var members = ImmutableArray.CreateBuilder<MemberSyntax>();

            while (Current.Kind != SyntaxKind.EndOfFileToken)
            {
                var startToken = Current;

                var member = ParseMember();
                members.Add(member);

                if (Current == startToken)
                {
                    NextToken();
                }
            }

            return members.ToImmutable();
        }

        private MemberSyntax ParseMember()
        {
            if (Current.Kind == SyntaxKind.FuncKeyword)
            {
                return ParseFunctionDeclaration();
            }

            return ParseGlobalStatement();
        }

        private MemberSyntax ParseFunctionDeclaration()
        {
            var functionKeyword = MatchToken(SyntaxKind.FuncKeyword);
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
            var parameters = ParseParameterList();
            var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);
            var type = ParseOptionalTypeClause();
            var body = ParseBlockStatement();
            return new FunctionDeclarationSyntax(functionKeyword, identifier, openParenthesisToken, parameters, closeParenthesisToken, type, body);
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
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var type = ParseTypeClause();
            return new ParameterSyntax(identifier, type);
        }

        private TypeClauseSyntax ParseTypeClause()
        {
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            return new TypeClauseSyntax(identifier);
        }

        private TypeClauseSyntax ParseOptionalTypeClause()
        {
            if (Current.Kind != SyntaxKind.IdentifierToken)
            {
                return null;
            }

            return ParseTypeClause();
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

            return new BlockStatementSyntax(openBraceToken, statements.ToImmutable(), closeBraceToken);
        }

        private MemberSyntax ParseGlobalStatement()
        {
            var statement = ParseStatement();
            return new GlobalStatementSyntax(statement);
        }

        private StatementSyntax ParseStatement()
        {
            switch (Current.Kind)
            {
                case SyntaxKind.OpenBraceToken:
                    return ParseBlockStatement();
                case SyntaxKind.ConstKeyword:
                case SyntaxKind.VarKeyword:
                    return ParseVariableDeclaration();
                case SyntaxKind.IfKeyword:
                    return ParseIfStatement();
                case SyntaxKind.ForKeyword:
                    return ParseForStatement();
                case SyntaxKind.BreakKeyword:
                    return ParseBreakStatement();
                case SyntaxKind.ContinueKeyword:
                    return ParseContinueStatement();
                case SyntaxKind.ReturnKeyword:
                    return ParseReturnStatement();
                default:
                    if (Current.Kind == SyntaxKind.IdentifierToken &&
                        Peek(1).Kind == SyntaxKind.ColonEqualsToken)
                    {
                        // We do this outside of "ParseExpressionStatement" because
                        // short variable declarations aren't expressions but
                        // statements.
                        return ParseSingleShortVariableDeclaration();
                    }

                    return ParseExpressionStatement();
            }
        }

        private StatementSyntax ParseSingleShortVariableDeclaration()
        {
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var colonEquals = MatchToken(SyntaxKind.ColonEqualsToken);
            var initializer = ParseExpression();
            return new VariableDeclarationSyntax(
                keyword: null,
                identifier: identifier,
                typeClause: null,
                equalsToken: colonEquals,
                initializer: initializer);
        }

        private StatementSyntax ParseVariableDeclaration()
        {
            var expected = Current.Kind == SyntaxKind.ConstKeyword ? SyntaxKind.ConstKeyword : SyntaxKind.VarKeyword;
            var keyword = MatchToken(expected);
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var typeClause = ParseOptionalTypeClause();
            var equals = MatchToken(SyntaxKind.EqualsToken);
            var initializer = ParseExpression();
            return new VariableDeclarationSyntax(keyword, identifier, typeClause, equals, initializer);
        }

        private StatementSyntax ParseIfStatement()
        {
            var keyword = MatchToken(SyntaxKind.IfKeyword);
            var condition = ParseExpression();
            var statement = ParseStatement();
            var elseClause = ParseElseClause();
            return new IfStatementSyntax(keyword, condition, statement, elseClause);
        }

        private ElseClauseSyntax ParseElseClause()
        {
            if (Current.Kind != SyntaxKind.ElseKeyword)
            {
                return null;
            }

            var keyword = NextToken();
            var statement = ParseStatement();
            return new ElseClauseSyntax(keyword, statement);
        }

        private StatementSyntax ParseForStatement()
        {
            if (Peek(1).Kind == SyntaxKind.OpenBraceToken)
            {
                return ParseForInfiniteStatement();
            }

            return ParseForEllipsisStatement();
        }

        private StatementSyntax ParseForInfiniteStatement()
        {
            var keyword = MatchToken(SyntaxKind.ForKeyword);
            var body = ParseStatement();
            return new ForInfiniteStatementSyntax(keyword, body);
        }

        private StatementSyntax ParseForEllipsisStatement()
        {
            var keyword = MatchToken(SyntaxKind.ForKeyword);
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var colonEqualsToken = MatchToken(SyntaxKind.ColonEqualsToken);
            var lowerBound = ParseExpression();
            var toKeyword = MatchToken(SyntaxKind.EllipsisToken);
            var upperBound = ParseExpression();
            var body = ParseStatement();
            return new ForEllipsisStatementSyntax(keyword, identifier, colonEqualsToken, lowerBound, toKeyword, upperBound, body);
        }

        private StatementSyntax ParseBreakStatement()
        {
            var keyword = MatchToken(SyntaxKind.BreakKeyword);
            return new BreakStatementSyntax(keyword);
        }

        private StatementSyntax ParseContinueStatement()
        {
            var keyword = MatchToken(SyntaxKind.ContinueKeyword);
            return new ContinueStatementSyntax(keyword);
        }

        private StatementSyntax ParseReturnStatement()
        {
            var keyword = MatchToken(SyntaxKind.ReturnKeyword);
            var keywordLine = text.GetLineIndex(keyword.Span.Start);
            var currentLine = text.GetLineIndex(Current.Span.Start);
            var isEof = Current.Kind == SyntaxKind.EndOfFileToken;
            var sameLine = !isEof && keywordLine == currentLine;
            var expression = sameLine ? ParseExpression() : null;
            return new ReturnStatementSyntax(keyword, expression);
        }

        private ExpressionStatementSyntax ParseExpressionStatement()
        {
            var expression = ParseExpression();
            return new ExpressionStatementSyntax(expression);
        }

        private ExpressionSyntax ParseExpression()
        {
            return ParseAssignmentExpression();
        }

        private ExpressionSyntax ParseAssignmentExpression()
        {
            if (Peek(0).Kind == SyntaxKind.IdentifierToken &&
                Peek(1).Kind == SyntaxKind.EqualsToken)
            {
                var identifierToken = NextToken();
                var operatorToken = NextToken();
                var right = ParseAssignmentExpression();
                return new AssignmentExpressionSyntax(identifierToken, operatorToken, right);
            }

            return ParseBinaryExpression();
        }

        private ExpressionSyntax ParseBinaryExpression(int parentPrecedence = 0)
        {
            ExpressionSyntax left;
            var unaryOperatorPrecedence = Current.Kind.GetUnaryOperatorPrecedence();
            if (unaryOperatorPrecedence != 0 && unaryOperatorPrecedence >= parentPrecedence)
            {
                var operatorToken = NextToken();
                var operand = ParseBinaryExpression(unaryOperatorPrecedence);
                left = new UnaryExpressionSyntax(operatorToken, operand);
            }
            else
            {
                left = ParsePrimaryExpression();
            }

            while (true)
            {
                var precedence = Current.Kind.GetBinaryOperatorPrecedence();
                if (precedence == 0 || precedence <= parentPrecedence)
                {
                    break;
                }

                var operatorToken = NextToken();
                var right = ParseBinaryExpression(precedence);
                left = new BinaryExpressionSyntax(left, operatorToken, right);
            }

            return left;
        }

        private ExpressionSyntax ParsePrimaryExpression()
        {
            switch (Current.Kind)
            {
                case SyntaxKind.OpenParenthesisToken:
                    return ParseParenthesizedExpression();

                case SyntaxKind.FalseKeyword:
                case SyntaxKind.TrueKeyword:
                    return ParseBooleanLiteral();

                case SyntaxKind.NumberToken:
                    return ParseNumberLiteral();

                case SyntaxKind.StringToken:
                    return ParseStringLiteral();

                case SyntaxKind.IdentifierToken:
                default:
                    return ParseNameOrCallExpression();
            }
        }

        private ExpressionSyntax ParseNameOrCallExpression()
        {
            ExpressionSyntax current;
            if (Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
            {
                current = ParseCallExpression();
            }
            else
            {
                current = ParseNameExpression();
            }

            if (Current.Kind == SyntaxKind.DotToken)
            {
                var dotToken = MatchToken(SyntaxKind.DotToken);
                var rightSide = ParseNameOrCallExpression();
                current = new AccessorExpressionSyntax(current, dotToken, rightSide);
            }

            return current;
        }

        private ExpressionSyntax ParseCallExpression()
        {
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
            var arguments = ParseArguments();
            var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);
            return new CallExpressionSyntax(identifier, openParenthesisToken, arguments, closeParenthesisToken);
        }

        private SeparatedSyntaxList<ExpressionSyntax> ParseArguments()
        {
            var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

            var parseNextArgument = true;
            while (parseNextArgument &&
                   Current.Kind != SyntaxKind.CloseParenthesisToken &&
                   Current.Kind != SyntaxKind.EndOfFileToken)
            {
                var expression = ParseExpression();
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

        private ExpressionSyntax ParseNameExpression()
        {
            var identifierToken = MatchToken(SyntaxKind.IdentifierToken);
            return new NameExpressionSyntax(identifierToken);
        }

        private ExpressionSyntax ParseParenthesizedExpression()
        {
            var left = MatchToken(SyntaxKind.OpenParenthesisToken);
            var expression = ParseExpression();
            var right = MatchToken(SyntaxKind.CloseParenthesisToken);
            return new ParenthesizedExpressionSyntax(left, expression, right);
        }

        private ExpressionSyntax ParseBooleanLiteral()
        {
            var isTrue = Current.Kind == SyntaxKind.TrueKeyword;
            var keywordToken = isTrue ? MatchToken(SyntaxKind.TrueKeyword) : MatchToken(SyntaxKind.FalseKeyword);
            return new LiteralExpressionSyntax(keywordToken, isTrue);
        }

        private ExpressionSyntax ParseNumberLiteral()
        {
            var numberToken = MatchToken(SyntaxKind.NumberToken);
            return new LiteralExpressionSyntax(numberToken);
        }

        private ExpressionSyntax ParseStringLiteral()
        {
            var stringToken = MatchToken(SyntaxKind.StringToken);
            return new LiteralExpressionSyntax(stringToken);
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

        private SyntaxToken MatchToken(SyntaxKind kind)
        {
            if (Current.Kind == kind)
            {
                return NextToken();
            }

            Diagnostics.ReportUnexpectedToken(Current.Span, Current.Kind, kind);
            return new SyntaxToken(kind, Current.Position, null, null);
        }
    }
}
