// <copyright file="TextLocationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis.Text
{
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis.Text;
    using Xunit;

    public class TextLocationTests
    {
        [Fact]
        public void Constructor_ValidTextAndSpan_SetsPropertiesCorrectly()
        {
            // Arrange
            var sourceText = SourceText.From("hello world", "test.gs");
            var textSpan = new TextSpan(6, 5); // "world"

            // Act
            var location = new TextLocation(sourceText, textSpan);

            // Assert
            location.Text.Should().Be(sourceText);
            location.Span.Should().Be(textSpan);
            location.FileName.Should().Be("test.gs");
        }

        [Fact]
        public void StartLine_SingleLine_ReturnsZero()
        {
            // Arrange
            var sourceText = SourceText.From("hello world");
            var textSpan = new TextSpan(0, 5); // "hello"
            var location = new TextLocation(sourceText, textSpan);

            // Act & Assert
            location.StartLine.Should().Be(0);
        }

        [Fact]
        public void StartLine_MultiLine_ReturnsCorrectLineIndex()
        {
            // Arrange
            var sourceText = SourceText.From("line1\nline2\nline3");
            var textSpan = new TextSpan(6, 5); // "line2"
            var location = new TextLocation(sourceText, textSpan);

            // Act & Assert
            location.StartLine.Should().Be(1);
        }

        [Fact]
        public void StartCharacter_BeginningOfLine_ReturnsZero()
        {
            // Arrange
            var sourceText = SourceText.From("line1\nline2\nline3");
            var textSpan = new TextSpan(6, 4); // "line" from "line2"
            var location = new TextLocation(sourceText, textSpan);

            // Act & Assert
            location.StartCharacter.Should().Be(0);
        }

        [Fact]
        public void StartCharacter_MiddleOfLine_ReturnsCorrectPosition()
        {
            // Arrange
            var sourceText = SourceText.From("hello world\nsecond line");
            var textSpan = new TextSpan(6, 5); // "world"
            var location = new TextLocation(sourceText, textSpan);

            // Act & Assert
            location.StartCharacter.Should().Be(6);
        }

        [Fact]
        public void EndLine_SameLineAsStart_ReturnsStartLine()
        {
            // Arrange
            var sourceText = SourceText.From("hello world");
            var textSpan = new TextSpan(0, 11); // entire line
            var location = new TextLocation(sourceText, textSpan);

            // Act & Assert
            location.EndLine.Should().Be(0);
        }

        [Fact]
        public void EndLine_SpansMultipleLines_ReturnsCorrectEndLine()
        {
            // Arrange
            var sourceText = SourceText.From("line1\nline2\nline3");
            var textSpan = new TextSpan(3, 8); // "e1\nline2"
            var location = new TextLocation(sourceText, textSpan);

            // Act & Assert
            location.EndLine.Should().Be(1);
        }

        [Fact]
        public void EndCharacter_EndOfLine_ReturnsCorrectPosition()
        {
            // Arrange
            var sourceText = SourceText.From("line1\nline2\nline3");
            var textSpan = new TextSpan(6, 5); // "line2"
            var location = new TextLocation(sourceText, textSpan);

            // Act & Assert
            location.EndCharacter.Should().Be(5);
        }

        [Fact]
        public void EndCharacter_SpansToNextLine_ReturnsCorrectPosition()
        {
            // Arrange
            var sourceText = SourceText.From("line1\nline2\nline3");
            var textSpan = new TextSpan(8, 5); // "ne2\nli" - spans from "ne2" to "li" in next line
            var location = new TextLocation(sourceText, textSpan);

            // Act & Assert
            // The end position (13) is in "line3" at position 1 (the "i" in "line3")
            location.EndCharacter.Should().Be(1); // position "i" in "line3"
        }

        [Fact]
        public void FileName_WithFileName_ReturnsFileName()
        {
            // Arrange
            const string fileName = "myfile.gs";
            var sourceText = SourceText.From("content", fileName);
            var location = new TextLocation(sourceText, new TextSpan(0, 4));

            // Act & Assert
            location.FileName.Should().Be(fileName);
        }

        [Fact]
        public void FileName_WithoutFileName_ReturnsEmptyOrNull()
        {
            // Arrange
            var sourceText = SourceText.From("content");
            var location = new TextLocation(sourceText, new TextSpan(0, 4));

            // Act & Assert
            location.FileName.Should().BeNullOrEmpty();
        }

        [Theory]
        [InlineData("file1.gs", 0, 5, "file2.gs", 0, 5, -1)] // Different files
        [InlineData("file.gs", 0, 5, "file.gs", 5, 5, -1)]   // Same file, earlier start
        [InlineData("file.gs", 5, 5, "file.gs", 0, 5, 1)]    // Same file, later start
        [InlineData("file.gs", 0, 3, "file.gs", 0, 5, -1)]   // Same start, shorter span
        [InlineData("file.gs", 0, 5, "file.gs", 0, 3, 1)]    // Same start, longer span
        [InlineData("file.gs", 0, 5, "file.gs", 0, 5, 0)]    // Identical locations
        public void CompareTo_VariousLocations_ReturnsCorrectComparison(
            string fileName1, int start1, int length1,
            string fileName2, int start2, int length2,
            int expectedSign)
        {
            // Arrange
            var sourceText1 = SourceText.From("content1", fileName1);
            var sourceText2 = SourceText.From("content2", fileName2);
            var location1 = new TextLocation(sourceText1, new TextSpan(start1, length1));
            var location2 = new TextLocation(sourceText2, new TextSpan(start2, length2));

            // Act
            var result = location1.CompareTo(location2);

            // Assert
            if (expectedSign < 0)
            {
                result.Should().BeNegative();
            }
            else if (expectedSign > 0)
            {
                result.Should().BePositive();
            }
            else
            {
                result.Should().Be(0);
            }
        }

        [Fact]
        public void CompareTo_SelfComparison_ReturnsZero()
        {
            // Arrange
            var sourceText = SourceText.From("content", "file.gs");
            var location = new TextLocation(sourceText, new TextSpan(5, 10));

            // Act
            var result = location.CompareTo(location);

            // Assert
            result.Should().Be(0);
        }

        [Fact]
        public void CompareTo_PrimarySort_ByFileName()
        {
            // Arrange
            var sourceText1 = SourceText.From("content", "a.gs");
            var sourceText2 = SourceText.From("content", "b.gs");
            var location1 = new TextLocation(sourceText1, new TextSpan(10, 5)); // Later position
            var location2 = new TextLocation(sourceText2, new TextSpan(0, 15)); // Earlier position

            // Act
            var result = location1.CompareTo(location2);

            // Assert
            result.Should().BeNegative("locations should be sorted by file name first");
        }

        [Fact]
        public void CompareTo_SecondarySort_BySpanWhenFileNameSame()
        {
            // Arrange
            var sourceText = SourceText.From("content", "file.gs");
            var location1 = new TextLocation(sourceText, new TextSpan(0, 5));  // Earlier span
            var location2 = new TextLocation(sourceText, new TextSpan(5, 3));  // Later span

            // Act
            var result = location1.CompareTo(location2);

            // Assert
            result.Should().BeNegative("when file names are equal, spans should be compared");
        }

        [Fact]
        public void TextLocation_WithEmptySpan_HandlesCorrectly()
        {
            // Arrange
            var sourceText = SourceText.From("hello\nworld");
            var emptySpan = new TextSpan(6, 0); // Empty span at "world"
            var location = new TextLocation(sourceText, emptySpan);

            // Act & Assert
            location.StartLine.Should().Be(1);
            location.EndLine.Should().Be(1);
            location.StartCharacter.Should().Be(0);
            location.EndCharacter.Should().Be(0);
        }

        [Fact]
        public void TextLocation_AtEndOfFile_HandlesCorrectly()
        {
            // Arrange
            var sourceText = SourceText.From("hello");
            var span = new TextSpan(5, 0); // At end of file
            var location = new TextLocation(sourceText, span);

            // Act & Assert
            location.StartLine.Should().Be(0);
            location.EndLine.Should().Be(0);
            location.StartCharacter.Should().Be(5);
            location.EndCharacter.Should().Be(5);
        }

        [Fact]
        public void TextLocation_WithWindowsLineEndings_HandlesCorrectly()
        {
            // Arrange
            var sourceText = SourceText.From("line1\r\nline2\r\nline3");
            var span = new TextSpan(7, 5); // "line2"
            var location = new TextLocation(sourceText, span);

            // Act & Assert
            location.StartLine.Should().Be(1);
            location.EndLine.Should().Be(1);
            location.StartCharacter.Should().Be(0);
            location.EndCharacter.Should().Be(5);
        }

        [Fact]
        public void TextLocation_SpanningEntireDocument_HandlesCorrectly()
        {
            // Arrange
            var content = "line1\nline2\nline3";
            var sourceText = SourceText.From(content);
            var span = new TextSpan(0, content.Length);
            var location = new TextLocation(sourceText, span);

            // Act & Assert
            location.StartLine.Should().Be(0);
            location.EndLine.Should().Be(2);
            location.StartCharacter.Should().Be(0);
        }
    }
}
