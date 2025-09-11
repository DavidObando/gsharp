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
    public class CodeGenerationTests
    {
        [Fact]
        public void CodeGeneration_LiteralExpression_GeneratesCorrectValue()
        {
            // Arrange
            var sourceText = SourceText.From("42");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(42);
        }

        [Fact]
        public void CodeGeneration_BooleanLiteral_GeneratesCorrectValue()
        {
            // Arrange
            var sourceText = SourceText.From("true");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(true);
        }

        [Fact]
        public void CodeGeneration_StringLiteral_GeneratesCorrectValue()
        {
            // Arrange
            var sourceText = SourceText.From("\"hello world\"");
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
        public void CodeGeneration_Addition_GeneratesCorrectResult()
        {
            // Arrange
            var sourceText = SourceText.From("5 + 3");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(8);
        }

        [Fact]
        public void CodeGeneration_Subtraction_GeneratesCorrectResult()
        {
            // Arrange
            var sourceText = SourceText.From("10 - 4");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(6);
        }

        [Fact]
        public void CodeGeneration_Multiplication_GeneratesCorrectResult()
        {
            // Arrange
            var sourceText = SourceText.From("7 * 8");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(56);
        }

        [Fact]
        public void CodeGeneration_Division_GeneratesCorrectResult()
        {
            // Arrange
            var sourceText = SourceText.From("15 / 3");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(5);
        }

        [Fact]
        public void CodeGeneration_BooleanAnd_GeneratesCorrectResult()
        {
            // Arrange
            var sourceText = SourceText.From("true && false");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(false);
        }

        [Fact]
        public void CodeGeneration_BooleanOr_GeneratesCorrectResult()
        {
            // Arrange
            var sourceText = SourceText.From("true || false");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(true);
        }

        [Fact]
        public void CodeGeneration_Comparison_GeneratesCorrectResult()
        {
            // Arrange
            var sourceText = SourceText.From("5 > 3");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(true);
        }

        [Fact]
        public void CodeGeneration_Equality_GeneratesCorrectResult()
        {
            // Arrange
            var sourceText = SourceText.From("5 == 5");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(true);
        }

        [Fact]
        public void CodeGeneration_UnaryMinus_GeneratesCorrectResult()
        {
            // Arrange
            var sourceText = SourceText.From("-42");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(-42);
        }

        [Fact]
        public void CodeGeneration_UnaryNot_GeneratesCorrectResult()
        {
            // Arrange
            var sourceText = SourceText.From("!true");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(false);
        }

        [Fact]
        public void CodeGeneration_VariableDeclaration_StoresValue()
        {
            // Arrange
            var sourceText = SourceText.From("x := 42");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
        }

        [Fact]
        public void CodeGeneration_VariableAccess_RetrievesValue()
        {
            // Arrange
            var sourceText = SourceText.From(@"
{
    x := 42
    x
}");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(42);
        }

        [Fact]
        public void CodeGeneration_Assignment_UpdatesValue()
        {
            // Arrange
            var sourceText = SourceText.From(@"
{
    x := 42
    x = 24
    x
}");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(24);
        }

        [Fact]
        public void CodeGeneration_StringConcatenation_GeneratesCorrectResult()
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
        public void CodeGeneration_ComplexExpression_GeneratesCorrectResult()
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

        [Fact]
        public void CodeGeneration_NestedBlocks_HandlesScoping()
        {
            // Arrange
            var sourceText = SourceText.From(@"
{
    x := 5
    {
        y := x + 10
        y
    }
}");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(15);
        }

        [Fact]
        public void CodeGeneration_FunctionCall_ExecutesCorrectly()
        {
            // Arrange
            var sourceText = SourceText.From("print(\"test\")");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
        }
    }
}
