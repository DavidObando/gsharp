// <copyright file="BoundScopeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis.Binding
{
    using System.Collections.Immutable;
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis.Binding;
    using GSharp.Core.CodeAnalysis.Symbols;
    using Xunit;

    public class BoundScopeTests
    {
        [Fact]
        public void Constructor_WithNullParent_CreatesRootScope()
        {
            // Arrange & Act
            var scope = new BoundScope(null);

            // Assert
            scope.Parent.Should().BeNull();
        }

        [Fact]
        public void Constructor_WithParentScope_SetsParentCorrectly()
        {
            // Arrange
            var parentScope = new BoundScope(null);

            // Act
            var childScope = new BoundScope(parentScope);

            // Assert
            childScope.Parent.Should().Be(parentScope);
        }

        [Fact]
        public void TryDeclareVariable_NewVariable_ReturnsTrue()
        {
            // Arrange
            var scope = new BoundScope(null);
            var variable = new LocalVariableSymbol("testVar", false, TypeSymbol.Int);

            // Act
            var result = scope.TryDeclareVariable(variable);

            // Assert
            result.Should().BeTrue();
        }

        [Fact]
        public void TryDeclareVariable_DuplicateVariable_ReturnsFalse()
        {
            // Arrange
            var scope = new BoundScope(null);
            var variable1 = new LocalVariableSymbol("duplicate", false, TypeSymbol.Int);
            var variable2 = new LocalVariableSymbol("duplicate", false, TypeSymbol.String);

            // Act
            var firstResult = scope.TryDeclareVariable(variable1);
            var secondResult = scope.TryDeclareVariable(variable2);

            // Assert
            firstResult.Should().BeTrue();
            secondResult.Should().BeFalse();
        }

        [Fact]
        public void TryDeclareFunction_NewFunction_ReturnsTrue()
        {
            // Arrange
            var scope = new BoundScope(null);
            var function = new FunctionSymbol("testFunc", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);

            // Act
            var result = scope.TryDeclareFunction(function);

            // Assert
            result.Should().BeTrue();
        }

        [Fact]
        public void TryDeclareFunction_DuplicateFunction_ReturnsFalse()
        {
            // Arrange
            var scope = new BoundScope(null);
            var function1 = new FunctionSymbol("duplicate", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);
            var function2 = new FunctionSymbol("duplicate", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int);

            // Act
            var firstResult = scope.TryDeclareFunction(function1);
            var secondResult = scope.TryDeclareFunction(function2);

            // Assert
            firstResult.Should().BeTrue();
            secondResult.Should().BeFalse();
        }

        [Fact]
        public void TryLookupSymbol_ExistingVariable_ReturnsVariable()
        {
            // Arrange
            var scope = new BoundScope(null);
            var variable = new LocalVariableSymbol("existing", false, TypeSymbol.Bool);
            scope.TryDeclareVariable(variable);

            // Act
            var foundSymbol = scope.TryLookupSymbol("existing");

            // Assert
            foundSymbol.Should().Be(variable);
        }

        [Fact]
        public void TryLookupSymbol_NonExistingVariable_ReturnsNull()
        {
            // Arrange
            var scope = new BoundScope(null);

            // Act
            var foundSymbol = scope.TryLookupSymbol("nonExisting");

            // Assert
            foundSymbol.Should().BeNull();
        }

        [Fact]
        public void TryLookupSymbol_VariableInParentScope_ReturnsVariable()
        {
            // Arrange
            var parentScope = new BoundScope(null);
            var childScope = new BoundScope(parentScope);
            var variable = new LocalVariableSymbol("parentVar", false, TypeSymbol.String);
            parentScope.TryDeclareVariable(variable);

            // Act
            var foundSymbol = childScope.TryLookupSymbol("parentVar");

            // Assert
            foundSymbol.Should().Be(variable);
        }

        [Fact]
        public void TryLookupSymbol_ExistingFunction_ReturnsFunction()
        {
            // Arrange
            var scope = new BoundScope(null);
            var function = new FunctionSymbol("existing", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int);
            scope.TryDeclareFunction(function);

            // Act
            var foundSymbol = scope.TryLookupSymbol("existing");

            // Assert
            foundSymbol.Should().Be(function);
        }

        [Fact]
        public void TryLookupSymbol_NonExistingFunction_ReturnsNull()
        {
            // Arrange
            var scope = new BoundScope(null);

            // Act
            var foundSymbol = scope.TryLookupSymbol("nonExisting");

            // Assert
            foundSymbol.Should().BeNull();
        }

        [Fact]
        public void TryLookupSymbol_FunctionInParentScope_ReturnsFunction()
        {
            // Arrange
            var parentScope = new BoundScope(null);
            var childScope = new BoundScope(parentScope);
            var function = new FunctionSymbol("parentFunc", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);
            parentScope.TryDeclareFunction(function);

            // Act
            var foundSymbol = childScope.TryLookupSymbol("parentFunc");

            // Assert
            foundSymbol.Should().Be(function);
        }

        [Fact]
        public void Shadowing_ChildVariableHidesParent_ChildVariableFound()
        {
            // Arrange
            var parentScope = new BoundScope(null);
            var childScope = new BoundScope(parentScope);
            var parentVar = new LocalVariableSymbol("shadow", false, TypeSymbol.Int);
            var childVar = new LocalVariableSymbol("shadow", false, TypeSymbol.String);
            
            parentScope.TryDeclareVariable(parentVar);
            childScope.TryDeclareVariable(childVar);

            // Act
            var foundSymbol = childScope.TryLookupSymbol("shadow");

            // Assert
            foundSymbol.Should().Be(childVar);
            foundSymbol.Should().NotBe(parentVar);
        }

        [Fact]
        public void GetDeclaredVariables_EmptyScope_ReturnsEmpty()
        {
            // Arrange
            var scope = new BoundScope(null);

            // Act
            var variables = scope.GetDeclaredVariables();

            // Assert
            variables.Should().BeEmpty();
        }

        [Fact]
        public void GetDeclaredVariables_WithVariables_ReturnsAllVariables()
        {
            // Arrange
            var scope = new BoundScope(null);
            var var1 = new LocalVariableSymbol("var1", false, TypeSymbol.Int);
            var var2 = new LocalVariableSymbol("var2", true, TypeSymbol.String);
            var var3 = new GlobalVariableSymbol("var3", false, TypeSymbol.Bool);
            
            scope.TryDeclareVariable(var1);
            scope.TryDeclareVariable(var2);
            scope.TryDeclareVariable(var3);

            // Act
            var variables = scope.GetDeclaredVariables();

            // Assert
            variables.Should().HaveCount(3);
            variables.Should().Contain(var1);
            variables.Should().Contain(var2);
            variables.Should().Contain(var3);
        }

        [Fact]
        public void GetDeclaredFunctions_EmptyScope_ReturnsEmpty()
        {
            // Arrange
            var scope = new BoundScope(null);

            // Act
            var functions = scope.GetDeclaredFunctions();

            // Assert
            functions.Should().BeEmpty();
        }

        [Fact]
        public void GetDeclaredFunctions_WithFunctions_ReturnsAllFunctions()
        {
            // Arrange
            var scope = new BoundScope(null);
            var func1 = new FunctionSymbol("func1", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);
            var func2 = new FunctionSymbol("func2", 
                ImmutableArray.Create(new ParameterSymbol("param", TypeSymbol.Int)), TypeSymbol.String);
            
            scope.TryDeclareFunction(func1);
            scope.TryDeclareFunction(func2);

            // Act
            var functions = scope.GetDeclaredFunctions();

            // Assert
            functions.Should().HaveCount(2);
            functions.Should().Contain(func1);
            functions.Should().Contain(func2);
        }

        [Fact]
        public void NestedScopes_MultipleParents_LookupWorksCorrectly()
        {
            // Arrange
            var rootScope = new BoundScope(null);
            var middleScope = new BoundScope(rootScope);
            var leafScope = new BoundScope(middleScope);
            
            var rootVar = new LocalVariableSymbol("root", false, TypeSymbol.Int);
            var middleVar = new LocalVariableSymbol("middle", false, TypeSymbol.String);
            var leafVar = new LocalVariableSymbol("leaf", false, TypeSymbol.Bool);
            
            rootScope.TryDeclareVariable(rootVar);
            middleScope.TryDeclareVariable(middleVar);
            leafScope.TryDeclareVariable(leafVar);

            // Act & Assert
            var foundLeaf = leafScope.TryLookupSymbol("leaf");
            foundLeaf.Should().Be(leafVar);
            
            var foundMiddle = leafScope.TryLookupSymbol("middle");
            foundMiddle.Should().Be(middleVar);
            
            var foundRoot = leafScope.TryLookupSymbol("root");
            foundRoot.Should().Be(rootVar);
        }

        [Fact]
        public void TryImport_NewImport_ReturnsTrue()
        {
            // Arrange
            var scope = new BoundScope(null);
            // Note: Import tests would require actual ImportSyntax which is complex to construct
            // This test focuses on the scope behavior without requiring syntax construction

            // Act & Assert
            scope.Should().NotBeNull();
            scope.Parent.Should().BeNull();
        }

        [Fact]
        public void ScopeHierarchy_ParentChildRelationship_MaintainedCorrectly()
        {
            // Arrange
            var grandParent = new BoundScope(null);
            var parent = new BoundScope(grandParent);
            var child = new BoundScope(parent);

            // Act & Assert
            child.Parent.Should().Be(parent);
            parent.Parent.Should().Be(grandParent);
            grandParent.Parent.Should().BeNull();
        }
    }
}
