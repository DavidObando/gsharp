// <copyright file="BoundNodeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis.Binding
{
    using System.Linq;
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis.Binding;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;
    using System.Collections.Immutable;
    using Xunit;

    public class BoundNodeTests
    {
        [Fact]
        public void BoundLiteralExpression_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            const int value = 42;

            // Act
            var node = new BoundLiteralExpression(value);

            // Assert
            node.Value.Should().Be(value);
            node.Type.Should().Be(TypeSymbol.Int);
            node.Kind.Should().Be(BoundNodeKind.LiteralExpression);
        }

        [Theory]
        [InlineData(true, "TypeSymbol.Bool")]
        [InlineData(42, "TypeSymbol.Int")]
        [InlineData("hello", "TypeSymbol.String")]
        public void BoundLiteralExpression_VariousTypes_CorrectTypeInferred(object value, string expectedTypeName)
        {
            // Arrange
            var expectedType = GetTypeByName(expectedTypeName);

            // Act
            var node = new BoundLiteralExpression(value);

            // Assert
            node.Value.Should().Be(value);
            node.Type.Should().Be(expectedType);
        }

        [Fact]
        public void BoundVariableExpression_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var variable = new LocalVariableSymbol("testVar", false, TypeSymbol.String);

            // Act
            var node = new BoundVariableExpression(variable);

            // Assert
            node.Variable.Should().Be(variable);
            node.Type.Should().Be(TypeSymbol.String);
            node.Kind.Should().Be(BoundNodeKind.VariableExpression);
        }

        [Fact]
        public void BoundAssignmentExpression_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var variable = new LocalVariableSymbol("testVar", false, TypeSymbol.Int);
            var expression = new BoundLiteralExpression(10);

            // Act
            var node = new BoundAssignmentExpression(variable, expression);

            // Assert
            node.Variable.Should().Be(variable);
            node.Expression.Should().Be(expression);
            node.Type.Should().Be(TypeSymbol.Int);
            node.Kind.Should().Be(BoundNodeKind.AssignmentExpression);
        }

        [Fact]
        public void BoundBinaryExpression_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var left = new BoundLiteralExpression(5);
            var right = new BoundLiteralExpression(3);
            var op = BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int, TypeSymbol.Int);

            // Act
            var node = new BoundBinaryExpression(left, op, right);

            // Assert
            node.Left.Should().Be(left);
            node.Op.Should().Be(op);
            node.Right.Should().Be(right);
            node.Type.Should().Be(op.Type);
            node.Kind.Should().Be(BoundNodeKind.BinaryExpression);
        }

        [Fact]
        public void BoundUnaryExpression_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var operand = new BoundLiteralExpression(true);
            var op = BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool);

            // Act
            var node = new BoundUnaryExpression(op, operand);

            // Assert
            node.Op.Should().Be(op);
            node.Operand.Should().Be(operand);
            node.Type.Should().Be(op.Type);
            node.Kind.Should().Be(BoundNodeKind.UnaryExpression);
        }

        [Fact]
        public void BoundCallExpression_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var function = new FunctionSymbol("testFunc", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.String);
            var arguments = ImmutableArray<BoundExpression>.Empty;

            // Act
            var node = new BoundCallExpression(function, arguments);

            // Assert
            node.Function.Should().Be(function);
            node.Arguments.Should().Equal(arguments);
            node.Type.Should().Be(TypeSymbol.String);
            node.Kind.Should().Be(BoundNodeKind.CallExpression);
        }

        [Fact]
        public void BoundConversionExpression_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var expression = new BoundLiteralExpression(42);
            var targetType = TypeSymbol.String;

            // Act
            var node = new BoundConversionExpression(targetType, expression);

            // Assert
            node.Type.Should().Be(targetType);
            node.Expression.Should().Be(expression);
            node.Kind.Should().Be(BoundNodeKind.ConversionExpression);
        }

        [Fact]
        public void BoundErrorExpression_Constructor_SetsPropertiesCorrectly()
        {
            // Act
            var node = new BoundErrorExpression();

            // Assert
            node.Type.Should().Be(TypeSymbol.Error);
            node.Kind.Should().Be(BoundNodeKind.ErrorExpression);
        }

        [Fact]
        public void BoundBlockStatement_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var statements = ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(new BoundLiteralExpression(1)),
                new BoundExpressionStatement(new BoundLiteralExpression(2))
            );

            // Act
            var node = new BoundBlockStatement(statements);

            // Assert
            node.Statements.Should().Equal(statements);
            node.Kind.Should().Be(BoundNodeKind.BlockStatement);
        }

        [Fact]
        public void BoundExpressionStatement_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var expression = new BoundLiteralExpression("test");

            // Act
            var node = new BoundExpressionStatement(expression);

            // Assert
            node.Expression.Should().Be(expression);
            node.Kind.Should().Be(BoundNodeKind.ExpressionStatement);
        }

        [Fact]
        public void BoundVariableDeclaration_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var variable = new LocalVariableSymbol("newVar", false, TypeSymbol.Bool);
            var initializer = new BoundLiteralExpression(true);

            // Act
            var node = new BoundVariableDeclaration(variable, initializer);

            // Assert
            node.Variable.Should().Be(variable);
            node.Initializer.Should().Be(initializer);
            node.Kind.Should().Be(BoundNodeKind.VariableDeclaration);
        }

        [Fact]
        public void BoundIfStatement_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var condition = new BoundLiteralExpression(true);
            var thenStatement = new BoundExpressionStatement(new BoundLiteralExpression(1));
            var elseStatement = new BoundExpressionStatement(new BoundLiteralExpression(2));

            // Act
            var node = new BoundIfStatement(condition, thenStatement, elseStatement);

            // Assert
            node.Condition.Should().Be(condition);
            node.ThenStatement.Should().Be(thenStatement);
            node.ElseStatement.Should().Be(elseStatement);
            node.Kind.Should().Be(BoundNodeKind.IfStatement);
        }

        [Fact]
        public void BoundLabel_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            const string name = "label1";

            // Act
            var label = new BoundLabel(name);

            // Assert
            label.Name.Should().Be(name);
        }

        [Fact]
        public void BoundLabel_ToString_ReturnsName()
        {
            // Arrange
            const string name = "testLabel";
            var label = new BoundLabel(name);

            // Act
            var result = label.ToString();

            // Assert
            result.Should().Be(name);
        }

        [Fact]
        public void BoundLabelStatement_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var label = new BoundLabel("testLabel");

            // Act
            var node = new BoundLabelStatement(label);

            // Assert
            node.Label.Should().Be(label);
            node.Kind.Should().Be(BoundNodeKind.LabelStatement);
        }

        [Fact]
        public void BoundGotoStatement_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var label = new BoundLabel("targetLabel");

            // Act
            var node = new BoundGotoStatement(label);

            // Assert
            node.Label.Should().Be(label);
            node.Kind.Should().Be(BoundNodeKind.GotoStatement);
        }

        [Fact]
        public void BoundConditionalGotoStatement_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var label = new BoundLabel("conditionalLabel");
            var condition = new BoundLiteralExpression(false);
            const bool jumpIfTrue = true;

            // Act
            var node = new BoundConditionalGotoStatement(label, condition, jumpIfTrue);

            // Assert
            node.Label.Should().Be(label);
            node.Condition.Should().Be(condition);
            node.JumpIfTrue.Should().Be(jumpIfTrue);
            node.Kind.Should().Be(BoundNodeKind.ConditionalGotoStatement);
        }

        [Fact]
        public void BoundReturnStatement_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            var expression = new BoundLiteralExpression("return value");

            // Act
            var node = new BoundReturnStatement(expression);

            // Assert
            node.Expression.Should().Be(expression);
            node.Kind.Should().Be(BoundNodeKind.ReturnStatement);
        }

        [Fact]
        public void BoundNode_ToString_ProducesOutput()
        {
            // Arrange
            var node = new BoundLiteralExpression(123);

            // Act
            var result = node.ToString();

            // Assert
            result.Should().NotBeEmpty();
            result.Should().Contain("123");
        }

        [Fact]
        public void BoundNode_DifferentKinds_HaveUniqueKindValues()
        {
            // Arrange
            var nodes = new BoundNode[]
            {
                new BoundLiteralExpression(1),
                new BoundVariableExpression(new LocalVariableSymbol("var", false, TypeSymbol.Int)),
                new BoundErrorExpression(),
                new BoundExpressionStatement(new BoundLiteralExpression(1)),
                new BoundBlockStatement(ImmutableArray<BoundStatement>.Empty)
            };

            // Act & Assert
            var kinds = nodes.Select(n => n.Kind).ToArray();
            kinds.Should().OnlyHaveUniqueItems();
        }

        private static TypeSymbol GetTypeByName(string typeName)
        {
            return typeName switch
            {
                "TypeSymbol.Int" => TypeSymbol.Int,
                "TypeSymbol.Bool" => TypeSymbol.Bool,
                "TypeSymbol.String" => TypeSymbol.String,
                "TypeSymbol.Void" => TypeSymbol.Void,
                "TypeSymbol.Error" => TypeSymbol.Error,
                _ => throw new System.ArgumentException($"Unknown type: {typeName}")
            };
        }
    }
}
