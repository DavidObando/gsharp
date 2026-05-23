// <copyright file="Parser.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
    private int position;

    /// <summary>
    /// Initializes a new instance of the <see cref="Parser"/> class.
    /// </summary>
    /// <param name="syntaxTree">The source syntax tree object.</param>
    public Parser(SyntaxTree syntaxTree)
    {
        var tokens = new List<SyntaxToken>();

        var lexer = new Lexer(syntaxTree);
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

        this.syntaxTree = syntaxTree;
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
        SyntaxToken accessibilityModifier = null;
        if (Current.Kind == SyntaxKind.PublicKeyword ||
            Current.Kind == SyntaxKind.InternalKeyword ||
            Current.Kind == SyntaxKind.PrivateKeyword)
        {
            accessibilityModifier = NextToken();
        }

        if (Current.Kind == SyntaxKind.FuncKeyword)
        {
            return ParseFunctionDeclaration(accessibilityModifier);
        }

        if (Current.Kind == SyntaxKind.TypeKeyword)
        {
            return ParseTypeAliasDeclaration(accessibilityModifier);
        }

        if (accessibilityModifier != null &&
            (Current.Kind == SyntaxKind.VarKeyword ||
             Current.Kind == SyntaxKind.LetKeyword ||
             Current.Kind == SyntaxKind.ConstKeyword))
        {
            var declaration = ParseVariableDeclaration(accessibilityModifier);
            return new GlobalStatementSyntax(syntaxTree, declaration);
        }

        if (accessibilityModifier != null)
        {
            Diagnostics.ReportAccessibilityModifierNotAllowedHere(accessibilityModifier.Location, accessibilityModifier.Text);
        }

        return ParseGlobalStatement();
    }

    private MemberSyntax ParseTypeAliasDeclaration(SyntaxToken accessibilityModifier)
    {
        var typeKeyword = MatchToken(SyntaxKind.TypeKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);

        // `data` is a context-sensitive keyword (ADR-0029): only acts as the
        // data-struct marker when followed directly by `struct`. Elsewhere it
        // is an ordinary identifier.
        SyntaxToken dataKeyword = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "data" && Peek(1).Kind == SyntaxKind.StructKeyword)
        {
            dataKeyword = NextToken();
        }

        // Phase 3.B.3 sub-step 3: optional `open` modifier on a class
        // declaration. Per ADR-0017, plain `class` is sealed; `open class`
        // can be subclassed. `open` before `struct` is diagnosed in the
        // struct parser (structs cannot be subclassed in CLR).
        SyntaxToken openModifier = null;
        if (Current.Kind == SyntaxKind.OpenKeyword && (Peek(1).Kind == SyntaxKind.ClassKeyword || Peek(1).Kind == SyntaxKind.StructKeyword))
        {
            openModifier = NextToken();
        }

        if (Current.Kind == SyntaxKind.StructKeyword || Current.Kind == SyntaxKind.ClassKeyword)
        {
            return ParseStructDeclaration(accessibilityModifier, typeKeyword, identifier, dataKeyword, openModifier);
        }

        if (Current.Kind == SyntaxKind.InterfaceKeyword)
        {
            if (openModifier != null)
            {
                Diagnostics.ReportUnexpectedToken(openModifier.Location, SyntaxKind.OpenKeyword, SyntaxKind.InterfaceKeyword);
            }

            if (dataKeyword != null)
            {
                Diagnostics.ReportUnexpectedToken(dataKeyword.Location, SyntaxKind.IdentifierToken, SyntaxKind.InterfaceKeyword);
            }

            return ParseInterfaceDeclaration(accessibilityModifier, typeKeyword, identifier);
        }

        if (openModifier != null)
        {
            Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword);
        }

        if (dataKeyword != null)
        {
            // We already consumed `data` but the next token wasn't `struct`.
            // This path is unreachable given the lookahead above, but keeps
            // the parser deterministic if peek state ever drifts.
            Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.StructKeyword);
        }

        var equalsToken = MatchToken(SyntaxKind.EqualsToken);
        var aliasedIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var aliasedType = new TypeClauseSyntax(syntaxTree, aliasedIdentifier);
        return new TypeAliasDeclarationSyntax(syntaxTree, accessibilityModifier, typeKeyword, identifier, equalsToken, aliasedType);
    }

    private StructDeclarationSyntax ParseStructDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken dataKeyword,
        SyntaxToken openModifier)
    {
        var structOrClassKeyword = Current.Kind == SyntaxKind.ClassKeyword
            ? MatchToken(SyntaxKind.ClassKeyword)
            : MatchToken(SyntaxKind.StructKeyword);

        if (dataKeyword != null && structOrClassKeyword.Kind == SyntaxKind.ClassKeyword)
        {
            // ADR-0029 limits `data` to `struct`; `data class` is not part of
            // the Phase 3 design. Diagnose but continue so the rest of the
            // body parses cleanly.
            Diagnostics.ReportUnexpectedToken(structOrClassKeyword.Location, SyntaxKind.ClassKeyword, SyntaxKind.StructKeyword);
        }

        if (openModifier != null && structOrClassKeyword.Kind != SyntaxKind.ClassKeyword)
        {
            // ADR-0017: `open` is only meaningful on a `class` (structs are
            // value types and cannot be subclassed).
            Diagnostics.ReportUnexpectedToken(openModifier.Location, SyntaxKind.OpenKeyword, SyntaxKind.ClassKeyword);
        }

        // Phase 3.B.3 sub-step 2: optional Kotlin-style primary constructor
        // parameter list `(name Type, name Type, ...)` directly after the
        // `class` keyword. Each parameter becomes both a ctor argument and a
        // public field of the same name. Only valid for classes; structs are
        // constructed exclusively via composite literals.
        SyntaxToken primaryCtorOpenParen = null;
        SyntaxToken primaryCtorCloseParen = null;
        SeparatedSyntaxList<ParameterSyntax> primaryCtorParameters = new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty);
        if (Current.Kind == SyntaxKind.OpenParenthesisToken)
        {
            if (structOrClassKeyword.Kind != SyntaxKind.ClassKeyword)
            {
                Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.OpenBraceToken);
            }

            primaryCtorOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken);
            primaryCtorParameters = ParseParameterList();
            primaryCtorCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        }

        // Phase 3.B.3 sub-step 3: optional base clause `: Base`.
        // Phase 3.B.4 extends this to `: Base, IFoo, IBar` — a comma-separated
        // list. The binder classifies each identifier as either the base class
        // (at most one, must come first) or an implemented interface.
        SyntaxToken baseColon = null;
        SyntaxToken baseTypeIdentifier = null;
        var additionalBaseIdentifiers = ImmutableArray.CreateBuilder<SyntaxToken>();
        if (Current.Kind == SyntaxKind.ColonToken)
        {
            if (structOrClassKeyword.Kind != SyntaxKind.ClassKeyword)
            {
                Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.OpenBraceToken);
            }

            baseColon = MatchToken(SyntaxKind.ColonToken);
            baseTypeIdentifier = MatchToken(SyntaxKind.IdentifierToken);

            while (Current.Kind == SyntaxKind.CommaToken)
            {
                NextToken();
                var next = MatchToken(SyntaxKind.IdentifierToken);
                additionalBaseIdentifiers.Add(next);
            }
        }

        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        var fields = ImmutableArray.CreateBuilder<FieldDeclarationSyntax>();
        var methods = ImmutableArray.CreateBuilder<FunctionDeclarationSyntax>();
        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            // Phase 3.B.3 sub-step 2b: method declarations inside the body.
            // Use the existing `func Name(args) Ret { body }` parser; the
            // method has no explicit receiver clause — the receiver is the
            // enclosing class. Struct types reject methods (diagnose+skip).
            SyntaxToken memberAccessibility = null;
            if (Current.Kind == SyntaxKind.PublicKeyword ||
                Current.Kind == SyntaxKind.InternalKeyword ||
                Current.Kind == SyntaxKind.PrivateKeyword)
            {
                // Accessibility modifier may be followed by an optional
                // `open`/`override` and then `func`.
                var ahead = 1;
                while (Peek(ahead).Kind == SyntaxKind.OpenKeyword || Peek(ahead).Kind == SyntaxKind.OverrideKeyword)
                {
                    ahead++;
                }

                if (Peek(ahead).Kind == SyntaxKind.FuncKeyword)
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

            if (Current.Kind == SyntaxKind.FuncKeyword)
            {
                if (structOrClassKeyword.Kind != SyntaxKind.ClassKeyword)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.IdentifierToken);
                }

                var method = (FunctionDeclarationSyntax)ParseFunctionDeclaration(memberAccessibility, memberOpenModifier, memberOverrideModifier);
                methods.Add(method);
            }
            else
            {
                if (memberOpenModifier != null || memberOverrideModifier != null)
                {
                    var loc = (memberOpenModifier ?? memberOverrideModifier).Location;
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.FuncKeyword);
                }

                fields.Add(ParseFieldDeclaration());
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new StructDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            dataKeyword,
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
            methods.ToImmutable(),
            closeBrace);
    }

    private InterfaceDeclarationSyntax ParseInterfaceDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier)
    {
        var interfaceKeyword = MatchToken(SyntaxKind.InterfaceKeyword);
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        var methods = ImmutableArray.CreateBuilder<FunctionDeclarationSyntax>();
        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            // Per ADR-0018, interface members are method signatures only.
            // No accessibility / open / override modifiers are accepted.
            if (Current.Kind == SyntaxKind.FuncKeyword)
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
        return new InterfaceDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            interfaceKeyword,
            openBrace,
            methods.ToImmutable(),
            closeBrace);
    }

    private FunctionDeclarationSyntax ParseInterfaceMethodSignature()
    {
        var functionKeyword = MatchToken(SyntaxKind.FuncKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseParameterList();
        var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);
        var type = ParseOptionalTypeClause();

        // ADR-0018: interface methods carry no body. Diagnose if one appears,
        // then consume it so the rest of the body parses cleanly.
        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            Diagnostics.ReportInterfaceMethodHasBody(identifier.Location, identifier.Text);
            ParseBlockStatement();
        }

        return new FunctionDeclarationSyntax(
            syntaxTree,
            accessibilityModifier: null,
            openModifier: null,
            overrideModifier: null,
            functionKeyword,
            identifier,
            openParenthesisToken,
            parameters,
            closeParenthesisToken,
            type,
            body: null);
    }

    private FieldDeclarationSyntax ParseFieldDeclaration()
    {
        SyntaxToken fieldAccessibility = null;
        if (Current.Kind == SyntaxKind.PublicKeyword ||
            Current.Kind == SyntaxKind.InternalKeyword ||
            Current.Kind == SyntaxKind.PrivateKeyword)
        {
            fieldAccessibility = NextToken();
        }

        var fieldIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var fieldType = ParseTypeClause();
        return new FieldDeclarationSyntax(syntaxTree, fieldAccessibility, fieldIdentifier, fieldType);
    }

    private MemberSyntax ParseFunctionDeclaration(SyntaxToken accessibilityModifier)
        => ParseFunctionDeclaration(accessibilityModifier, openModifier: null, overrideModifier: null);

    private MemberSyntax ParseFunctionDeclaration(SyntaxToken accessibilityModifier, SyntaxToken openModifier, SyntaxToken overrideModifier)
    {
        var functionKeyword = MatchToken(SyntaxKind.FuncKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseParameterList();
        var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);
        var type = ParseOptionalTypeClause();
        var body = ParseBlockStatement();
        return new FunctionDeclarationSyntax(syntaxTree, accessibilityModifier, openModifier, overrideModifier, functionKeyword, identifier, openParenthesisToken, parameters, closeParenthesisToken, type, body);
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
        return new ParameterSyntax(syntaxTree, identifier, type);
    }

    private TypeClauseSyntax ParseTypeClause()
    {
        if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
        {
            var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
            SyntaxToken length = null;
            if (Current.Kind != SyntaxKind.CloseSquareBracketToken)
            {
                length = MatchToken(SyntaxKind.NumberToken);
            }

            var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
            var elementIdentifier = MatchToken(SyntaxKind.IdentifierToken);
            return new TypeClauseSyntax(syntaxTree, openBracket, length, closeBracket, elementIdentifier);
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        return new TypeClauseSyntax(syntaxTree, identifier);
    }

    private TypeClauseSyntax ParseOptionalTypeClause()
    {
        if (Current.Kind != SyntaxKind.IdentifierToken &&
            Current.Kind != SyntaxKind.OpenSquareBracketToken)
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

        return new BlockStatementSyntax(syntaxTree, openBraceToken, statements.ToImmutable(), closeBraceToken);
    }

    private MemberSyntax ParseGlobalStatement()
    {
        var statement = ParseStatement();
        return new GlobalStatementSyntax(syntaxTree, statement);
    }

    private StatementSyntax ParseStatement()
    {
        switch (Current.Kind)
        {
            case SyntaxKind.OpenBraceToken:
                return ParseBlockStatement();
            case SyntaxKind.ConstKeyword:
            case SyntaxKind.LetKeyword:
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
            default:
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

                return ParseExpressionStatement();
        }
    }

    private StatementSyntax ParseSingleShortVariableDeclaration()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var colonEquals = MatchToken(SyntaxKind.ColonEqualsToken);
        var initializer = ParseExpression();
        return new VariableDeclarationSyntax(
            syntaxTree: syntaxTree,
            keyword: null,
            identifier: identifier,
            typeClause: null,
            equalsToken: colonEquals,
            initializer: initializer);
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
            op = MatchToken(SyntaxKind.ColonEqualsToken);
        }
        else
        {
            op = MatchToken(SyntaxKind.EqualsToken);
        }

        var values = ParseMultiValueList();
        return new MultiAssignmentStatementSyntax(syntaxTree, targets, op, values);
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
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeClause = ParseOptionalTypeClause();
        var equals = MatchToken(SyntaxKind.EqualsToken);
        var initializer = ParseExpression();
        return new VariableDeclarationSyntax(syntaxTree, accessibilityModifier, keyword, identifier, typeClause, equals, initializer);
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

        var condition = ParseExpression();
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

    private StatementSyntax ParseForStatement()
    {
        if (Peek(1).Kind == SyntaxKind.OpenBraceToken)
        {
            return ParseForInfiniteStatement();
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

    private bool LooksLikeForEllipsis()
    {
        // `for <ident> := <expr> ... <expr> { ... }`
        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        if (Peek(2).Kind != SyntaxKind.ColonEqualsToken)
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
        var condition = ParseExpression();
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
            condition = ParseExpression();
        }

        var secondSemicolon = MatchToken(SyntaxKind.SemicolonToken);

        StatementSyntax post = null;
        if (Current.Kind != SyntaxKind.OpenBraceToken)
        {
            post = ParseSimpleStatement();
        }

        var body = ParseStatement();
        return new ForClauseStatementSyntax(syntaxTree, keyword, initializer, firstSemicolon, condition, secondSemicolon, post, body);
    }

    private StatementSyntax ParseSimpleStatement()
    {
        // A "simple statement" in the for-header context is one of:
        //   short variable declaration `x := expr`
        //   increment/decrement       `x++` / `x--`
        //   assignment                `x = expr`, `x += expr`, ...
        //   expression statement      `f()`
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

    private StatementSyntax ParseForEllipsisStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var colonEqualsToken = MatchToken(SyntaxKind.ColonEqualsToken);
        var lowerBound = ParseExpression();
        var toKeyword = MatchToken(SyntaxKind.EllipsisToken);
        var upperBound = ParseExpression();
        var body = ParseStatement();
        return new ForEllipsisStatementSyntax(syntaxTree, keyword, identifier, colonEqualsToken, lowerBound, toKeyword, upperBound, body);
    }

    private StatementSyntax ParseBreakStatement()
    {
        var keyword = MatchToken(SyntaxKind.BreakKeyword);
        return new BreakStatementSyntax(syntaxTree, keyword);
    }

    private StatementSyntax ParseContinueStatement()
    {
        var keyword = MatchToken(SyntaxKind.ContinueKeyword);
        return new ContinueStatementSyntax(syntaxTree, keyword);
    }

    private StatementSyntax ParseReturnStatement()
    {
        var keyword = MatchToken(SyntaxKind.ReturnKeyword);
        var keywordLine = syntaxTree.Text.GetLineIndex(keyword.Span.Start);
        var currentLine = syntaxTree.Text.GetLineIndex(Current.Span.Start);
        var isEof = Current.Kind == SyntaxKind.EndOfFileToken;
        var sameLine = !isEof && keywordLine == currentLine;
        var expression = sameLine ? ParseExpression() : null;
        return new ReturnStatementSyntax(syntaxTree, keyword, expression);
    }

    private StatementSyntax ParseSwitchStatement()
    {
        var switchKeyword = MatchToken(SyntaxKind.SwitchKeyword);
        var expression = ParseExpression();
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
            return new SwitchCaseSyntax(syntaxTree, defaultKeyword, value: null, body);
        }

        var caseKeyword = MatchToken(SyntaxKind.CaseKeyword);
        var value = ParseExpression();
        var caseBody = ParseBlockStatement();
        return new SwitchCaseSyntax(syntaxTree, caseKeyword, value, caseBody);
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

    private ExpressionStatementSyntax ParseExpressionStatement()
    {
        var expression = ParseExpression();
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
            var identifierToken = NextToken();
            var compoundToken = NextToken();
            var right = ParseAssignmentExpression();

            var leftName = new NameExpressionSyntax(syntaxTree, identifierToken);
            var baseOpToken = new SyntaxToken(syntaxTree, baseOpKind, compoundToken.Position, SyntaxFacts.GetText(baseOpKind), null);
            var binary = new BinaryExpressionSyntax(syntaxTree, leftName, baseOpToken, right);
            var equalsToken = new SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, compoundToken.Position, SyntaxFacts.GetText(SyntaxKind.EqualsToken), null);
            return new AssignmentExpressionSyntax(syntaxTree, identifierToken, equalsToken, binary);
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
            left = new UnaryExpressionSyntax(syntaxTree, operatorToken, operand);
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
            left = new BinaryExpressionSyntax(syntaxTree, left, operatorToken, right);
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

            case SyntaxKind.InterpolatedStringToken:
                return ParseInterpolatedStringLiteral();

            case SyntaxKind.OpenSquareBracketToken:
                return ParseArrayCreationExpression();

            case SyntaxKind.IdentifierToken:
            default:
                return ParseNameOrCallExpression();
        }
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
        if (Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            current = ParseCallExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Peek(1).Kind == SyntaxKind.OpenBraceToken
            && IsStructLiteralFollowingBrace(2))
        {
            current = ParseStructLiteralExpression();
        }
        else
        {
            current = ParseNameExpression();
        }

        while (true)
        {
            if (Current.Kind == SyntaxKind.DotToken)
            {
                var dotToken = MatchToken(SyntaxKind.DotToken);
                var rightSide = ParseNameOrCallExpression();
                current = new AccessorExpressionSyntax(syntaxTree, current, dotToken, rightSide);
            }
            else if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
            {
                var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
                var index = ParseExpression();
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

    private ExpressionSyntax ParseCallExpression()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
        var arguments = ParseArguments();
        var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new CallExpressionSyntax(syntaxTree, identifier, openParenthesisToken, arguments, closeParenthesisToken);
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

        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        var initializers = new SeparatedSyntaxList<FieldInitializerSyntax>(nodesAndSeparators.ToImmutable());
        return new StructLiteralExpressionSyntax(syntaxTree, typeIdentifier, openBrace, initializers, closeBrace);
    }

    private FieldInitializerSyntax ParseFieldInitializer()
    {
        var fieldId = MatchToken(SyntaxKind.IdentifierToken);
        var colon = MatchToken(SyntaxKind.ColonToken);
        var value = ParseExpression();
        return new FieldInitializerSyntax(syntaxTree, fieldId, colon, value);
    }

    private ExpressionSyntax ParseParenthesizedExpression()
    {
        var left = MatchToken(SyntaxKind.OpenParenthesisToken);
        var expression = ParseExpression();
        var right = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new ParenthesizedExpressionSyntax(syntaxTree, left, expression, right);
    }

    private ExpressionSyntax ParseBooleanLiteral()
    {
        var isTrue = Current.Kind == SyntaxKind.TrueKeyword;
        var keywordToken = isTrue ? MatchToken(SyntaxKind.TrueKeyword) : MatchToken(SyntaxKind.FalseKeyword);
        return new LiteralExpressionSyntax(syntaxTree, keywordToken, isTrue);
    }

    private ExpressionSyntax ParseNumberLiteral()
    {
        var numberToken = MatchToken(SyntaxKind.NumberToken);
        return new LiteralExpressionSyntax(syntaxTree, numberToken);
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

            // Parse the captured expression source by spinning up a fresh
            // parser; embedded expressions are independent of the outer parser
            // state aside from sharing the same syntax tree.
            var innerText = SourceText.From(fragment.Text);
            var innerTree = SyntaxTree.Parse(innerText);
            var innerExpression = ExtractFirstExpression(innerTree);
            if (innerExpression == null)
            {
                // Fall back to a synthetic missing-name node anchored on the
                // string token so binders still see a valid (error-producing)
                // expression syntax.
                var synthetic = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, token.Position, fragment.Text, null);
                innerExpression = new NameExpressionSyntax(syntaxTree, synthetic);
            }

            segments.Add(InterpolatedStringSegment.FromExpression(innerExpression));
        }

        return new InterpolatedStringExpressionSyntax(syntaxTree, token, segments.ToImmutable());
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
