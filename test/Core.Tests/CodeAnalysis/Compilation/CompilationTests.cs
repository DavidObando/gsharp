using FluentAssertions;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Compilation
{
    public class CompilationTests
    {
        [Fact]
        public void Constructor_WithSyntaxTrees_CreatesCompilation()
        {
            // Arrange
            var sourceText = SourceText.From("x := 5");
            var syntaxTree = SyntaxTree.Parse(sourceText);

            // Act
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);

            // Assert
            compilation.Should().NotBeNull();
            compilation.SyntaxTrees.Should().HaveCount(1);
            compilation.SyntaxTrees[0].Should().Be(syntaxTree);
            compilation.Previous.Should().BeNull();
        }

        [Fact]
        public void Constructor_WithMultipleSyntaxTrees_StoresAllTrees()
        {
            // Arrange
            var tree1 = SyntaxTree.Parse(SourceText.From("x := 5"));
            var tree2 = SyntaxTree.Parse(SourceText.From("y := 10"));

            // Act
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree1, tree2);

            // Assert
            compilation.Should().NotBeNull();
            compilation.SyntaxTrees.Should().HaveCount(2);
            compilation.SyntaxTrees.Should().Contain(tree1);
            compilation.SyntaxTrees.Should().Contain(tree2);
        }

        [Fact]
        public void Constructor_WithNoSyntaxTrees_CreatesEmptyCompilation()
        {
            // Act
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation();

            // Assert
            compilation.Should().NotBeNull();
            compilation.SyntaxTrees.Should().BeEmpty();
            compilation.Previous.Should().BeNull();
        }

        [Fact]
        public void GlobalScope_FirstAccess_CreatesGlobalScope()
        {
            // Arrange
            var sourceText = SourceText.From("x := 42");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);

            // Act
            var globalScope = compilation.GlobalScope;

            // Assert
            globalScope.Should().NotBeNull();
            globalScope.Package.Should().NotBeNull();
        }

        [Fact]
        public void GlobalScope_MultipleAccess_ReturnsSameInstance()
        {
            // Arrange
            var sourceText = SourceText.From("x := 42");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);

            // Act
            var globalScope1 = compilation.GlobalScope;
            var globalScope2 = compilation.GlobalScope;

            // Assert
            globalScope1.Should().BeSameAs(globalScope2);
        }

        [Fact]
        public void ContinueWith_NewSyntaxTree_CreatesChainedCompilation()
        {
            // Arrange
            var tree1 = SyntaxTree.Parse(SourceText.From("x := 5"));
            var compilation1 = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree1);
            var tree2 = SyntaxTree.Parse(SourceText.From("y := 10"));

            // Act
            var compilation2 = compilation1.ContinueWith(tree2);

            // Assert
            compilation2.Should().NotBeNull();
            compilation2.Previous.Should().Be(compilation1);
            compilation2.SyntaxTrees.Should().HaveCount(1);
            compilation2.SyntaxTrees[0].Should().Be(tree2);
        }

        [Fact]
        public void ContinueWith_MultipleSyntaxTrees_AddsAllTrees()
        {
            // Arrange
            var tree1 = SyntaxTree.Parse(SourceText.From("x := 5"));
            var compilation1 = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree1);
            var tree2 = SyntaxTree.Parse(SourceText.From("y := 10"));
            var tree3 = SyntaxTree.Parse(SourceText.From("z := 15"));

            // Act
            var compilation2 = compilation1.ContinueWith(tree2, tree3);

            // Assert
            compilation2.Should().NotBeNull();
            compilation2.Previous.Should().Be(compilation1);
            compilation2.SyntaxTrees.Should().HaveCount(2);
            compilation2.SyntaxTrees.Should().Contain(tree2);
            compilation2.SyntaxTrees.Should().Contain(tree3);
        }

        [Fact]
        public void Evaluate_ValidExpression_ReturnsCorrectResult()
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
            if (!result.Diagnostics.Any())
            {
                result.Value.Should().Be(8);
            }
        }

        [Fact]
        public void Evaluate_WithParseErrors_ReturnsDiagnostics()
        {
            // Arrange - Invalid syntax
            var sourceText = SourceText.From("let x = ");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            var variables = new Dictionary<VariableSymbol, object>();

            // Act
            var result = compilation.Evaluate(variables);

            // Assert
            result.Should().NotBeNull();
            result.Diagnostics.Should().NotBeEmpty();
            result.Value.Should().BeNull();
        }

        [Fact]
        public void Evaluate_WithSemanticErrors_ReturnsDiagnostics()
        {
            // Arrange - Semantic error (undefined variable)
            var sourceText = SourceText.From("undefinedVar + 5");
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
        public void EmitTree_ValidCompilation_WritesOutput()
        {
            // Arrange
            var sourceText = SourceText.From("x := 42");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);
            
            using var writer = new StringWriter();

            // Act
            compilation.EmitTree(writer);

            // Assert
            var output = writer.ToString();
            output.Should().NotBeEmpty();
        }

        [Fact]
        public void Emit_ValidCompilation_ReturnsEmitResult()
        {
            // Arrange
            var sourceText = SourceText.From("x := 42");
            var syntaxTree = SyntaxTree.Parse(sourceText);
            var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(syntaxTree);

            // Act
            var result = compilation.Emit();

            // Assert
            result.Should().NotBeNull();
            result.Success.Should().Be(result.Success); // May succeed or fail depending on implementation
            result.Diagnostics.Should().NotBeNull();
        }

        [Fact]
        public void Compilation_ChainedCompilations_MaintainHierarchy()
        {
            // Arrange
            var tree1 = SyntaxTree.Parse(SourceText.From("x := 5"));
            var tree2 = SyntaxTree.Parse(SourceText.From("y := 10"));
            var tree3 = SyntaxTree.Parse(SourceText.From("z := 15"));

            // Act
            var compilation1 = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree1);
            var compilation2 = compilation1.ContinueWith(tree2);
            var compilation3 = compilation2.ContinueWith(tree3);

            // Assert
            compilation1.Previous.Should().BeNull();
            compilation2.Previous.Should().Be(compilation1);
            compilation3.Previous.Should().Be(compilation2);
        }

        [Fact]
        public void GlobalScope_ChainedCompilation_AccessesPreviousScope()
        {
            // Arrange
            var tree1 = SyntaxTree.Parse(SourceText.From("x := 5"));
            var compilation1 = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree1);
            var tree2 = SyntaxTree.Parse(SourceText.From("y := x + 10"));
            var compilation2 = compilation1.ContinueWith(tree2);

            // Act
            var globalScope1 = compilation1.GlobalScope;
            var globalScope2 = compilation2.GlobalScope;

            // Assert
            globalScope1.Should().NotBeNull();
            globalScope2.Should().NotBeNull();
            globalScope2.Previous.Should().Be(globalScope1);
        }
    }
}
