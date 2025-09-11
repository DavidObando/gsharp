using FluentAssertions;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Text;
using System.Collections.Immutable;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Compilation
{
    public class EmitResultTests
    {
        [Fact]
        public void Constructor_WithSuccessAndNoDiagnostics_SetsProperties()
        {
            // Arrange
            var success = true;
            var diagnostics = ImmutableArray<Diagnostic>.Empty;

            // Act
            var result = new EmitResult(success, diagnostics);

            // Assert
            result.Should().NotBeNull();
            result.Success.Should().BeTrue();
            result.Diagnostics.Should().BeEquivalentTo(diagnostics);
        }

        [Fact]
        public void Constructor_WithFailureAndDiagnostics_SetsProperties()
        {
            // Arrange
            var success = false;
            var sourceText = SourceText.From("test content");
            var diagnostic = new Diagnostic(
                location: new TextLocation(sourceText, new TextSpan(0, 4)),
                message: "Test error");
            var diagnostics = ImmutableArray.Create(diagnostic);

            // Act
            var result = new EmitResult(success, diagnostics);

            // Assert
            result.Should().NotBeNull();
            result.Success.Should().BeFalse();
            result.Diagnostics.Should().HaveCount(1);
            result.Diagnostics[0].Should().Be(diagnostic);
        }

        [Fact]
        public void Constructor_WithSuccessTrue_IndicatesSuccessfulEmit()
        {
            // Arrange
            var diagnostics = ImmutableArray<Diagnostic>.Empty;

            // Act
            var result = new EmitResult(success: true, diagnostics);

            // Assert
            result.Success.Should().BeTrue();
        }

        [Fact]
        public void Constructor_WithSuccessFalse_IndicatesFailedEmit()
        {
            // Arrange
            var diagnostics = ImmutableArray<Diagnostic>.Empty;

            // Act
            var result = new EmitResult(success: false, diagnostics);

            // Assert
            result.Success.Should().BeFalse();
        }

        [Fact]
        public void Constructor_WithEmptyDiagnostics_StoresEmptyArray()
        {
            // Arrange
            var diagnostics = ImmutableArray<Diagnostic>.Empty;

            // Act
            var result = new EmitResult(success: true, diagnostics);

            // Assert
            result.Diagnostics.Should().BeEmpty();
        }

        [Fact]
        public void Constructor_WithMultipleDiagnostics_StoresAllDiagnostics()
        {
            // Arrange
            var sourceText = SourceText.From("test content");
            var diagnostic1 = new Diagnostic(
                location: new TextLocation(sourceText, new TextSpan(0, 2)),
                message: "First error");
            var diagnostic2 = new Diagnostic(
                location: new TextLocation(sourceText, new TextSpan(2, 2)),
                message: "Second error");
            var diagnostics = ImmutableArray.Create(diagnostic1, diagnostic2);

            // Act
            var result = new EmitResult(success: false, diagnostics);

            // Assert
            result.Diagnostics.Should().HaveCount(2);
            result.Diagnostics[0].Should().Be(diagnostic1);
            result.Diagnostics[1].Should().Be(diagnostic2);
        }

        [Fact]
        public void Properties_AreReadOnly()
        {
            // Arrange
            var diagnostics = ImmutableArray<Diagnostic>.Empty;

            // Act
            var result = new EmitResult(success: true, diagnostics);

            // Assert - Properties should not have setters (compile-time check)
            result.Success.Should().BeTrue();
            result.Diagnostics.Should().NotBeNull();
            
            // The fact that we can't modify these properties is verified at compile time
            // This test primarily validates the constructor works correctly
        }

        [Fact]
        public void EmitResult_SuccessAndDiagnostics_CanBothBePresent()
        {
            // Arrange - Success can be true even with warnings (non-error diagnostics)
            var sourceText = SourceText.From("test content");
            var warningDiagnostic = new Diagnostic(
                location: new TextLocation(sourceText, new TextSpan(0, 4)),
                message: "Test warning");
            var diagnostics = ImmutableArray.Create(warningDiagnostic);

            // Act
            var result = new EmitResult(success: true, diagnostics);

            // Assert
            result.Success.Should().BeTrue();
            result.Diagnostics.Should().HaveCount(1);
            result.Diagnostics[0].Message.Should().Contain("warning");
        }

        [Fact]
        public void EmitResult_FailureTypicallyHasDiagnostics()
        {
            // Arrange - Failure typically comes with error diagnostics
            var sourceText = SourceText.From("error content");
            var errorDiagnostic = new Diagnostic(
                location: new TextLocation(sourceText, new TextSpan(0, 5)),
                message: "Compilation error");
            var diagnostics = ImmutableArray.Create(errorDiagnostic);

            // Act
            var result = new EmitResult(success: false, diagnostics);

            // Assert
            result.Success.Should().BeFalse();
            result.Diagnostics.Should().NotBeEmpty();
            result.Diagnostics[0].Message.Should().Contain("error");
        }
    }
}
