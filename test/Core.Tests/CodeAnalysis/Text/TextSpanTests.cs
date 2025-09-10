// <copyright file="TextSpanTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis.Text
{
    using System;
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis.Text;
    using Xunit;

    public class TextSpanTests
    {
        [Fact]
        public void Constructor_ValidStartAndLength_SetsPropertiesCorrectly()
        {
            // Arrange
            const int start = 5;
            const int length = 10;

            // Act
            var textSpan = new TextSpan(start, length);

            // Assert
            textSpan.Start.Should().Be(start);
            textSpan.Length.Should().Be(length);
            textSpan.End.Should().Be(start + length);
        }

        [Fact]
        public void Constructor_ZeroLength_CreatesEmptySpan()
        {
            // Arrange
            const int start = 5;
            const int length = 0;

            // Act
            var textSpan = new TextSpan(start, length);

            // Assert
            textSpan.Start.Should().Be(start);
            textSpan.Length.Should().Be(0);
            textSpan.End.Should().Be(start);
        }

        [Theory]
        [InlineData(0, 0, 0)]
        [InlineData(5, 10, 15)]
        [InlineData(100, 25, 125)]
        public void End_Property_CalculatesCorrectly(int start, int length, int expectedEnd)
        {
            // Arrange & Act
            var textSpan = new TextSpan(start, length);

            // Assert
            textSpan.End.Should().Be(expectedEnd);
        }

        [Theory]
        [InlineData(0, 5)]
        [InlineData(10, 15)]
        [InlineData(5, 5)]
        public void FromBounds_ValidBounds_CreatesCorrectSpan(int start, int end)
        {
            // Act
            var textSpan = TextSpan.FromBounds(start, end);

            // Assert
            textSpan.Start.Should().Be(start);
            textSpan.End.Should().Be(end);
            textSpan.Length.Should().Be(end - start);
        }

        [Fact]
        public void FromBounds_StartEqualsEnd_CreatesEmptySpan()
        {
            // Arrange
            const int position = 10;

            // Act
            var textSpan = TextSpan.FromBounds(position, position);

            // Assert
            textSpan.Start.Should().Be(position);
            textSpan.End.Should().Be(position);
            textSpan.Length.Should().Be(0);
        }

        [Fact]
        public void FromBounds_EndBeforeStart_CreatesNegativeLengthSpan()
        {
            // Arrange
            const int start = 10;
            const int end = 5;

            // Act
            var textSpan = TextSpan.FromBounds(start, end);

            // Assert
            textSpan.Start.Should().Be(start);
            textSpan.End.Should().Be(end);
            textSpan.Length.Should().Be(end - start); // -5
        }

        [Theory]
        [InlineData(5, 10, 7, 8, -1)] // Earlier start
        [InlineData(7, 8, 5, 10, 1)]  // Later start  
        [InlineData(5, 10, 5, 8, 1)]  // Same start, shorter length
        [InlineData(5, 8, 5, 10, -1)] // Same start, longer length
        [InlineData(5, 10, 5, 10, 0)] // Identical spans
        public void CompareTo_VariousSpans_ReturnsCorrectComparison(
            int start1, int length1, int start2, int length2, int expectedSign)
        {
            // Arrange
            var span1 = new TextSpan(start1, length1);
            var span2 = new TextSpan(start2, length2);

            // Act
            var result = span1.CompareTo(span2);

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
            var textSpan = new TextSpan(5, 10);

            // Act
            var result = textSpan.CompareTo(textSpan);

            // Assert
            result.Should().Be(0);
        }

        [Theory]
        [InlineData(0, 0, "0..0")]
        [InlineData(5, 10, "5..15")]
        [InlineData(100, 25, "100..125")]
        public void ToString_VariousSpans_ReturnsCorrectFormat(int start, int length, string expected)
        {
            // Arrange
            var textSpan = new TextSpan(start, length);

            // Act
            var result = textSpan.ToString();

            // Assert
            result.Should().Be(expected);
        }

        [Fact]
        public void ToString_EmptySpan_ShowsStartAndEndSame()
        {
            // Arrange
            var textSpan = new TextSpan(5, 0);

            // Act
            var result = textSpan.ToString();

            // Assert
            result.Should().Be("5..5");
        }

        [Fact]
        public void CompareTo_PrimarySort_ByStartPosition()
        {
            // Arrange
            var span1 = new TextSpan(1, 100); // Earlier start, longer length
            var span2 = new TextSpan(2, 1);   // Later start, shorter length

            // Act
            var result = span1.CompareTo(span2);

            // Assert
            result.Should().BeNegative("spans should be sorted by start position first");
        }

        [Fact]
        public void CompareTo_SecondarySort_ByLengthWhenStartSame()
        {
            // Arrange
            var span1 = new TextSpan(5, 3); // Same start, shorter length
            var span2 = new TextSpan(5, 7); // Same start, longer length

            // Act
            var result = span1.CompareTo(span2);

            // Assert
            result.Should().BeNegative("when start positions are equal, shorter spans should come first");
        }

        [Fact]
        public void Equality_StructEquality_WorksCorrectly()
        {
            // Arrange
            var span1 = new TextSpan(5, 10);
            var span2 = new TextSpan(5, 10);
            var span3 = new TextSpan(5, 11);

            // Act & Assert
            span1.Equals(span2).Should().BeTrue("identical spans should be equal");
            span1.Equals(span3).Should().BeFalse("different spans should not be equal");
            span1.CompareTo(span2).Should().Be(0, "identical spans should compare as equal");
        }
    }
}
