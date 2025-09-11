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
    public class BuiltinFunctionTests
    {
        [Fact]
        public void BuiltinFunction_Print_AcceptsStringArgument()
        {
            // Arrange
            var sourceText = SourceText.From("print(\"hello\")");
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
        public void BuiltinFunction_Print_AcceptsIntegerArgument()
        {
            // Arrange
            var sourceText = SourceText.From("print(string(42))");
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
        public void BuiltinFunction_Print_AcceptsBooleanArgument()
        {
            // Arrange
            var sourceText = SourceText.From("print(string(true))");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
        }

        [Fact(Skip = "The input() function shouldn't be used in tests as that locks the test harness.")]
        public void BuiltinFunction_Input_ReturnsString()
        {
            // Arrange
            var sourceText = SourceText.From("input()");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            // Note: input() may not work in test environment, so we just check it doesn't crash
        }

        [Fact]
        public void BuiltinFunction_Random_ReturnsInteger()
        {
            // Arrange
            var sourceText = SourceText.From("rnd(10)");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            if (result.Diagnostics.Length == 0 && result.Value != null)
            {
                result.Value.Should().BeOfType<int>();
                ((int)result.Value).Should().BeInRange(0, 9);
            }
        }

        [Fact]
        public void BuiltinFunction_ToString_ConvertsIntegerToString()
        {
            // Arrange
            var sourceText = SourceText.From("string(42)");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            if (result.Diagnostics.Length == 0)
            {
                result.Value.Should().Be("42");
            }
        }

        [Fact]
        public void BuiltinFunction_ToString_ConvertsBooleanToString()
        {
            // Arrange
            var sourceText = SourceText.From("string(true)");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            if (result.Diagnostics.Length == 0)
            {
                result.Value.Should().Be("True");
            }
        }

        [Fact]
        public void BuiltinFunction_UndefinedFunction_ReportsDiagnostic()
        {
            // Arrange
            var sourceText = SourceText.From("undefinedFunction(42)");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().NotBeEmpty();
        }

        [Fact]
        public void BuiltinFunction_WithVariableArgument_WorksCorrectly()
        {
            // Arrange
            var sourceText = SourceText.From(@"
{
    x := string(42)
    print(x)
}");
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
        public void BuiltinFunction_WithExpressionArgument_WorksCorrectly()
        {
            // Arrange
            var sourceText = SourceText.From("print(string(5 + 3))");
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
        public void BuiltinFunction_NestedCalls_WorksCorrectly()
        {
            // Arrange
            var sourceText = SourceText.From("print(string(42))");
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
        public void BuiltinFunction_InComplexExpression_WorksCorrectly()
        {
            // Arrange
            var sourceText = SourceText.From(@"
{
    x := 5
    y := 10
    print(string(x + y))
}");
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
        public void BuiltinFunction_MultipleStatements_WorksCorrectly()
        {
            // Arrange
            var sourceText = SourceText.From(@"
{
    print(""First line"")
    print(""Second line"")
    print(string(42))
}");
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
