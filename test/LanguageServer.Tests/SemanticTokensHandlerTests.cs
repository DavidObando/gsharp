// <copyright file="SemanticTokensHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class SemanticTokensHandlerTests
{
    [Fact]
    public void Tokenize_ClassifiesKeywords()
    {
        const string source = "var x = 42\n";
        var content = LanguageServerTestHelpers.Content(source);
        var tokens = GetTokens(content);

        // "var" should be classified as keyword (index 12)
        var varToken = FindToken(tokens, 0, 0, 3);
        Assert.NotNull(varToken);
        Assert.Equal(TokenTypeIndex("Keyword"), varToken.Value.TokenType);
    }

    [Fact]
    public void Tokenize_ClassifiesNumberLiterals()
    {
        const string source = "var x = 42\n";
        var content = LanguageServerTestHelpers.Content(source);
        var tokens = GetTokens(content);

        // "42" should be classified as number (index 14)
        var numToken = FindToken(tokens, 0, 8, 2);
        Assert.NotNull(numToken);
        Assert.Equal(TokenTypeIndex("Number"), numToken.Value.TokenType);
    }

    [Fact]
    public void Tokenize_ClassifiesStringLiterals()
    {
        const string source = "var s = \"hello\"\n";
        var content = LanguageServerTestHelpers.Content(source);
        var tokens = GetTokens(content);

        // "hello" string should be classified as string (index 13)
        var strToken = FindToken(tokens, 0, 8, 7);
        Assert.NotNull(strToken);
        Assert.Equal(TokenTypeIndex("String"), strToken.Value.TokenType);
    }

    [Fact]
    public void Tokenize_ClassifiesFunctionDeclaration()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\n";
        var content = LanguageServerTestHelpers.Content(source);
        var tokens = GetTokens(content);

        // "func" keyword
        var funcKeyword = FindToken(tokens, 0, 0, 4);
        Assert.NotNull(funcKeyword);
        Assert.Equal(TokenTypeIndex("Keyword"), funcKeyword.Value.TokenType);

        // "add" identifier should be Function with Declaration modifier
        var addToken = FindToken(tokens, 0, 5, 3);
        Assert.NotNull(addToken);
        Assert.Equal(TokenTypeIndex("Function"), addToken.Value.TokenType);
        Assert.True((addToken.Value.TokenModifiers & ModifierBit("Declaration")) != 0);
    }

    [Fact]
    public void Tokenize_ClassifiesParameters()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\n";
        var content = LanguageServerTestHelpers.Content(source);
        var tokens = GetTokens(content);

        // "a" parameter declaration
        var aDecl = FindToken(tokens, 0, 9, 1);
        Assert.NotNull(aDecl);
        Assert.Equal(TokenTypeIndex("Parameter"), aDecl.Value.TokenType);
    }

    [Fact]
    public void Tokenize_ClassifiesVariableReferences()
    {
        const string source = "var x = 10\nvar y = x\n";
        var content = LanguageServerTestHelpers.Content(source);
        var tokens = GetTokens(content);

        // "x" at line 0 col 4 is a declaration
        var xDecl = FindToken(tokens, 0, 4, 1);
        Assert.NotNull(xDecl);
        Assert.Equal(TokenTypeIndex("Variable"), xDecl.Value.TokenType);
        Assert.True((xDecl.Value.TokenModifiers & ModifierBit("Declaration")) != 0);

        // "x" at line 1 col 8 is a reference
        var xRef = FindToken(tokens, 1, 8, 1);
        Assert.NotNull(xRef);
        Assert.Equal(TokenTypeIndex("Variable"), xRef.Value.TokenType);
        Assert.Equal(0, xRef.Value.TokenModifiers);
    }

    [Fact]
    public void Tokenize_ClassifiesStructDeclaration()
    {
        const string source = "type Point struct {\n    X int32\n    Y int32\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var tokens = GetTokens(content);

        // "type" keyword
        var typeKeyword = FindToken(tokens, 0, 0, 4);
        Assert.NotNull(typeKeyword);
        Assert.Equal(TokenTypeIndex("Keyword"), typeKeyword.Value.TokenType);

        // "struct" keyword
        var structKeyword = FindToken(tokens, 0, 11, 6);
        Assert.NotNull(structKeyword);
        Assert.Equal(TokenTypeIndex("Keyword"), structKeyword.Value.TokenType);

        // "Point" should be Struct with Declaration (at position 5, length 5)
        var pointToken = FindToken(tokens, 0, 5, 5);
        Assert.NotNull(pointToken);
        Assert.Equal(TokenTypeIndex("Struct"), pointToken.Value.TokenType);
        Assert.True((pointToken.Value.TokenModifiers & ModifierBit("Declaration")) != 0);
    }

    [Fact]
    public void Tokenize_ClassifiesComments()
    {
        const string source = "// this is a comment\nvar x = 1\n";
        var content = LanguageServerTestHelpers.Content(source);
        var tokens = GetTokens(content);

        // Comment token on line 0 — find any token at (0, 0)
        var commentToken = tokens.Cast<DecodedToken?>().FirstOrDefault(t => t.Value.Line == 0 && t.Value.Character == 0);
        Assert.NotNull(commentToken);
        Assert.Equal(TokenTypeIndex("Comment"), commentToken.Value.TokenType);
    }

    [Fact]
    public void Tokenize_EmptySource_ProducesNoTokens()
    {
        const string source = "";
        var content = LanguageServerTestHelpers.Content(source);
        var tokens = GetTokens(content);

        Assert.Empty(tokens);
    }

    [Fact]
    public void Tokenize_InterpolatedString_ClassifiesHoleIdentifierAsCode()
    {
        const string source = "var name = \"x\"\nvar s = \"hi $name end\"\n";
        var content = LanguageServerTestHelpers.Content(source);
        var tokens = GetTokens(content);

        // The hole identifier "name" (line 1, col 13, length 4) is classified as a variable reference,
        // not as part of the surrounding String literal.
        var nameRef = FindToken(tokens, 1, 13, 4);
        Assert.NotNull(nameRef);
        Assert.Equal(TokenTypeIndex("Variable"), nameRef.Value.TokenType);

        // The literal text before the hole ("hi $) is String filler.
        var leading = FindToken(tokens, 1, 8, 5);
        Assert.NotNull(leading);
        Assert.Equal(TokenTypeIndex("String"), leading.Value.TokenType);

        // The literal text after the hole ( end") is String filler.
        var trailing = FindToken(tokens, 1, 17, 5);
        Assert.NotNull(trailing);
        Assert.Equal(TokenTypeIndex("String"), trailing.Value.TokenType);
    }

    [Fact]
    public void Tokenize_InterpolatedString_ClassifiesBracedHoleExpression()
    {
        const string source = "var n = 1\nvar s = \"v=${n + 2}!\"\n";
        var content = LanguageServerTestHelpers.Content(source);
        var tokens = GetTokens(content);

        // "n" inside ${n + 2} is a variable reference.
        // Line 1: var s = "v=${n + 2}!"  -> '"' at col 8, "v=" 9-10, "${" 11-12, 'n' at col 13.
        var nRef = FindToken(tokens, 1, 13, 1);
        Assert.NotNull(nRef);
        Assert.Equal(TokenTypeIndex("Variable"), nRef.Value.TokenType);

        // "2" inside the hole is a number literal (col 17).
        var num = FindToken(tokens, 1, 17, 1);
        Assert.NotNull(num);
        Assert.Equal(TokenTypeIndex("Number"), num.Value.TokenType);
    }

    [Fact]
    public void Tokenize_InterpolatedString_DoesNotPaintHoleCodeAsString()
    {
        // Regression: inside ${...}, operators/punctuation/member-access must NOT be classified as
        // String filler (only the literal text and the ${ } / $ delimiters are String); the in-hole
        // code is left to the TextMate grammar so a method call is colored as code, not string.
        const string source = "import System\nvar a = 1\nvar s = \"a: ${a.GetType()}\"\n";
        var content = LanguageServerTestHelpers.Content(source);
        var tokens = GetTokens(content);

        // Line 2: var s = "a: ${a.GetType()}"  -> '"' at 8, "a: " 9-11, "${" 12-13, 'a' 14,
        // '.' 15, "GetType" 16-22, '(' 23, ')' 24, '}' 25, '"' 26.
        var stringIndex = TokenTypeIndex("String");

        // No String token may cover any column in the method-call region [15, 25).
        foreach (var token in tokens.Where(t => t.Line == 2 && t.TokenType == stringIndex))
        {
            var start = token.Character;
            var end = token.Character + token.Length;
            Assert.False(start < 25 && end > 15, $"String token [{start},{end}) overlaps in-hole code region [15,25).");
        }

        // The hole identifier "a" is still classified as a variable.
        var aRef = FindToken(tokens, 2, 14, 1);
        Assert.NotNull(aRef);
        Assert.Equal(TokenTypeIndex("Variable"), aRef.Value.TokenType);
    }

    [Fact]
    public void Tokenize_InterpolatedStringInClassMethodWithSharedBlock_ClassifiesHole()
    {
        // Regression: a class declaration that includes a `shared { … }` block previously caused
        // SyntaxNode.Span (reflection-based first/last child) to truncate the struct's span to the
        // end of the shared block's closing brace, because SharedBlock was enumerated last by
        // reflection (it is declared as `{ get; set; }` after CloseBraceToken). That truncation
        // hid descendants of the struct from position-based traversals, including the language
        // server's interpolated-string hole detection — collapsing the whole literal into a
        // single String token with no hole highlighting.
        const string source =
            "type Person class {\n" +
            "    shared {\n" +
            "        prop CallCount int32\n" +
            "    }\n" +
            "    public prop Name string\n" +
            "    public prop Age int32\n" +
            "    func ToString() string {\n" +
            "        return \"Name: ${Name}, Age: ${this.Age}\"\n" +
            "    }\n" +
            "}\n";

        var content = LanguageServerTestHelpers.Content(source);
        var tokens = GetTokens(content);

        // Line 7 holds: `        return "Name: ${Name}, Age: ${this.Age}"`.
        // "Name" hole identifier sits at column 24, length 4.
        var nameHole = FindToken(tokens, 7, 24, 4);
        Assert.NotNull(nameHole);
        Assert.Equal(TokenTypeIndex("Property"), nameHole.Value.TokenType);

        // String filler must exist between the two holes; it must NOT cover the hole identifier
        // region. The text `}, Age: ${` sits at columns 28..37 (length 10).
        var middleFiller = FindToken(tokens, 7, 28, 10);
        Assert.NotNull(middleFiller);
        Assert.Equal(TokenTypeIndex("String"), middleFiller.Value.TokenType);

        // No single String token may cover the entire literal — that is the bug signature.
        var stringIndex = TokenTypeIndex("String");
        var literalStart = 15; // column of the opening quote on line 7
        Assert.DoesNotContain(
            tokens,
            t => t.Line == 7 && t.TokenType == stringIndex && t.Character == literalStart && t.Length > 10);
    }


    private static int TokenTypeIndex(string name)
    {
        for (var i = 0; i < SemanticTokensHandler.TokenTypes.Length; i++)
        {
            if (SemanticTokensHandler.TokenTypes[i] == new SemanticTokenType(name.ToLowerInvariant()))
            {
                return i;
            }
        }

        return -1;
    }

    private static int ModifierBit(string name)
    {
        for (var i = 0; i < SemanticTokensHandler.TokenModifiers.Length; i++)
        {
            if (SemanticTokensHandler.TokenModifiers[i] == new SemanticTokenModifier(name.ToLowerInvariant()))
            {
                return 1 << i;
            }
        }

        return 0;
    }

    private static ImmutableArray<DecodedToken> GetTokens(DocumentContent content)
    {
        var document = new SemanticTokensDocument(SemanticTokensHandler.Legend);
        var builder = document.Create();
        SemanticTokensComputer.Tokenize(builder, content);
        builder.Commit();
        var result = document.GetSemanticTokens();
        return DecodeTokens(result.Data);
    }

    private static ImmutableArray<DecodedToken> DecodeTokens(ImmutableArray<int> data)
    {
        var tokens = ImmutableArray.CreateBuilder<DecodedToken>();
        var line = 0;
        var character = 0;

        for (var i = 0; i + 4 < data.Length; i += 5)
        {
            var deltaLine = data[i];
            var deltaChar = data[i + 1];
            var length = data[i + 2];
            var tokenType = data[i + 3];
            var tokenModifiers = data[i + 4];

            if (deltaLine > 0)
            {
                line += deltaLine;
                character = deltaChar;
            }
            else
            {
                character += deltaChar;
            }

            tokens.Add(new DecodedToken(line, character, length, tokenType, tokenModifiers));
        }

        return tokens.ToImmutable();
    }

    private static DecodedToken? FindToken(ImmutableArray<DecodedToken> tokens, int line, int character, int length)
    {
        return tokens.Cast<DecodedToken?>().FirstOrDefault(t => t.Value.Line == line && t.Value.Character == character && t.Value.Length == length);
    }

    private readonly record struct DecodedToken(int Line, int Character, int Length, int TokenType, int TokenModifiers);
}

