using FluentAssertions;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding
{
    public class ControlFlowGraphTests
    {
        [Fact]
        public void Create_WithEmptyBlock_ReturnsValidGraph()
        {
            // Arrange
            var statements = ImmutableArray<BoundStatement>.Empty;
            var block = new BoundBlockStatement(statements);

            // Act
            var graph = ControlFlowGraph.Create(block);

            // Assert
            graph.Should().NotBeNull();
            graph.Start.Should().NotBeNull();
            graph.End.Should().NotBeNull();
            graph.Start.IsStart.Should().BeTrue();
            graph.End.IsEnd.Should().BeTrue();
            graph.Blocks.Should().NotBeEmpty();
            graph.Blocks.Should().Contain(graph.Start);
            graph.Blocks.Should().Contain(graph.End);
        }

        [Fact]
        public void Create_WithSingleStatement_CreatesCorrectFlow()
        {
            // Arrange
            var expression = new BoundLiteralExpression(42);
            var statement = new BoundExpressionStatement(expression);
            var statements = ImmutableArray.Create<BoundStatement>(statement);
            var block = new BoundBlockStatement(statements);

            // Act
            var graph = ControlFlowGraph.Create(block);

            // Assert
            graph.Should().NotBeNull();
            graph.Start.Should().NotBeNull();
            graph.End.Should().NotBeNull();
            graph.Blocks.Should().HaveCount(3); // Start, Statement block, End
        }

        [Fact]
        public void AllPathsReturn_WithNoReturn_ReturnsFalse()
        {
            // Arrange
            var expression = new BoundLiteralExpression(42);
            var statement = new BoundExpressionStatement(expression);
            var statements = ImmutableArray.Create<BoundStatement>(statement);
            var block = new BoundBlockStatement(statements);

            // Act
            var result = ControlFlowGraph.AllPathsReturn(block);

            // Assert
            result.Should().BeFalse();
        }

        [Fact]
        public void AllPathsReturn_WithReturn_ReturnsTrue()
        {
            // Arrange
            var returnExpression = new BoundLiteralExpression(42);
            var returnStatement = new BoundReturnStatement(returnExpression);
            var statements = ImmutableArray.Create<BoundStatement>(returnStatement);
            var block = new BoundBlockStatement(statements);

            // Act
            var result = ControlFlowGraph.AllPathsReturn(block);

            // Assert
            result.Should().BeTrue();
        }

        [Fact]
        public void AllPathsReturn_WithEmptyBlock_ReturnsFalse()
        {
            // Arrange
            var statements = ImmutableArray<BoundStatement>.Empty;
            var block = new BoundBlockStatement(statements);

            // Act
            var result = ControlFlowGraph.AllPathsReturn(block);

            // Assert
            result.Should().BeFalse();
        }

        [Fact]
        public void BasicBlock_Constructor_Default_CreatesNormalBlock()
        {
            // Act
            var block = new ControlFlowGraph.BasicBlock();

            // Assert
            block.IsStart.Should().BeFalse();
            block.IsEnd.Should().BeFalse();
            block.Statements.Should().BeEmpty();
            block.Incoming.Should().BeEmpty();
            block.Outgoing.Should().BeEmpty();
        }

        [Fact]
        public void BasicBlock_Constructor_WithIsStart_CreatesStartBlock()
        {
            // Act
            var block = new ControlFlowGraph.BasicBlock(isStart: true);

            // Assert
            block.IsStart.Should().BeTrue();
            block.IsEnd.Should().BeFalse();
        }

        [Fact]
        public void BasicBlock_Constructor_WithIsStartFalse_CreatesEndBlock()
        {
            // Act
            var block = new ControlFlowGraph.BasicBlock(isStart: false);

            // Assert
            block.IsStart.Should().BeFalse();
            block.IsEnd.Should().BeTrue();
        }

        [Fact]
        public void BasicBlock_ToString_StartBlock_ReturnsCorrectString()
        {
            // Arrange
            var block = new ControlFlowGraph.BasicBlock(isStart: true);

            // Act
            var result = block.ToString();

            // Assert
            result.Should().Be("<Start>");
        }

        [Fact]
        public void BasicBlock_ToString_EndBlock_ReturnsCorrectString()
        {
            // Arrange
            var block = new ControlFlowGraph.BasicBlock(isStart: false);

            // Act
            var result = block.ToString();

            // Assert
            result.Should().Be("<End>");
        }

        [Fact]
        public void BasicBlock_ToString_WithStatements_ReturnsFormattedStatements()
        {
            // Arrange
            var block = new ControlFlowGraph.BasicBlock();
            var expression = new BoundLiteralExpression(42);
            var statement = new BoundExpressionStatement(expression);
            block.Statements.Add(statement);

            // Act
            var result = block.ToString();

            // Assert
            result.Should().NotBeEmpty();
            result.Should().NotBe("<Start>");
            result.Should().NotBe("<End>");
        }

        [Fact]
        public void WriteTo_ValidGraph_WritesDotFormat()
        {
            // Arrange
            var expression = new BoundLiteralExpression(42);
            var statement = new BoundExpressionStatement(expression);
            var statements = ImmutableArray.Create<BoundStatement>(statement);
            var block = new BoundBlockStatement(statements);
            var graph = ControlFlowGraph.Create(block);
            
            using var writer = new StringWriter();

            // Act
            graph.WriteTo(writer);

            // Assert
            var output = writer.ToString();
            output.Should().Contain("digraph G {");
            output.Should().Contain("}");
            output.Should().NotBeEmpty();
        }

        [Fact]
        public void BasicBlockBranch_CanBeCreatedAndUsed()
        {
            // This tests that the BasicBlockBranch class is accessible and functional
            // We'll create a simple graph to verify branches are created properly
            
            // Arrange
            var expression = new BoundLiteralExpression(42);
            var statement = new BoundExpressionStatement(expression);
            var statements = ImmutableArray.Create<BoundStatement>(statement);
            var block = new BoundBlockStatement(statements);

            // Act
            var graph = ControlFlowGraph.Create(block);

            // Assert
            graph.Branches.Should().NotBeNull();
            graph.Start.Outgoing.Should().NotBeNull();
            graph.End.Incoming.Should().NotBeNull();
        }

        [Fact]
        public void Create_WithComplexStatements_HandlesCorrectly()
        {
            // Arrange - Create a block with multiple types of statements
            var literalExpr = new BoundLiteralExpression(42);
            var exprStatement = new BoundExpressionStatement(literalExpr);
            var returnStatement = new BoundReturnStatement(literalExpr);
            
            var statements = ImmutableArray.Create<BoundStatement>(exprStatement, returnStatement);
            var block = new BoundBlockStatement(statements);

            // Act
            var graph = ControlFlowGraph.Create(block);

            // Assert
            graph.Should().NotBeNull();
            graph.Blocks.Should().NotBeEmpty();
            graph.Branches.Should().NotBeNull();
            
            // Should return true since it ends with a return statement
            var allPathsReturn = ControlFlowGraph.AllPathsReturn(block);
            allPathsReturn.Should().BeTrue();
        }
    }
}
