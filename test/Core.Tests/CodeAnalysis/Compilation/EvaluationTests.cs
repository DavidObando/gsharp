using FluentAssertions;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Compilation
{
    public class EvaluationTests
    {
        [Theory]
        [InlineData("1", 1)]
        [InlineData("42", 42)]
        [InlineData("-42", -42)]
        [InlineData("0", 0)]
        public void Evaluate_IntegerLiterals_ReturnsCorrectValue(string source, int expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("true", true)]
        [InlineData("false", false)]
        public void Evaluate_BooleanLiterals_ReturnsCorrectValue(string source, bool expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("\"hello\"", "hello")]
        [InlineData("\"\"", "")]
        [InlineData("\"hello world\"", "hello world")]
        public void Evaluate_StringLiterals_ReturnsCorrectValue(string source, string expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("1 + 2", 3)]
        [InlineData("5 + 0", 5)]
        [InlineData("10 + 20", 30)]
        [InlineData("-5 + 10", 5)]
        public void Evaluate_Addition_ReturnsCorrectValue(string source, int expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("5 - 3", 2)]
        [InlineData("10 - 10", 0)]
        [InlineData("0 - 5", -5)]
        public void Evaluate_Subtraction_ReturnsCorrectValue(string source, int expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("3 * 4", 12)]
        [InlineData("5 * 0", 0)]
        [InlineData("7 * 1", 7)]
        public void Evaluate_Multiplication_ReturnsCorrectValue(string source, int expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("12 / 4", 3)]
        [InlineData("10 / 2", 5)]
        [InlineData("7 / 1", 7)]
        public void Evaluate_Division_ReturnsCorrectValue(string source, int expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("true && true", true)]
        [InlineData("true && false", false)]
        [InlineData("false && true", false)]
        [InlineData("false && false", false)]
        public void Evaluate_LogicalAnd_ReturnsCorrectValue(string source, bool expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("true || true", true)]
        [InlineData("true || false", true)]
        [InlineData("false || true", true)]
        [InlineData("false || false", false)]
        public void Evaluate_LogicalOr_ReturnsCorrectValue(string source, bool expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("5 == 5", true)]
        [InlineData("5 == 3", false)]
        [InlineData("true == true", true)]
        [InlineData("true == false", false)]
        public void Evaluate_Equality_ReturnsCorrectValue(string source, bool expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("5 != 3", true)]
        [InlineData("5 != 5", false)]
        [InlineData("true != false", true)]
        [InlineData("true != true", false)]
        public void Evaluate_Inequality_ReturnsCorrectValue(string source, bool expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("5 > 3", true)]
        [InlineData("3 > 5", false)]
        [InlineData("5 > 5", false)]
        public void Evaluate_GreaterThan_ReturnsCorrectValue(string source, bool expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("5 >= 3", true)]
        [InlineData("5 >= 5", true)]
        [InlineData("3 >= 5", false)]
        public void Evaluate_GreaterThanOrEqual_ReturnsCorrectValue(string source, bool expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("3 < 5", true)]
        [InlineData("5 < 3", false)]
        [InlineData("5 < 5", false)]
        public void Evaluate_LessThan_ReturnsCorrectValue(string source, bool expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("3 <= 5", true)]
        [InlineData("5 <= 5", true)]
        [InlineData("5 <= 3", false)]
        public void Evaluate_LessThanOrEqual_ReturnsCorrectValue(string source, bool expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Theory]
        [InlineData("!true", false)]
        [InlineData("!false", true)]
        public void Evaluate_LogicalNot_ReturnsCorrectValue(string source, bool expected)
        {
            // Arrange
            var sourceText = SourceText.From(source);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(expected);
        }

        [Fact]
        public void Evaluate_StringConcatenation_ReturnsCorrectValue()
        {
            // Arrange
            var sourceText = SourceText.From("\"hello\" + \" world\"");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be("hello world");
        }

        [Fact]
        public void Evaluate_ParenthesesPrecedence_ReturnsCorrectValue()
        {
            // Arrange
            var sourceText = SourceText.From("(1 + 2) * 3");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(9); // (1+2)*3 = 3*3 = 9
        }

        [Fact]
        public void Evaluate_OperatorPrecedence_ReturnsCorrectValue()
        {
            // Arrange
            var sourceText = SourceText.From("1 + 2 * 3");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(7); // 1+(2*3) = 1+6 = 7
        }

        [Fact]
        public void Evaluate_ComplexExpression_ReturnsCorrectValue()
        {
            // Arrange
            var sourceText = SourceText.From("(5 + 3) * 2 - 1");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(15); // (5+3)*2-1 = 8*2-1 = 16-1 = 15
        }
    }
}
