using FluentAssertions;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Text;
using System.Collections.Immutable;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis
{
    public class EvaluationResultTests
    {
        [Fact]
        public void Constructor_ValidParameters_SetsProperties()
        {
            // Arrange
            var diagnostics = ImmutableArray<Diagnostic>.Empty;
            var value = 42;

            // Act
            var result = new EvaluationResult(diagnostics, value);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEquivalentTo(diagnostics);
            result.Value.Should().Be(value);
        }

        [Fact]
        public void Constructor_WithDiagnostics_StoresDiagnosticsCorrectly()
        {
            // Arrange
            var diagnostic = new Diagnostic(
                location: new TextLocation(SourceText.From("test"), new TextSpan(0, 4)),
                message: "Test diagnostic");
            var diagnostics = ImmutableArray.Create(diagnostic);
            var value = "test";

            // Act
            var result = new EvaluationResult(diagnostics, value);

            // Assert
            result.Diagnostics.Should().HaveCount(1);
            result.Diagnostics[0].Should().Be(diagnostic);
            result.Value.Should().Be(value);
        }

        [Fact]
        public void Constructor_WithNullValue_AllowsNullValue()
        {
            // Arrange
            var diagnostics = ImmutableArray<Diagnostic>.Empty;
            object value = null;

            // Act
            var result = new EvaluationResult(diagnostics, value);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEquivalentTo(diagnostics);
            result.Value.Should().BeNull();
        }

        [Fact]
        public void Constructor_WithComplexValue_StoresCorrectly()
        {
            // Arrange
            var diagnostics = ImmutableArray<Diagnostic>.Empty;
            var value = new { Name = "Test", Value = 42 };

            // Act
            var result = new EvaluationResult(diagnostics, value);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEquivalentTo(diagnostics);
            result.Value.Should().Be(value);
        }

        [Fact]
        public void Constructor_WithMultipleDiagnostics_StoresAllDiagnostics()
        {
            // Arrange
            var sourceText = SourceText.From("test content");
            var diagnostic1 = new Diagnostic(
                location: new TextLocation(sourceText, new TextSpan(0, 2)),
                message: "First diagnostic");
            var diagnostic2 = new Diagnostic(
                location: new TextLocation(sourceText, new TextSpan(2, 2)),
                message: "Second diagnostic");
            var diagnostics = ImmutableArray.Create(diagnostic1, diagnostic2);
            var value = false;

            // Act
            var result = new EvaluationResult(diagnostics, value);

            // Assert
            result.Diagnostics.Should().HaveCount(2);
            result.Diagnostics[0].Should().Be(diagnostic1);
            result.Diagnostics[1].Should().Be(diagnostic2);
            result.Value.Should().Be(value);
        }

        [Fact]
        public void Properties_AreReadOnly()
        {
            // Arrange
            var diagnostics = ImmutableArray<Diagnostic>.Empty;
            var value = "readonly test";

            // Act
            var result = new EvaluationResult(diagnostics, value);

            // Assert - Properties should not have setters (compile-time check)
            result.Diagnostics.Should().NotBeNull();
            result.Value.Should().NotBeNull();
            
            // The fact that we can't modify these properties is verified at compile time
            // This test primarily validates the constructor works correctly
        }
    }
}
