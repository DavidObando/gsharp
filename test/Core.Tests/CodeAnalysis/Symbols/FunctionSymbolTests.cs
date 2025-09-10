// <copyright file="FunctionSymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis.Symbols
{
    using System.Collections.Immutable;
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis.Symbols;
    using Xunit;

    public class FunctionSymbolTests
    {
        [Fact]
        public void Constructor_ValidParametersWithoutDeclaration_CreatesFunction()
        {
            // Arrange
            const string name = "testFunction";
            var parameters = ImmutableArray.Create(new ParameterSymbol("param1", TypeSymbol.Int));
            var returnType = TypeSymbol.String;

            // Act
            var function = new FunctionSymbol(name, parameters, returnType);

            // Assert
            function.Name.Should().Be(name);
            function.Parameters.Should().Equal(parameters);
            function.Type.Should().Be(returnType);
            function.Declaration.Should().BeNull();
            function.Kind.Should().Be(SymbolKind.Function);
        }

        [Fact]
        public void Constructor_EmptyParameters_CreatesFunction()
        {
            // Arrange
            const string name = "noParamFunction";
            var parameters = ImmutableArray<ParameterSymbol>.Empty;
            var returnType = TypeSymbol.Void;

            // Act
            var function = new FunctionSymbol(name, parameters, returnType);

            // Assert
            function.Name.Should().Be(name);
            function.Parameters.Should().BeEmpty();
            function.Type.Should().Be(returnType);
            function.Kind.Should().Be(SymbolKind.Function);
        }

        [Fact]
        public void Constructor_MultipleParameters_CreatesFunction()
        {
            // Arrange
            const string name = "multiParamFunction";
            var parameters = ImmutableArray.Create(
                new ParameterSymbol("param1", TypeSymbol.Int),
                new ParameterSymbol("param2", TypeSymbol.String),
                new ParameterSymbol("param3", TypeSymbol.Bool)
            );
            var returnType = TypeSymbol.Void;

            // Act
            var function = new FunctionSymbol(name, parameters, returnType);

            // Assert
            function.Name.Should().Be(name);
            function.Parameters.Should().HaveCount(3);
            function.Parameters[0].Name.Should().Be("param1");
            function.Parameters[0].Type.Should().Be(TypeSymbol.Int);
            function.Parameters[1].Name.Should().Be("param2");
            function.Parameters[1].Type.Should().Be(TypeSymbol.String);
            function.Parameters[2].Name.Should().Be("param3");
            function.Parameters[2].Type.Should().Be(TypeSymbol.Bool);
            function.Type.Should().Be(returnType);
        }

        [Theory]
        [InlineData("main")]
        [InlineData("print")]
        [InlineData("calculateSum")]
        [InlineData("_privateFunction")]
        public void Constructor_VariousNames_SetsNameCorrectly(string functionName)
        {
            // Arrange
            var parameters = ImmutableArray<ParameterSymbol>.Empty;
            var returnType = TypeSymbol.Void;

            // Act
            var function = new FunctionSymbol(functionName, parameters, returnType);

            // Assert
            function.Name.Should().Be(functionName);
        }

        [Theory]
        [InlineData(SymbolKind.Function)]
        public void Kind_Property_ReturnsCorrectKind(SymbolKind expectedKind)
        {
            // Arrange
            var function = new FunctionSymbol("test", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);

            // Act & Assert
            function.Kind.Should().Be(expectedKind);
        }

        [Fact]
        public void FunctionSymbol_WithVoidReturnType_IsValid()
        {
            // Arrange & Act
            var function = new FunctionSymbol("voidFunc", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);

            // Assert
            function.Type.Should().Be(TypeSymbol.Void);
        }

        [Fact]
        public void FunctionSymbol_WithValueReturnType_IsValid()
        {
            // Arrange & Act
            var function = new FunctionSymbol("intFunc", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int);

            // Assert
            function.Type.Should().Be(TypeSymbol.Int);
        }

        [Fact]
        public void FunctionSymbol_ParametersAreImmutable()
        {
            // Arrange
            var originalParams = ImmutableArray.Create(new ParameterSymbol("param", TypeSymbol.Int));
            var function = new FunctionSymbol("test", originalParams, TypeSymbol.Void);

            // Act & Assert
            function.Parameters.Should().BeEquivalentTo(originalParams);
            // Parameters should be immutable - cannot be modified after creation
            function.Parameters.Should().BeOfType<ImmutableArray<ParameterSymbol>>();
        }

        [Fact]
        public void FunctionSymbol_ToString_ContainsFunctionInfo()
        {
            // Arrange
            var parameters = ImmutableArray.Create(new ParameterSymbol("x", TypeSymbol.Int));
            var function = new FunctionSymbol("add", parameters, TypeSymbol.Int);

            // Act
            var result = function.ToString();

            // Assert
            result.Should().NotBeEmpty();
            // The exact format may vary, but it should contain the function name
            result.Should().Contain("add");
        }

        [Fact]
        public void FunctionSymbol_WriteTo_ProducesOutput()
        {
            // Arrange
            var parameters = ImmutableArray.Create(new ParameterSymbol("value", TypeSymbol.String));
            var function = new FunctionSymbol("print", parameters, TypeSymbol.Void);
            using var writer = new System.IO.StringWriter();

            // Act
            function.WriteTo(writer);
            var output = writer.ToString();

            // Assert
            output.Should().NotBeEmpty();
            output.Should().Contain("print");
        }

        [Fact]
        public void FunctionSymbol_Equality_SameInstance()
        {
            // Arrange
            var function = new FunctionSymbol("test", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);

            // Act & Assert
            function.Equals(function).Should().BeTrue();
        }

        [Fact]
        public void FunctionSymbol_Equality_DifferentInstances()
        {
            // Arrange
            var function1 = new FunctionSymbol("test", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);
            var function2 = new FunctionSymbol("test", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);

            // Act & Assert
            // They are different instances even with same properties
            ReferenceEquals(function1, function2).Should().BeFalse();
        }

        [Fact]
        public void FunctionSymbol_DifferentNames_AreDifferent()
        {
            // Arrange
            var function1 = new FunctionSymbol("func1", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);
            var function2 = new FunctionSymbol("func2", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);

            // Act & Assert
            function1.Name.Should().NotBe(function2.Name);
        }

        [Fact]
        public void FunctionSymbol_DifferentReturnTypes_AreDifferent()
        {
            // Arrange
            var function1 = new FunctionSymbol("func", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);
            var function2 = new FunctionSymbol("func", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int);

            // Act & Assert
            function1.Type.Should().NotBe(function2.Type);
        }

        [Fact]
        public void FunctionSymbol_DifferentParameterCounts_AreDifferent()
        {
            // Arrange
            var function1 = new FunctionSymbol("func", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);
            var function2 = new FunctionSymbol("func", 
                ImmutableArray.Create(new ParameterSymbol("param", TypeSymbol.Int)), TypeSymbol.Void);

            // Act & Assert
            function1.Parameters.Length.Should().NotBe(function2.Parameters.Length);
        }
    }
}
