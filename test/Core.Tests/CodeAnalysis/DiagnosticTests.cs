// <copyright file="DiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis
{
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis;
    using GSharp.Core.CodeAnalysis.Text;
    using Xunit;

    public class DiagnosticTests
    {
        [Fact]
        public void Constructor_ValidLocationAndMessage_SetsPropertiesCorrectly()
        {
            // Arrange
            var sourceText = SourceText.From("test content", "test.gs");
            var textSpan = new TextSpan(0, 4);
            var location = new TextLocation(sourceText, textSpan);
            const string message = "Test diagnostic message";

            // Act
            var diagnostic = new Diagnostic(location, message);

            // Assert
            diagnostic.Location.Should().Be(location);
            diagnostic.Message.Should().Be(message);
        }

        [Fact]
        public void Constructor_EmptyMessage_SetsEmptyMessage()
        {
            // Arrange
            var sourceText = SourceText.From("test");
            var location = new TextLocation(sourceText, new TextSpan(0, 1));
            const string message = "";

            // Act
            var diagnostic = new Diagnostic(location, message);

            // Assert
            diagnostic.Message.Should().BeEmpty();
        }

        [Fact]
        public void Constructor_NullMessage_SetsNullMessage()
        {
            // Arrange
            var sourceText = SourceText.From("test");
            var location = new TextLocation(sourceText, new TextSpan(0, 1));
            const string message = null;

            // Act
            var diagnostic = new Diagnostic(location, message);

            // Assert
            diagnostic.Message.Should().BeNull();
        }

        [Theory]
        [InlineData("Syntax error: unexpected token")]
        [InlineData("Undefined variable 'x'")]
        [InlineData("Type mismatch: expected int, got string")]
        public void Message_Property_ReturnsSetValue(string message)
        {
            // Arrange
            var sourceText = SourceText.From("test content");
            var location = new TextLocation(sourceText, new TextSpan(5, 4));
            
            // Act
            var diagnostic = new Diagnostic(location, message);

            // Assert
            diagnostic.Message.Should().Be(message);
        }

        [Fact]
        public void Location_Property_ReturnsCorrectLocationInfo()
        {
            // Arrange
            var sourceText = SourceText.From("line1\nline2\nline3", "sample.gs");
            var textSpan = new TextSpan(6, 5); // "line2"
            var location = new TextLocation(sourceText, textSpan);
            var diagnostic = new Diagnostic(location, "Test message");

            // Act & Assert
            diagnostic.Location.Text.Should().Be(sourceText);
            diagnostic.Location.Span.Should().Be(textSpan);
            diagnostic.Location.FileName.Should().Be("sample.gs");
        }

        [Theory]
        [InlineData("Simple error message")]
        [InlineData("Complex error with symbols: <>[]{}")]
        [InlineData("")]
        public void ToString_ReturnsMessage(string message)
        {
            // Arrange
            var sourceText = SourceText.From("content");
            var location = new TextLocation(sourceText, new TextSpan(0, 1));
            var diagnostic = new Diagnostic(location, message);

            // Act
            var result = diagnostic.ToString();

            // Assert
            result.Should().Be(message);
        }

        [Fact]
        public void ToString_NullMessage_ReturnsNull()
        {
            // Arrange
            var sourceText = SourceText.From("content");
            var location = new TextLocation(sourceText, new TextSpan(0, 1));
            var diagnostic = new Diagnostic(location, null);

            // Act
            var result = diagnostic.ToString();

            // Assert
            result.Should().BeNull();
        }

        [Fact]
        public void Diagnostic_WithMultiLineLocation_PreservesLocationInfo()
        {
            // Arrange
            var sourceText = SourceText.From("first line\nsecond line\nthird line");
            var textSpan = new TextSpan(5, 15); // spans across lines
            var location = new TextLocation(sourceText, textSpan);
            var message = "Multi-line diagnostic";

            // Act
            var diagnostic = new Diagnostic(location, message);

            // Assert
            diagnostic.Location.StartLine.Should().Be(0);
            diagnostic.Location.EndLine.Should().Be(1);
            diagnostic.Message.Should().Be(message);
        }

        [Fact]
        public void Diagnostic_WithEmptySpan_CreatesValidDiagnostic()
        {
            // Arrange
            var sourceText = SourceText.From("test content");
            var emptySpan = new TextSpan(5, 0);
            var location = new TextLocation(sourceText, emptySpan);
            var message = "Empty span diagnostic";

            // Act
            var diagnostic = new Diagnostic(location, message);

            // Assert
            diagnostic.Location.Span.Length.Should().Be(0);
            diagnostic.Message.Should().Be(message);
        }

        [Fact]
        public void Diagnostic_WithFileNamedLocation_PreservesFileName()
        {
            // Arrange
            const string fileName = "myfile.gs";
            var sourceText = SourceText.From("content", fileName);
            var location = new TextLocation(sourceText, new TextSpan(0, 7));
            var diagnostic = new Diagnostic(location, "File-based diagnostic");

            // Act & Assert
            diagnostic.Location.FileName.Should().Be(fileName);
        }

        [Fact]
        public void Diagnostic_Equality_SameInstanceIsEqual()
        {
            // Arrange
            var sourceText = SourceText.From("test");
            var location = new TextLocation(sourceText, new TextSpan(0, 4));
            var diagnostic = new Diagnostic(location, "message");

            // Act & Assert
            diagnostic.Equals(diagnostic).Should().BeTrue();
        }
    }
}
