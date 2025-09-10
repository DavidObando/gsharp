// <copyright file="DiagnosticBagTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis
{
    using System.Linq;
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;
    using GSharp.Core.CodeAnalysis.Text;
    using Xunit;

    public class DiagnosticBagTests
    {
        private static TextLocation CreateTestLocation(string content = "test content", int start = 0, int length = 4)
        {
            var sourceText = SourceText.From(content);
            var span = new TextSpan(start, length);
            return new TextLocation(sourceText, span);
        }

        [Fact]
        public void NewDiagnosticBag_IsEmpty()
        {
            // Act
            var diagnosticBag = new DiagnosticBag();

            // Assert
            diagnosticBag.Should().BeEmpty();
        }

        [Fact]
        public void AddRange_EmptyBag_RemainsEmpty()
        {
            // Arrange
            var bag1 = new DiagnosticBag();
            var bag2 = new DiagnosticBag();

            // Act
            bag1.AddRange(bag2);

            // Assert
            bag1.Should().BeEmpty();
        }

        [Fact]
        public void AddRange_BagWithDiagnostics_AddsAllDiagnostics()
        {
            // Arrange
            var bag1 = new DiagnosticBag();
            var bag2 = new DiagnosticBag();
            var location = CreateTestLocation();

            bag2.ReportBadCharacter(location, '?');
            bag2.ReportUnterminatedString(location);

            // Act
            bag1.AddRange(bag2);

            // Assert
            bag1.Should().HaveCount(2);
            bag1.Select(d => d.Message).Should().Contain("Bad character input: '?'.");
            bag1.Select(d => d.Message).Should().Contain("Unterminated string literal.");
        }

        [Fact]
        public void ReportBadCharacter_AddsCorrectDiagnostic()
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();
            const char badChar = '@';

            // Act
            diagnosticBag.ReportBadCharacter(location, badChar);

            // Assert
            diagnosticBag.Should().HaveCount(1);
            var diagnostic = diagnosticBag.First();
            diagnostic.Message.Should().Be("Bad character input: '@'.");
            diagnostic.Location.Should().Be(location);
        }

        [Fact]
        public void ReportUnterminatedComment_AddsCorrectDiagnostic()
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();

            // Act
            diagnosticBag.ReportUnterminatedComment(location);

            // Assert
            diagnosticBag.Should().HaveCount(1);
            var diagnostic = diagnosticBag.First();
            diagnostic.Message.Should().Be("Unterminated comment.");
            diagnostic.Location.Should().Be(location);
        }

        [Fact]
        public void ReportUnterminatedString_AddsCorrectDiagnostic()
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();

            // Act
            diagnosticBag.ReportUnterminatedString(location);

            // Assert
            diagnosticBag.Should().HaveCount(1);
            var diagnostic = diagnosticBag.First();
            diagnostic.Message.Should().Be("Unterminated string literal.");
            diagnostic.Location.Should().Be(location);
        }

        [Fact]
        public void ReportInvalidNumber_AddsCorrectDiagnostic()
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();
            const string invalidNumber = "123abc";
            var expectedType = TypeSymbol.Int;

            // Act
            diagnosticBag.ReportInvalidNumber(location, invalidNumber, expectedType);

            // Assert
            diagnosticBag.Should().HaveCount(1);
            var diagnostic = diagnosticBag.First();
            diagnostic.Message.Should().Be("The number 123abc isn't valid int.");
            diagnostic.Location.Should().Be(location);
        }

        [Fact]
        public void ReportUnexpectedToken_AddsCorrectDiagnostic()
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();
            const SyntaxKind actual = SyntaxKind.NumberToken;
            const SyntaxKind expected = SyntaxKind.IdentifierToken;

            // Act
            diagnosticBag.ReportUnexpectedToken(location, actual, expected);

            // Assert
            diagnosticBag.Should().HaveCount(1);
            var diagnostic = diagnosticBag.First();
            diagnostic.Message.Should().Be("Unexpected token <NumberToken>, expected <IdentifierToken>.");
            diagnostic.Location.Should().Be(location);
        }

        [Fact]
        public void ReportAllPathsMustReturn_AddsCorrectDiagnostic()
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();

            // Act
            diagnosticBag.ReportAllPathsMustReturn(location);

            // Assert
            diagnosticBag.Should().HaveCount(1);
            var diagnostic = diagnosticBag.First();
            diagnostic.Message.Should().Be("Not all code paths return a value.");
            diagnostic.Location.Should().Be(location);
        }

        [Fact]
        public void ReportParameterAlreadyDeclared_AddsCorrectDiagnostic()
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();
            const string parameterName = "value";

            // Act
            diagnosticBag.ReportParameterAlreadyDeclared(location, parameterName);

            // Assert
            diagnosticBag.Should().HaveCount(1);
            var diagnostic = diagnosticBag.First();
            diagnostic.Message.Should().Be("A parameter with the name 'value' already exists.");
            diagnostic.Location.Should().Be(location);
        }

        [Fact]
        public void ReportSymbolAlreadyDeclared_AddsCorrectDiagnostic()
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();
            const string symbolName = "myVariable";

            // Act
            diagnosticBag.ReportSymbolAlreadyDeclared(location, symbolName);

            // Assert
            diagnosticBag.Should().HaveCount(1);
            var diagnostic = diagnosticBag.First();
            diagnostic.Message.Should().Be("'myVariable' is already declared.");
            diagnostic.Location.Should().Be(location);
        }

        [Fact]
        public void ReportUndefinedType_AddsCorrectDiagnostic()
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();
            const string typeName = "UnknownType";

            // Act
            diagnosticBag.ReportUndefinedType(location, typeName);

            // Assert
            diagnosticBag.Should().HaveCount(1);
            var diagnostic = diagnosticBag.First();
            diagnostic.Message.Should().Be("Type 'UnknownType' doesn't exist.");
            diagnostic.Location.Should().Be(location);
        }

        [Fact]
        public void ReportInvalidBreakOrContinue_AddsCorrectDiagnostic()
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();
            const string keyword = "break";

            // Act
            diagnosticBag.ReportInvalidBreakOrContinue(location, keyword);

            // Assert
            diagnosticBag.Should().HaveCount(1);
            var diagnostic = diagnosticBag.First();
            diagnostic.Message.Should().Be("The keyword 'break' can only be used inside of loops.");
            diagnostic.Location.Should().Be(location);
        }

        [Fact]
        public void ReportInvalidReturn_AddsCorrectDiagnostic()
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();

            // Act
            diagnosticBag.ReportInvalidReturn(location);

            // Assert
            diagnosticBag.Should().HaveCount(1);
            var diagnostic = diagnosticBag.First();
            diagnostic.Message.Should().Be("The 'return' keyword can only be used inside of functions.");
            diagnostic.Location.Should().Be(location);
        }

        [Fact]
        public void MultipleDiagnostics_MaintainsOrder()
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();

            // Act
            diagnosticBag.ReportBadCharacter(location, 'a');
            diagnosticBag.ReportUnterminatedString(location);
            diagnosticBag.ReportUndefinedType(location, "TestType");

            // Assert
            diagnosticBag.Should().HaveCount(3);
            var messages = diagnosticBag.Select(d => d.Message).ToList();
            messages[0].Should().Be("Bad character input: 'a'.");
            messages[1].Should().Be("Unterminated string literal.");
            messages[2].Should().Be("Type 'TestType' doesn't exist.");
        }

        [Fact]
        public void DiagnosticBag_ImplementsIEnumerable()
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();
            diagnosticBag.ReportBadCharacter(location, 'x');

            // Act & Assert
            foreach (var diagnostic in diagnosticBag)
            {
                diagnostic.Should().NotBeNull();
                diagnostic.Message.Should().Contain("Bad character");
            }
        }

        [Fact]
        public void AddRange_ChainingMultipleBags_CombinesAllDiagnostics()
        {
            // Arrange
            var bag1 = new DiagnosticBag();
            var bag2 = new DiagnosticBag();
            var bag3 = new DiagnosticBag();
            var location = CreateTestLocation();

            bag1.ReportBadCharacter(location, 'a');
            bag2.ReportUnterminatedString(location);
            bag3.ReportUndefinedType(location, "Test");

            // Act
            bag1.AddRange(bag2);
            bag1.AddRange(bag3);

            // Assert
            bag1.Should().HaveCount(3);
            var messages = bag1.Select(d => d.Message).ToList();
            messages.Should().Contain("Bad character input: 'a'.");
            messages.Should().Contain("Unterminated string literal.");
            messages.Should().Contain("Type 'Test' doesn't exist.");
        }

        [Theory]
        [InlineData('!')]
        [InlineData('#')]
        [InlineData('$')]
        [InlineData('%')]
        public void ReportBadCharacter_VariousCharacters_CreatesCorrectMessages(char badChar)
        {
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();

            // Act
            diagnosticBag.ReportBadCharacter(location, badChar);

            // Assert
            var diagnostic = diagnosticBag.First();
            diagnostic.Message.Should().Be($"Bad character input: '{badChar}'.");
        }

        [Fact]
        public void DiagnosticBag_MultipleOperations_WorksSequentially()
        {
            // Note: DiagnosticBag is not thread-safe, so this tests sequential operations
            // Arrange
            var diagnosticBag = new DiagnosticBag();
            var location = CreateTestLocation();

            // Act - sequential operations
            for (int i = 0; i < 10; i++)
            {
                diagnosticBag.ReportBadCharacter(location, (char)('a' + (i % 26)));
            }

            // Assert
            diagnosticBag.Should().HaveCount(10);
        }
    }
}
