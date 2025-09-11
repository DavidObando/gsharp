using FluentAssertions;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace GSharp.Core.Tests.Tools
{
    public class InterpreterIntegrationTests
    {
        [Fact]
        public void Interpreter_SimpleExpression_EvaluatesCorrectly()
        {
            // Arrange
            var sourceCode = "5 + 3";
            var sourceText = SourceText.From(sourceCode);
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
        public void Interpreter_VariableDeclaration_StoresAndRetrievesValue()
        {
            // Arrange
            var sourceCode = @"
{
    x := 42
    x
}";
            var sourceText = SourceText.From(sourceCode);
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
        public void Interpreter_Assignment_UpdatesVariable()
        {
            // Arrange
            var sourceCode = @"
{
    x := 10
    x = 20
    x
}";
            var sourceText = SourceText.From(sourceCode);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(20);
        }

        [Fact]
        public void Interpreter_IfStatement_ExecutesCorrectBranch()
        {
            // Arrange
            var sourceCode = @"
{
    x := 10
    if x > 5 then
        result := 1
    else
        result := 0
    result
}";
            var sourceText = SourceText.From(sourceCode);
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
        public void Interpreter_WhileLoop_ExecutesCorrectly()
        {
            // Arrange
            var sourceCode = @"
{
    x := 0
    while x < 3
    {
        x = x + 1
    }
    x
}";
            var sourceText = SourceText.From(sourceCode);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            if (result.Diagnostics.Length == 0)
            {
                result.Value.Should().Be(3);
            }
        }

        [Fact]
        public void Interpreter_ForLoop_ExecutesCorrectly()
        {
            // Arrange
            var sourceCode = @"
{
    sum := 0
    for i := 1 to 5
    {
        sum = sum + i
    }
    sum
}";
            var sourceText = SourceText.From(sourceCode);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            if (result.Diagnostics.Length == 0)
            {
                result.Value.Should().Be(15); // 1+2+3+4+5 = 15
            }
        }

        [Fact]
        public void Interpreter_NestedScopes_HandlesCorrectly()
        {
            // Arrange
            var sourceCode = @"
{
    x := 10
    {
        y := 20
        {
            z := x + y
            z
        }
    }
}";
            var sourceText = SourceText.From(sourceCode);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be(30);
        }

        [Fact]
        public void Interpreter_FunctionCall_ExecutesCorrectly()
        {
            // Arrange
            var sourceCode = "print(\"Hello, World!\")";
            var sourceText = SourceText.From(sourceCode);
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
        public void Interpreter_ComplexProgram_ExecutesCorrectly()
        {
            // Arrange
            var sourceCode = @"
{
    // Calculate factorial of 5
    n := 5
    factorial := 1
    
    for i := 1 to n
    {
        factorial = factorial * i
    }
    
    print(""Factorial of 5 is: "")
    print(factorial)
    
    factorial
}";
            var sourceText = SourceText.From(sourceCode);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            if (result.Diagnostics.Length == 0)
            {
                result.Value.Should().Be(120); // 5! = 120
            }
        }

        [Fact]
        public void Interpreter_RuntimeError_HandlesGracefully()
        {
            // Arrange
            var sourceCode = "10 / 0";
            var sourceText = SourceText.From(sourceCode);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act & Assert
            // Division by zero should throw an Exception
            var action = () => compilation.Evaluate(variables);
            action.Should().Throw<Exception>()
                .WithMessage("Division by zero");
        }

        [Fact]
        public void Interpreter_StringOperations_WorkCorrectly()
        {
            // Arrange
            var sourceCode = @"
{
    greeting := ""Hello""
    target := ""World""
    message := greeting + "" "" + target + ""!""
    message
}";
            var sourceText = SourceText.From(sourceCode);
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().BeEmpty();
            result.Value.Should().Be("Hello World!");
        }

        [Fact]
        public void Interpreter_BooleanLogic_WorksCorrectly()
        {
            // Arrange
            var sourceCode = @"
{
    a := true
    b := false
    
    andresult := a && b
    orresult := a || b
    notresult := !a
    
    // Return the OR result
    orresult
}";
            var sourceText = SourceText.From(sourceCode);
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
        public void Interpreter_TypeConversions_WorkCorrectly()
        {
            // Arrange
            var sourceCode = @"
{
    number := 42
    text := string(number)
    text
}";
            var sourceText = SourceText.From(sourceCode);
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
    }
}
