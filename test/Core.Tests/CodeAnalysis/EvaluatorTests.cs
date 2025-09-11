using FluentAssertions;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using System.Collections.Generic;
using System.Collections.Immutable;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis
{
    public class EvaluatorTests
    {
        [Fact]
        public void Constructor_ValidParameters_CreatesEvaluator()
        {
            // Arrange
            var program = CreateSimpleProgram();
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var evaluator = new Evaluator(program, variables);

            // Assert
            evaluator.Should().NotBeNull();
        }

        [Fact]
        public void Evaluate_SimpleExpression_ReturnsCorrectValue()
        {
            // Arrange
            var program = CreateProgramWithExpression(new BoundLiteralExpression(42));
            var variables = new Dictionary<VariableSymbol, object>();
            var evaluator = new Evaluator(program, variables);

            // Act
            var result = evaluator.Evaluate();

            // Assert
            result.Should().Be(42);
        }

        [Fact]
        public void Evaluate_BinaryAddition_ReturnsSum()
        {
            // Arrange
            var left = new BoundLiteralExpression(10);
            var right = new BoundLiteralExpression(32);
            var op = BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int, TypeSymbol.Int);
            var expression = new BoundBinaryExpression(left, op, right);
            var program = CreateProgramWithExpression(expression);
            var variables = new Dictionary<VariableSymbol, object>();
            var evaluator = new Evaluator(program, variables);

            // Act
            var result = evaluator.Evaluate();

            // Assert
            result.Should().Be(42);
        }

        [Fact]
        public void Evaluate_BinarySubtraction_ReturnsDifference()
        {
            // Arrange
            var left = new BoundLiteralExpression(50);
            var right = new BoundLiteralExpression(8);
            var op = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int, TypeSymbol.Int);
            var expression = new BoundBinaryExpression(left, op, right);
            var program = CreateProgramWithExpression(expression);
            var variables = new Dictionary<VariableSymbol, object>();
            var evaluator = new Evaluator(program, variables);

            // Act
            var result = evaluator.Evaluate();

            // Assert
            result.Should().Be(42);
        }

        [Fact]
        public void Evaluate_BinaryMultiplication_ReturnsProduct()
        {
            // Arrange
            var left = new BoundLiteralExpression(6);
            var right = new BoundLiteralExpression(7);
            var op = BoundBinaryOperator.Bind(SyntaxKind.StarToken, TypeSymbol.Int, TypeSymbol.Int);
            var expression = new BoundBinaryExpression(left, op, right);
            var program = CreateProgramWithExpression(expression);
            var variables = new Dictionary<VariableSymbol, object>();
            var evaluator = new Evaluator(program, variables);

            // Act
            var result = evaluator.Evaluate();

            // Assert
            result.Should().Be(42);
        }

        [Fact]
        public void Evaluate_BinaryDivision_ReturnsQuotient()
        {
            // Arrange
            var left = new BoundLiteralExpression(84);
            var right = new BoundLiteralExpression(2);
            var op = BoundBinaryOperator.Bind(SyntaxKind.SlashToken, TypeSymbol.Int, TypeSymbol.Int);
            var expression = new BoundBinaryExpression(left, op, right);
            var program = CreateProgramWithExpression(expression);
            var variables = new Dictionary<VariableSymbol, object>();
            var evaluator = new Evaluator(program, variables);

            // Act
            var result = evaluator.Evaluate();

            // Assert
            result.Should().Be(42);
        }

        [Fact]
        public void Evaluate_UnaryMinus_ReturnsNegative()
        {
            // Arrange
            var operand = new BoundLiteralExpression(42);
            var op = BoundUnaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int);
            var expression = new BoundUnaryExpression(op, operand);
            var program = CreateProgramWithExpression(expression);
            var variables = new Dictionary<VariableSymbol, object>();
            var evaluator = new Evaluator(program, variables);

            // Act
            var result = evaluator.Evaluate();

            // Assert
            result.Should().Be(-42);
        }

        [Fact]
        public void Evaluate_UnaryPlus_ReturnsPositive()
        {
            // Arrange
            var operand = new BoundLiteralExpression(42);
            var op = BoundUnaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int);
            var expression = new BoundUnaryExpression(op, operand);
            var program = CreateProgramWithExpression(expression);
            var variables = new Dictionary<VariableSymbol, object>();
            var evaluator = new Evaluator(program, variables);

            // Act
            var result = evaluator.Evaluate();

            // Assert
            result.Should().Be(42);
        }

        [Fact]
        public void Evaluate_BooleanLiteral_True_ReturnsTrue()
        {
            // Arrange
            var program = CreateProgramWithExpression(new BoundLiteralExpression(true));
            var variables = new Dictionary<VariableSymbol, object>();
            var evaluator = new Evaluator(program, variables);

            // Act
            var result = evaluator.Evaluate();

            // Assert
            result.Should().Be(true);
        }

        [Fact]
        public void Evaluate_BooleanLiteral_False_ReturnsFalse()
        {
            // Arrange
            var program = CreateProgramWithExpression(new BoundLiteralExpression(false));
            var variables = new Dictionary<VariableSymbol, object>();
            var evaluator = new Evaluator(program, variables);

            // Act
            var result = evaluator.Evaluate();

            // Assert
            result.Should().Be(false);
        }

        [Fact]
        public void Evaluate_StringLiteral_ReturnsString()
        {
            // Arrange
            var program = CreateProgramWithExpression(new BoundLiteralExpression("Hello World"));
            var variables = new Dictionary<VariableSymbol, object>();
            var evaluator = new Evaluator(program, variables);

            // Act
            var result = evaluator.Evaluate();

            // Assert
            result.Should().Be("Hello World");
        }

        [Fact]
        public void Evaluate_VariableExpression_ReturnsVariableValue()
        {
            // Arrange
            var variable = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int);
            
            // Create a variable declaration statement first
            var initializer = new BoundLiteralExpression(42);
            var variableDeclaration = new BoundVariableDeclaration(variable, initializer);
            var variableExpression = new BoundVariableExpression(variable);
            var expressionStatement = new BoundExpressionStatement(variableExpression);
            
            var statements = ImmutableArray.Create<BoundStatement>(variableDeclaration, expressionStatement);
            var block = new BoundBlockStatement(statements);
            var functions = ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Empty;
            var program = new BoundProgram("TestProgram", ImmutableArray<Diagnostic>.Empty, functions, block);
            
            var variables = new Dictionary<VariableSymbol, object>();
            var evaluator = new Evaluator(program, variables);

            // Act
            var result = evaluator.Evaluate();

            // Assert
            result.Should().Be(42);
        }

        [Fact]
        public void Evaluate_ReturnStatement_ReturnsValue()
        {
            // Arrange
            var returnExpression = new BoundLiteralExpression(42);
            var returnStatement = new BoundReturnStatement(returnExpression);
            var statements = ImmutableArray.Create<BoundStatement>(returnStatement);
            var block = new BoundBlockStatement(statements);
            var functions = ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Empty;
            var program = new BoundProgram("TestProgram", ImmutableArray<Diagnostic>.Empty, functions, block);
            var variables = new Dictionary<VariableSymbol, object>();
            var evaluator = new Evaluator(program, variables);

            // Act
            var result = evaluator.Evaluate();

            // Assert
            result.Should().Be(42);
        }

        [Fact]
        public void Evaluate_EmptyProgram_ReturnsNull()
        {
            // Arrange
            var statements = ImmutableArray<BoundStatement>.Empty;
            var block = new BoundBlockStatement(statements);
            var functions = ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Empty;
            var program = new BoundProgram("TestProgram", ImmutableArray<Diagnostic>.Empty, functions, block);
            var variables = new Dictionary<VariableSymbol, object>();
            var evaluator = new Evaluator(program, variables);

            // Act
            var result = evaluator.Evaluate();

            // Assert
            result.Should().BeNull();
        }

        private static BoundProgram CreateSimpleProgram()
        {
            var statements = ImmutableArray<BoundStatement>.Empty;
            var block = new BoundBlockStatement(statements);
            var functions = ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Empty;
            return new BoundProgram("TestProgram", ImmutableArray<Diagnostic>.Empty, functions, block);
        }

        private static BoundProgram CreateProgramWithExpression(BoundExpression expression)
        {
            var expressionStatement = new BoundExpressionStatement(expression);
            var statements = ImmutableArray.Create<BoundStatement>(expressionStatement);
            var block = new BoundBlockStatement(statements);
            var functions = ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Empty;
            return new BoundProgram("TestProgram", ImmutableArray<Diagnostic>.Empty, functions, block);
        }
    }
}
