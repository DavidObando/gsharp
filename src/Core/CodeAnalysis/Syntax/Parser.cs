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

        // Phase 5.1 / ADR-0023: an optional `async` modifier may precede
        // `func` (with or without an accessibility modifier).
        SyntaxToken asyncModifier = null;
        if (Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
        {
            asyncModifier = NextToken();
        }

        if (Current.Kind == SyntaxKind.FuncKeyword)
        {
            return ParseFunctionDeclaration(accessibilityModifier, openModifier: null, overrideModifier: null, asyncModifier);
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

        if (asyncModifier != null)
        {
            // `async` not followed by `func` — surface as an unexpected token.
            Diagnostics.ReportUnexpectedToken(asyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
        }

        return ParseGlobalStatement();
    }

    private MemberSyntax ParseTypeAliasDeclaration(SyntaxToken accessibilityModifier)
    {
        var typeKeyword = MatchToken(SyntaxKind.TypeKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);

        // Phase 4.3 / ADR-0020: optional type-parameter list directly after the
        // type name: `type Box[T any] class { ... }`. Reuses the same helpers
        // as generic function declarations.
        var typeParameterList = ParseOptionalTypeParameterList();

        // `record` is a context-sensitive keyword (ADR-0025): in a type
        // declaration header it aliases `data struct` only when followed by a
        // body. Elsewhere it remains an ordinary identifier.
        SyntaxToken preconsumedStructOrClassKeyword = null;
        SyntaxToken dataKeyword = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "record" && Peek(1).Kind == SyntaxKind.OpenBraceToken)
        {
            dataKeyword = NextToken();
            preconsumedStructOrClassKeyword = new SyntaxToken(syntaxTree, SyntaxKind.StructKeyword, dataKeyword.Position, "struct", null);
        }

        // `data` is a context-sensitive keyword (ADR-0029): only acts as the
        // data-struct marker when followed directly by `struct` or `enum`.
        // Elsewhere it is an ordinary identifier.
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "data" && (Peek(1).Kind == SyntaxKind.StructKeyword || Peek(1).Kind == SyntaxKind.EnumKeyword || Peek(1).Text == "record" || Peek(1).Text == "inline"))
        {
            dataKeyword = NextToken();
        }

        SyntaxToken inlineKeyword = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "inline" && (Peek(1).Kind == SyntaxKind.StructKeyword || Peek(1).Text == "data" || Peek(1).Kind == SyntaxKind.OpenKeyword))
        {
            inlineKeyword = NextToken();
        }

        if (dataKeyword != null && Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "inline")
        {
            Diagnostics.ReportInlineCannotBeCombinedWithData(Current.Location);
            inlineKeyword = NextToken();
        }

        if (inlineKeyword != null && Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "data")
        {
            Diagnostics.ReportInlineCannotBeCombinedWithData(inlineKeyword.Location);
            dataKeyword = NextToken();
        }

        // Phase 3.B.3 sub-step 3: optional `open` modifier on a class
        // declaration. Per ADR-0017, plain `class` is sealed; `open class`
        // can be subclassed. `open` before `struct` is diagnosed in the
        // struct parser (structs cannot be subclassed in CLR).
        SyntaxToken openModifier = null;
        if (Current.Kind == SyntaxKind.OpenKeyword && (Peek(1).Kind == SyntaxKind.ClassKeyword || Peek(1).Kind == SyntaxKind.StructKeyword || Peek(1).Kind == SyntaxKind.EnumKeyword || (Peek(1).Kind == SyntaxKind.IdentifierToken && (Peek(1).Text == "record" || Peek(1).Text == "inline"))))
        {
            openModifier = NextToken();
        }

        if (openModifier != null && Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "inline")
        {
            inlineKeyword = NextToken();
        }

        // Phase 3.B.5: optional `sealed` modifier on an interface declaration.
        // `sealed interface` restricts implementors to the same package
        // (binder enforced). `sealed` is not legal on struct/class in Phase 3.
        SyntaxToken sealedModifier = null;
        if (Current.Kind == SyntaxKind.SealedKeyword && (Peek(1).Kind == SyntaxKind.InterfaceKeyword || Peek(1).Kind == SyntaxKind.EnumKeyword || (Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(1).Text == "record")))
        {
            sealedModifier = NextToken();
        }

        if (dataKeyword != null && Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "record")
        {
            Diagnostics.ReportRecordCannotBeCombinedWithDataKeyword(dataKeyword.Location);
            if (Peek(1).Kind == SyntaxKind.OpenBraceToken)
            {
                var recordToken = NextToken();
                preconsumedStructOrClassKeyword = new SyntaxToken(syntaxTree, SyntaxKind.StructKeyword, recordToken.Position, "struct", null);
            }
        }

        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "record" && Peek(1).Kind == SyntaxKind.OpenBraceToken)
        {
            dataKeyword = NextToken();
            preconsumedStructOrClassKeyword = new SyntaxToken(syntaxTree, SyntaxKind.StructKeyword, dataKeyword.Position, "struct", null);
        }

        if (Current.Kind == SyntaxKind.StructKeyword || Current.Kind == SyntaxKind.ClassKeyword || preconsumedStructOrClassKeyword != null)
        {
            if (sealedModifier != null)
            {
                Diagnostics.ReportUnexpectedToken(sealedModifier.Location, SyntaxKind.SealedKeyword, SyntaxKind.InterfaceKeyword);
            }

            var structDecl = ParseStructDeclaration(accessibilityModifier, typeKeyword, identifier, dataKeyword, inlineKeyword, openModifier, preconsumedStructOrClassKeyword);
            structDecl.TypeParameterList = typeParameterList;
            return structDecl;
        }

        if (Current.Kind == SyntaxKind.EnumKeyword)
        {
            if (sealedModifier != null)
            {
                Diagnostics.ReportUnexpectedToken(sealedModifier.Location, SyntaxKind.SealedKeyword, SyntaxKind.InterfaceKeyword);
            }

            if (openModifier != null)
            {
                Diagnostics.ReportUnexpectedToken(openModifier.Location, SyntaxKind.OpenKeyword, SyntaxKind.ClassKeyword);
            }

            if (dataKeyword != null)
            {
                Diagnostics.ReportUnexpectedToken(dataKeyword.Location, SyntaxKind.IdentifierToken, SyntaxKind.StructKeyword);
            }

            if (typeParameterList != null)
            {
                Diagnostics.ReportUnexpectedToken(typeParameterList.OpenBracketToken.Location, SyntaxKind.OpenSquareBracketToken, SyntaxKind.EnumKeyword);
            }

            return ParseEnumDeclaration(accessibilityModifier, typeKeyword, identifier);
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

            // Phase 4.3c / ADR-0020/0021: generic interfaces. The type-parameter
            // list (if any) is now forwarded into ParseInterfaceDeclaration.
            return ParseInterfaceDeclaration(accessibilityModifier, typeKeyword, identifier, typeParameterList, sealedModifier);
        }

        if (sealedModifier != null)
        {
            Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.InterfaceKeyword);
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
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            nodesAndSeparators.Add(new EnumMemberSyntax(syntaxTree, identifier));

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
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

        if (inlineKeyword != null && structOrClassKeyword.Kind != SyntaxKind.StructKeyword)
        {
            Diagnostics.ReportUnexpectedToken(inlineKeyword.Location, SyntaxKind.IdentifierToken, SyntaxKind.StructKeyword);
        }

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
            if (structOrClassKeyword.Kind != SyntaxKind.ClassKeyword && inlineKeyword == null)
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

        SyntaxToken openBrace;
        var fields = ImmutableArray.CreateBuilder<FieldDeclarationSyntax>();
        var methods = ImmutableArray.CreateBuilder<FunctionDeclarationSyntax>();
        if (inlineKeyword != null && Current.Kind != SyntaxKind.OpenBraceToken)
        {
            openBrace = new SyntaxToken(syntaxTree, SyntaxKind.OpenBraceToken, Current.Position, "{", null);
            var syntheticCloseBrace = new SyntaxToken(syntaxTree, SyntaxKind.CloseBraceToken, Current.Position, "}", null);
            return new StructDeclarationSyntax(
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
                methods.ToImmutable(),
                syntheticCloseBrace);
        }

        openBrace = MatchToken(SyntaxKind.OpenBraceToken);

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
            typeParameterList,
            sealedModifier,
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

        var identifier = MatchOperatorOrIdentifier(receiver != null);
        var typeParameterList = ParseOptionalTypeParameterList();
        var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseParameterList();
        var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);
        var type = ParseOptionalTypeClause();
        var body = ParseBlockStatement();
        return new FunctionDeclarationSyntax(syntaxTree, accessibilityModifier, openModifier, overrideModifier, asyncModifier, functionKeyword, receiverOpenParen, receiver, receiverCloseParen, identifier, typeParameterList, openParenthesisToken, parameters, closeParenthesisToken, type, body);
    }

    // Stream D: `func (a Point) operator +(b Point) Point { … }`. After the
    // optional receiver clause, if the current token is the contextual
    // `operator` keyword we consume it and the following operator token, then
    // synthesize an IdentifierToken whose text is the CLR op_* name (e.g.
    // `op_Addition`). Downstream binding sees a regular extension function with
    // that name; the binder later hooks `BindBinaryExpression` /
    // `BindUnaryExpression` to look up `op_*` on the user type's symbol.
    private SyntaxToken MatchOperatorOrIdentifier(bool hasReceiver)
    {
        if (Current.Kind != SyntaxKind.OperatorKeyword)
        {
            return MatchToken(SyntaxKind.IdentifierToken);
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
        // `[ Ident (Ident)? ( , ... )* ]`. Crucially the *first* token after `[`
        // is an identifier (not a number, ']', or another '['). That alone is
        // enough to disambiguate against `[]T` (slice) and `[N]T` (array shape)
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
        var ahead = 2;
        while (Peek(ahead).Kind == SyntaxKind.IdentifierToken)
        {
            ahead++;
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
        if (Current.Kind == SyntaxKind.IdentifierToken)
        {
            constraint = NextToken();
        }

        return new TypeParameterSyntax(syntaxTree, variance, identifier, constraint);
    }

    private bool LooksLikeReceiverClause()
    {
        // Expecting: '(' ident <type-clause> ')' ident '('
        // type-clause is either a single identifier or '[' [number] ']' ident.
        if (Peek(0).Kind != SyntaxKind.OpenParenthesisToken)
        {
            return false;
        }

        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        var ahead = 2;
        if (Peek(ahead).Kind == SyntaxKind.OpenSquareBracketToken)
        {
            ahead++;
            if (Peek(ahead).Kind == SyntaxKind.NumberToken)
            {
                ahead++;
            }

            if (Peek(ahead).Kind != SyntaxKind.CloseSquareBracketToken)
            {
                return false;
            }

            ahead++;
            if (Peek(ahead).Kind != SyntaxKind.IdentifierToken)
            {
                return false;
            }

            ahead++;
        }
        else if (Peek(ahead).Kind == SyntaxKind.IdentifierToken)
        {
            ahead++;
        }
        else
        {
            return false;
        }

        if (Peek(ahead).Kind != SyntaxKind.CloseParenthesisToken)
        {
            return false;
        }

        ahead++;
        if (Peek(ahead).Kind != SyntaxKind.IdentifierToken && Peek(ahead).Kind != SyntaxKind.OperatorKeyword)
        {
            return false;
        }

        ahead++;

        // Stream D: `operator <op>(` follows the receiver clause for operator
        // overloads. Accept any non-`(`/non-EOF token after `operator` here —
        // the operator-token validation happens in MatchOperatorOrIdentifier.
        if (Peek(ahead - 1).Kind == SyntaxKind.OperatorKeyword)
        {
            return Peek(ahead).Kind != SyntaxKind.EndOfFileToken
                && Peek(ahead + 1).Kind == SyntaxKind.OpenParenthesisToken;
        }

        return Peek(ahead).Kind == SyntaxKind.OpenParenthesisToken;
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
        SyntaxToken ellipsis = null;
        if (Current.Kind == SyntaxKind.EllipsisToken)
        {
            ellipsis = MatchToken(SyntaxKind.EllipsisToken);
        }

        var type = ParseTypeClause();
        return new ParameterSyntax(syntaxTree, identifier, ellipsis, type);
    }

    private TypeClauseSyntax ParseTypeClause()
    {
        if (Current.Kind == SyntaxKind.FuncKeyword)
        {
            return ParseFunctionTypeClause();
        }

        if (Current.Kind == SyntaxKind.OpenParenthesisToken)
        {
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
            var arrayQuestion = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
            return new TypeClauseSyntax(syntaxTree, openBracket, length, closeBracket, elementIdentifier, arrayQuestion);
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);

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
            typeArgOpen,
            typeArgs,
            typeArgClose,
            question);
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
        // Phase 3.A.4: map type clause `map[K]V` with optional trailing `?`.
        var mapKeyword = MatchToken(SyntaxKind.MapKeyword);
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var keyType = ParseTypeClause();
        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        var valueType = ParseTypeClause();
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return new TypeClauseSyntax(syntaxTree, mapKeyword, openBracket, keyType, closeBracket, valueType, question);
    }

    private TypeClauseSyntax ParseChanTypeClause()
    {
        // Phase 5.4 / ADR-0022: channel type clause `chan T` with optional trailing `?`.
        var chanKeyword = MatchToken(SyntaxKind.ChanKeyword);
        var elementType = ParseTypeClause();
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return new TypeClauseSyntax(syntaxTree, chanKeyword, elementType, question);
    }

    private TypeClauseSyntax ParseFunctionTypeClause()
    {
        // Phase 4.7: function type clause `func(T1, T2, ...) R?`. The return
        // type is optional; if absent the function returns void.
        var funcKeyword = MatchToken(SyntaxKind.FuncKeyword);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        while (Current.Kind != SyntaxKind.CloseParenthesisToken &&
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

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var returnTypeClause = ParseOptionalTypeClause();
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return new TypeClauseSyntax(
            syntaxTree,
            funcKeyword,
            openParen,
            new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
            closeParen,
            returnTypeClause,
            question);
    }

    private TypeClauseSyntax ParseOptionalTypeClause()
    {
        if (Current.Kind != SyntaxKind.IdentifierToken &&
            Current.Kind != SyntaxKind.OpenSquareBracketToken &&
            Current.Kind != SyntaxKind.OpenParenthesisToken &&
            Current.Kind != SyntaxKind.FuncKeyword &&
            Current.Kind != SyntaxKind.MapKeyword)
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

                goto default;
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

                return ParseExpressionOrChannelSendStatement();
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

        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeClause = ParseOptionalTypeClause();
        var equals = MatchToken(SyntaxKind.EqualsToken);
        var initializer = ParseExpression();
        return new VariableDeclarationSyntax(syntaxTree, accessibilityModifier, keyword, identifier, typeClause, equals, initializer);
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
        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        int o = 2;
        if (Peek(o).Kind == SyntaxKind.CommaToken)
        {
            if (Peek(o + 1).Kind != SyntaxKind.IdentifierToken)
            {
                return false;
            }

            o += 2;
        }

        if (Peek(o).Kind == SyntaxKind.IdentifierToken && Peek(o).Text == "in")
        {
            return true;
        }

        if (Peek(o).Kind != SyntaxKind.ColonEqualsToken)
        {
            return false;
        }

        return Peek(o + 1).Kind == SyntaxKind.RangeKeyword;
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
            colonEqualsToken = MatchToken(SyntaxKind.ColonEqualsToken);
            rangeKeyword = MatchToken(SyntaxKind.RangeKeyword);
        }

        var collection = ParseExpression();
        var body = ParseStatement();
        return new ForRangeStatementSyntax(syntaxTree, keyword, firstIdentifier, commaToken, secondIdentifier, colonEqualsToken, rangeKeyword, inToken, collection, body);
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
        ExpressionSyntax expression = null;
        if (sameLine)
        {
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
        var value = ParsePattern();
        var caseBody = ParseBlockStatement();
        return new SwitchCaseSyntax(syntaxTree, caseKeyword, value, caseBody);
    }

    private PatternSyntax ParsePattern()
    {
        switch (Current.Kind)
        {
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
        // Phase 5.8 / ADR-0023 legacy `await for v := range stream { … }`.
        // Phase 7.2 adds canonical `await for v in stream { … }` with `in`
        // parsed as a contextual identifier token.
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
        }

        var stream = ParseExpression();
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

        // case v := <-ch { ... } — receive, bind.
        if (Current.Kind == SyntaxKind.IdentifierToken &&
            Peek(1).Kind == SyntaxKind.ColonEqualsToken &&
            Peek(2).Kind == SyntaxKind.LeftArrowToken)
        {
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            MatchToken(SyntaxKind.ColonEqualsToken);
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

    private ExpressionStatementSyntax ParseExpressionStatement()
    {
        var expression = ParseExpression();
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

        // Phase 3.C.3 / ADR-0001: postfix null-assertion `!!`. We greedily
        // consume any chain of `!!` tokens immediately following the primary
        // and wrap them as unary expressions. The binder enforces that the
        // operand type is nullable (or carries it through harmlessly).
        while (Current.Kind == SyntaxKind.BangBangToken)
        {
            var bangBangToken = NextToken();
            left = new UnaryExpressionSyntax(syntaxTree, bangBangToken, left);
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
                return ParseParenthesizedExpression();

            case SyntaxKind.FalseKeyword:
            case SyntaxKind.TrueKeyword:
                return ParseBooleanLiteral();

            case SyntaxKind.NilKeyword:
                return ParseNilLiteral();

            case SyntaxKind.NumberToken:
                return ParseNumberLiteral();

            case SyntaxKind.StringToken:
                return ParseStringLiteral();

            case SyntaxKind.InterpolatedStringToken:
                return ParseInterpolatedStringLiteral();

            case SyntaxKind.OpenSquareBracketToken:
                return ParseArrayCreationExpression();

            case SyntaxKind.MapKeyword:
                return ParseMapCreationExpression();

            case SyntaxKind.FuncKeyword:
                return ParseFunctionLiteralExpression();

            case SyntaxKind.SwitchKeyword:
                return ParseSwitchExpression();

            case SyntaxKind.IdentifierToken:
            default:
                return ParseNameOrCallExpression();
        }
    }

    private ExpressionSyntax ParseFunctionLiteralExpression()
    {
        // Phase 4.7: function literal `func(p1 T1, p2 T2) R { body }`.
        var funcKeyword = MatchToken(SyntaxKind.FuncKeyword);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseParameterList();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var returnType = ParseOptionalTypeClause();
        var body = ParseBlockStatement();
        return new FunctionLiteralExpressionSyntax(syntaxTree, funcKeyword, openParen, parameters, closeParen, returnType, body);
    }

    private ExpressionSyntax ParseSwitchExpression()
    {
        var switchKeyword = MatchToken(SyntaxKind.SwitchKeyword);
        var expression = ParseExpression();
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
            var defaultArrow = MatchToken(SyntaxKind.RightArrowToken);
            var defaultResult = ParseExpression();
            return new SwitchExpressionArmSyntax(syntaxTree, defaultKeyword, value: null, defaultArrow, defaultResult);
        }

        var caseKeyword = MatchToken(SyntaxKind.CaseKeyword);
        var value = ParsePattern();
        var arrow = MatchToken(SyntaxKind.RightArrowToken);
        var result = ParseExpression();
        return new SwitchExpressionArmSyntax(syntaxTree, caseKeyword, value, arrow, result);
    }

    private ExpressionSyntax ParseMapCreationExpression()
    {
        // Phase 3.A.4: map literal `map[K]V{k1: v1, k2: v2, …}`.
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
        if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "make"
            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken
            && Peek(2).Kind == SyntaxKind.ChanKeyword)
        {
            // Phase 5.4 / ADR-0022: contextual `make(chan T)` / `make(chan T, capacity)`.
            current = ParseMakeChannelExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            current = ParseCallExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken
            && LooksLikeGenericCallSite(1))
        {
            current = ParseGenericCallExpression();
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
            if (Current.Kind == SyntaxKind.DotToken || Current.Kind == SyntaxKind.QuestionDotToken)
            {
                var dotToken = NextToken();
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

    // Phase 4.1 / ADR-0020: bounded-lookahead disambiguation between
    // `name [ expr ]` (indexing) and `name [ TypeClause, ... ] ( args )`
    // (generic instantiation followed by call). `bracketOffset` is the
    // offset of the `[` token relative to Current.
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

        // Follow-set per ADR-0020: '(' (call), '{' (composite literal), '.' (member access).
        var nextKind = Peek(pos).Kind;
        return nextKind == SyntaxKind.OpenParenthesisToken
            || nextKind == SyntaxKind.OpenBraceToken
            || nextKind == SyntaxKind.DotToken;
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
        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
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
        // Only `func(...) {...}` (a function LITERAL) attaches as a trailing
        // lambda; `func Name(...)` (a function DECLARATION) must stay as the
        // following statement-level declaration.
        if (Current.Kind != SyntaxKind.FuncKeyword
            || Peek(1).Kind != SyntaxKind.OpenParenthesisToken)
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
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNextArgument = true;
        while (parseNextArgument &&
               Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            ExpressionSyntax expression;
            if (Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.EqualsToken)
            {
                var name = MatchToken(SyntaxKind.IdentifierToken);
                var equals = MatchToken(SyntaxKind.EqualsToken);
                var value = ParseExpression();
                expression = new NamedArgumentExpressionSyntax(syntaxTree, name, equals, value);
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
        var expression = ParseExpression();

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
