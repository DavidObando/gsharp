// <copyright file="SemanticTokensHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using OmniSharp.Extensions.LanguageServer.Protocol.Document;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
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

