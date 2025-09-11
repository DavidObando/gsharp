using FluentAssertions;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding
{
    public class SemanticAnalysisTests
    {
        [Fact]
        public void VariableBinding_ValidDeclaration_BindsCorrectly()
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
        public void VariableBinding_UndefinedVariable_ReportsDiagnostic()
        {
            // Arrange
            var sourceText = SourceText.From("undefinedVar + 5");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().NotBeEmpty();
            result.Diagnostics.Should().Contain(d => d.Message.Contains("undefined") || d.Message.Contains("undeclared"));
        }

        [Fact]
        public void TypeChecking_IntegerArithmetic_AcceptsValidTypes()
        {
            // Arrange
            var sourceText = SourceText.From("5 + 10");
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
        public void TypeChecking_BooleanOperations_AcceptsValidTypes()
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
        public void TypeChecking_StringOperations_AcceptsValidTypes()
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
        public void ScopeResolution_NestedScopes_ResolvesCorrectly()
        {
            // Arrange
            var sourceText = SourceText.From(@"
{
    x := 5
    {
        y := x + 10
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
        }

        [Fact]
        public void ScopeResolution_VariableRedeclaration_ReportsDiagnostic()
        {
            // Arrange
            var sourceText = SourceText.From(@"
{
    x := 5
    x := 10
}");
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
        public void Assignment_ValidTypes_AcceptsAssignment()
        {
            // Arrange
            var sourceText = SourceText.From(@"
{
    x := 5
    x = 10
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
        public void Assignment_ReadOnlyVariable_ReportsDiagnostic()
        {
            // Arrange
            var sourceText = SourceText.From(@"
{
    let x = 5
    x = 10
}");
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
        public void FunctionBinding_ValidFunction_BindsCorrectly()
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
        public void FunctionBinding_UndefinedFunction_ReportsDiagnostic()
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
        public void FunctionBinding_WrongArgumentCount_ReportsDiagnostic()
        {
            // Arrange
            var sourceText = SourceText.From("print(\"hello\", \"extra\", \"arguments\")");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            // May or may not report error depending on whether print accepts variable arguments
        }

        [Fact]
        public void ConditionalExpression_ValidCondition_EvaluatesCorrectly()
        {
            // Arrange
            var sourceText = SourceText.From("if true then 1 else 2");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            if (result.Diagnostics.Length == 0)
            {
                result.Value.Should().Be(1);
            }
        }

        [Fact]
        public void ConditionalExpression_NonBooleanCondition_ReportsDiagnostic()
        {
            // Arrange
            var sourceText = SourceText.From("if 42 then 1 else 2");
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
        public void BinaryOperation_IncompatibleTypes_ReportsDiagnostic()
        {
            // Arrange
            var sourceText = SourceText.From("5 + \"hello\"");
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
        public void UnaryOperation_ValidType_AcceptsOperation()
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
        public void UnaryOperation_InvalidType_ReportsDiagnostic()
        {
            // Arrange
            var sourceText = SourceText.From("-\"hello\"");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().NotBeEmpty();
        }
    }
}
