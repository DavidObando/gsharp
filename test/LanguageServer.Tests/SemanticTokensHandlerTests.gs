// <copyright file="SemanticTokensHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Immutable
import System.Linq
import Xunit

open class SemanticTokensHandlerTests {
    @Theory
    @InlineData(`u8"$name"`, 9)
    @InlineData(`u8"é😀"`, 7)
    func Tokenize_Utf8LiteralRangeAndFollowingIdentifier(literal string, length int32) {
        let content = LanguageServerTestHelpers.Content(
            "func Run() {\n    let view = " + literal + "\n    let count = view.Length\n}\n"
        )
        let tokens = GetTokens(content)
        let text = FindToken(tokens, 1, 15, length)
        Assert.NotNull(text)
        Assert.Equal(TokenTypeIndex("String"), text!!.TokenType)
        let reference = FindToken(tokens, 2, 16, 4)
        Assert.NotNull(reference)
        Assert.Equal(TokenTypeIndex("Variable"), reference!!.TokenType)
    }

    @Fact
    func Tokenize_ContextualNativeProtocolHeadAndOrdinaryIdentifier() {
        let content = LanguageServerTestHelpers.Content(
            "protocol P { func Read() int32; }\nfunc use(protocol int32) int32 -> protocol\n"
        )
        let tokens = GetTokens(content)
        Assert.Null(FindToken(tokens, 0, 0, 8))
        let declaration = FindToken(tokens, 0, 9, 1)
        Assert.NotNull(declaration)
        Assert.Equal(TokenTypeIndex("Interface"), declaration!!.TokenType)
        let parameter = FindToken(tokens, 1, 9, 8)
        Assert.NotNull(parameter)
        Assert.Equal(TokenTypeIndex("Parameter"), parameter!!.TokenType)
    }

    @Fact
    func Tokenize_DoesNotClassifyKeywords() {
        const source = "var x = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        // Keywords are intentionally left to the TextMate grammar so their color
        // stays stable across the LSP handshake. "var" must NOT be emitted as a
        // semantic token.
        let varToken = FindToken(tokens, 0, 0, 3)
        Assert.Null(varToken)
    }

    @Fact
    func Tokenize_ClassifiesNumberLiterals() {
        const source = "var x = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        // "42" should be classified as number (index 14)
        let numToken = FindToken(tokens, 0, 8, 2)
        Assert.NotNull(numToken)
        Assert.Equal(TokenTypeIndex("Number"), numToken!!.TokenType)
    }

    @Fact
    func Tokenize_ClassifiesStringLiterals() {
        const source = "var s = \"hello\"\n"
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        // "hello" string should be classified as string (index 13)
        let strToken = FindToken(tokens, 0, 8, 7)
        Assert.NotNull(strToken)
        Assert.Equal(TokenTypeIndex("String"), strToken!!.TokenType)
    }

    @Fact
    func Tokenize_ClassifiesFunctionDeclaration() {
        const source = "func add(a int32, b int32) int32 { return a + b }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        // "func" keyword is left to the TextMate grammar — no semantic token.
        let funcKeyword = FindToken(tokens, 0, 0, 4)
        Assert.Null(funcKeyword)
        // "add" identifier should be Function with Declaration modifier
        let addToken = FindToken(tokens, 0, 5, 3)
        Assert.NotNull(addToken)
        Assert.Equal(TokenTypeIndex("Function"), addToken!!.TokenType)
        Assert.True((addToken!!.TokenModifiers & ModifierBit("Declaration")) != 0)
    }

    @Fact
    func Tokenize_ClassifiesParameters() {
        const source = "func add(a int32, b int32) int32 { return a + b }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        // "a" parameter declaration
        let aDecl = FindToken(tokens, 0, 9, 1)
        Assert.NotNull(aDecl)
        Assert.Equal(TokenTypeIndex("Parameter"), aDecl!!.TokenType)
    }

    @Fact
    func Tokenize_ClassifiesVariableReferences() {
        const source = `var x = 10
var y = x
`
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        // "x" at line 0 col 4 is a declaration
        let xDecl = FindToken(tokens, 0, 4, 1)
        Assert.NotNull(xDecl)
        Assert.Equal(TokenTypeIndex("Variable"), xDecl!!.TokenType)
        Assert.True((xDecl!!.TokenModifiers & ModifierBit("Declaration")) != 0)
        // "x" at line 1 col 8 is a reference
        let xRef = FindToken(tokens, 1, 8, 1)
        Assert.NotNull(xRef)
        Assert.Equal(TokenTypeIndex("Variable"), xRef!!.TokenType)
        Assert.Equal(0, xRef!!.TokenModifiers)
    }

    @Fact
    func Tokenize_ClassifiesVarPatternDeclarationAndReference() {
        const source = "func use(value object?) bool {\n" +
            "  if value is var captured && captured == nil {\n" +
            "    return true\n" +
            "  }\n" +
            "  return false\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        let patternLine = source.Split('\n')[1]
        let declarationColumn = patternLine.IndexOf("captured", StringComparison.Ordinal)
        let referenceColumn = patternLine.LastIndexOf("captured", StringComparison.Ordinal)
        let declaration = FindToken(tokens, 1, declarationColumn, "captured".Length)
        Assert.NotNull(declaration)
        Assert.Equal(TokenTypeIndex("Variable"), declaration!!.TokenType)
        Assert.True((declaration!!.TokenModifiers & ModifierBit("Declaration")) != 0)
        let reference = FindToken(tokens, 1, referenceColumn, "captured".Length)
        Assert.NotNull(reference)
        Assert.Equal(TokenTypeIndex("Variable"), reference!!.TokenType)
        Assert.Equal(0, reference!!.TokenModifiers)
    }

    @Fact
    func Tokenize_ClassifiesStructDeclaration() {
        const source = `struct Point {
    var X int32
    var Y int32
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        // ADR-0078: the `struct` keyword IS the declaration head, but keywords
        // are left to the TextMate grammar, so it emits no semantic token.
        let structKeyword = FindToken(tokens, 0, 0, 6)
        Assert.Null(structKeyword)
        // "Point" should be Struct with Declaration (position 7, length 5).
        let pointToken = FindToken(tokens, 0, 7, 5)
        Assert.NotNull(pointToken)
        Assert.Equal(TokenTypeIndex("Struct"), pointToken!!.TokenType)
        Assert.True((pointToken!!.TokenModifiers & ModifierBit("Declaration")) != 0)
    }

    @Fact
    func Tokenize_ClassifiesComments() {
        const source = `// this is a comment
var x = 1
`
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        // Comment token on line 0 — find any token at (0, 0)
        let commentToken = tokens.Cast[DecodedToken?]().FirstOrDefault(
            (t DecodedToken?) -> t!!.Line == 0 && t!!.Character == 0
        )
        Assert.NotNull(commentToken)
        Assert.Equal(TokenTypeIndex("Comment"), commentToken!!.TokenType)
    }

    @Fact
    func Tokenize_EmptySource_ProducesNoTokens() {
        const source = ""
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        Assert.Empty(tokens)
    }

    @Fact
    func Tokenize_InterpolatedString_ClassifiesHoleIdentifierAsCode() {
        const source = `var name = "x"
var s = "hi $name end"
`
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        // The hole identifier "name" (line 1, col 13, length 4) is classified as a variable reference,
        // not as part of the surrounding String literal.
        let nameRef = FindToken(tokens, 1, 13, 4)
        Assert.NotNull(nameRef)
        Assert.Equal(TokenTypeIndex("Variable"), nameRef!!.TokenType)
        // The literal text before the hole ("hi $) is String filler.
        let leading = FindToken(tokens, 1, 8, 5)
        Assert.NotNull(leading)
        Assert.Equal(TokenTypeIndex("String"), leading!!.TokenType)
        // The literal text after the hole ( end") is String filler.
        let trailing = FindToken(tokens, 1, 17, 5)
        Assert.NotNull(trailing)
        Assert.Equal(TokenTypeIndex("String"), trailing!!.TokenType)
    }

    @Fact
    func Tokenize_InterpolatedString_ClassifiesBracedHoleExpression() {
        const source = `var n = 1
var s = "v=${n + 2}!"
`
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        // "n" inside ${n + 2} is a variable reference.
        // Line 1: var s = "v=${n + 2}!"  -> '"' at col 8, "v=" 9-10, "${" 11-12, 'n' at col 13.
        let nRef = FindToken(tokens, 1, 13, 1)
        Assert.NotNull(nRef)
        Assert.Equal(TokenTypeIndex("Variable"), nRef!!.TokenType)
        // "2" inside the hole is a number literal (col 17).
        let num = FindToken(tokens, 1, 17, 1)
        Assert.NotNull(num)
        Assert.Equal(TokenTypeIndex("Number"), num!!.TokenType)
    }

    @Fact
    func Tokenize_InterpolatedString_DoesNotPaintHoleCodeAsString() {
        // Regression: inside ${...}, operators/punctuation/member-access must NOT be classified as
        // String filler (only the literal text and the ${ } / $ delimiters are String); the in-hole
        // code is left to the TextMate grammar so a method call is colored as code, not string.
        const source = `import System
var a = 1
var s = "a: ${a.GetType()}"
`
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        // Line 2: var s = "a: ${a.GetType()}"  -> '"' at 8, "a: " 9-11, "${" 12-13, 'a' 14,
        // '.' 15, "GetType" 16-22, '(' 23, ')' 24, '}' 25, '"' 26.
        let stringIndex = TokenTypeIndex("String")
        // No String token may cover any column in the method-call region [15, 25).
        for token in tokens.Where((t DecodedToken) -> t.Line == 2 && t.TokenType == stringIndex) {
            let start = token.Character
            let end = token.Character + token.Length
            Assert.False(start < 25 && end > 15, "String token [$start,$end) overlaps in-hole code region [15,25).")
        }
        // The hole identifier "a" is still classified as a variable.
        let aRef = FindToken(tokens, 2, 14, 1)
        Assert.NotNull(aRef)
        Assert.Equal(TokenTypeIndex("Variable"), aRef!!.TokenType)
    }

    @Fact
    func Tokenize_InterpolatedStringInClassMethodWithSharedBlock_ClassifiesHole() {
        // Regression: a class declaration that includes a `shared { … }` block previously caused
        // SyntaxNode.Span (reflection-based first/last child) to truncate the struct's span to the
        // end of the shared block's closing brace, because SharedBlock was enumerated last by
        // reflection (it is declared as `{ get; set; }` after CloseBraceToken). That truncation
        // hid descendants of the struct from position-based traversals, including the language
        // server's interpolated-string hole detection — collapsing the whole literal into a
        // single String token with no hole highlighting.
        const source = "class Person {\n" +
            "    shared {\n" +
            "        prop CallCount int32\n" +
            "    }\n" +
            "    public prop Name string\n" +
            "    public prop Age int32\n" +
            "    func ToString() string {\n" +
            "        return \"Name: $${Name}, Age: $${this.Age}\"\n" +
            "    }\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = GetTokens(content)
        // Line 7 holds: `        return "Name: ${Name}, Age: ${this.Age}"`.
        // "Name" hole identifier sits at column 24, length 4.
        let nameHole = FindToken(tokens, 7, 24, 4)
        Assert.NotNull(nameHole)
        Assert.Equal(TokenTypeIndex("Property"), nameHole!!.TokenType)
        // String filler must exist between the two holes; it must NOT cover the hole identifier
        // region. The text `}, Age: ${` sits at columns 28..37 (length 10).
        let middleFiller = FindToken(tokens, 7, 28, 10)
        Assert.NotNull(middleFiller)
        Assert.Equal(TokenTypeIndex("String"), middleFiller!!.TokenType)
        // No single String token may cover the entire literal — that is the bug signature.
        let stringIndex = TokenTypeIndex("String")
        let literalStart = 15 // column of the opening quote on line 7
        Assert.DoesNotContain(
            tokens,
            (t DecodedToken) -> t.Line == 7 &&
                t.TokenType == stringIndex &&
                t.Character == literalStart &&
                t.Length > 10
        )
    }

    private data struct DecodedToken(
        Line int32,
        Character int32,
        Length int32,
        TokenType int32,
        TokenModifiers int32
    ) : IEquatable[DecodedToken] { }

    shared {
        private func TokenTypeIndex(name string) int32 {
            for var i = 0; i < SemanticTokensHandler.TokenTypes.Length; i++ {
                if SemanticTokensHandler.TokenTypes[i] == SemanticTokenType(name.ToLowerInvariant()) {
                    return i
                }
            }
            return -1
        }

        private func ModifierBit(name string) int32 {
            for var i = 0; i < SemanticTokensHandler.TokenModifiers.Length; i++ {
                if SemanticTokensHandler.TokenModifiers[i] == SemanticTokenModifier(name.ToLowerInvariant()) {
                    return 1 << i
                }
            }
            return 0
        }

        private func GetTokens(content DocumentContent) ImmutableArray[DecodedToken] {
            let document = SemanticTokensDocument(SemanticTokensHandler.Legend)
            let builder = document.Create()
            SemanticTokensComputer.Tokenize(builder, content)
            builder.Commit()
            let result = document.GetSemanticTokens()
            return DecodeTokens(result.Data)
        }

        private func DecodeTokens(data ImmutableArray[int32]) ImmutableArray[DecodedToken] {
            let tokens = ImmutableArray.CreateBuilder[DecodedToken]()
            var line = 0
            var character = 0
            for var i = 0; i + 4 < data.Length; i += 5 {
                let deltaLine = data[i]
                let deltaChar = data[i + 1]
                let length = data[i + 2]
                let tokenType = data[i + 3]
                let tokenModifiers = data[i + 4]
                if deltaLine > 0 {
                    line += deltaLine
                    character = deltaChar
                } else {
                    character += deltaChar
                }
                tokens.Add(DecodedToken(line, character, length, tokenType, tokenModifiers))
            }
            return tokens.ToImmutable()
        }

        private func FindToken(
            tokens ImmutableArray[DecodedToken],
            line int32,
            character int32,
            length int32
        ) DecodedToken? {
            return tokens.Cast[DecodedToken?]().FirstOrDefault(
                (t DecodedToken?) -> t!!.Line == line && t!!.Character == character && t!!.Length == length
            )
        }
    }
}
