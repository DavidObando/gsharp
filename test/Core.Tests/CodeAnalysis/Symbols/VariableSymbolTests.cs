// <copyright file="VariableSymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis.Symbols
{
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis.Symbols;
    using Xunit;

    public class VariableSymbolTests
    {
        // Test implementation using LocalVariableSymbol as concrete implementation
        // since VariableSymbol is abstract

        [Fact]
        public void VariableSymbol_Constructor_SetsPropertiesCorrectly()
        {
            // Arrange
            const string name = "testVariable";
            const bool isReadOnly = true;
            var type = TypeSymbol.String;

            // Act
            VariableSymbol variable = new LocalVariableSymbol(name, isReadOnly, type);

            // Assert
            variable.Name.Should().Be(name);
            variable.IsReadOnly.Should().Be(isReadOnly);
            variable.Type.Should().Be(type);
        }

        [Theory]
        [InlineData("x")]
        [InlineData("variable")]
        [InlineData("myVariable")]
        [InlineData("_privateVar")]
        [InlineData("CamelCaseVar")]
        public void VariableSymbol_VariousNames_SetsNameCorrectly(string variableName)
        {
            // Arrange & Act
            VariableSymbol variable = new LocalVariableSymbol(variableName, false, TypeSymbol.Int);

            // Assert
            variable.Name.Should().Be(variableName);
        }

        [Theory]
        [MemberData(nameof(GetAllTypeSymbols))]
        public void VariableSymbol_VariousTypes_SetsTypeCorrectly(TypeSymbol type)
        {
            // Arrange & Act
            VariableSymbol variable = new LocalVariableSymbol("var", false, type);

            // Assert
            variable.Type.Should().Be(type);
        }

        public static TheoryData<TypeSymbol> GetAllTypeSymbols()
        {
            return new TheoryData<TypeSymbol>
            {
                TypeSymbol.Bool,
                TypeSymbol.Int,
                TypeSymbol.String,
                TypeSymbol.Void,
                TypeSymbol.Error
            };
        }

        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public void VariableSymbol_ReadOnlyFlag_SetsReadOnlyCorrectly(bool isReadOnly)
        {
            // Arrange & Act
            VariableSymbol variable = new LocalVariableSymbol("var", isReadOnly, TypeSymbol.Bool);

            // Assert
            variable.IsReadOnly.Should().Be(isReadOnly);
        }

        [Fact]
        public void VariableSymbol_InheritsFromSymbol()
        {
            // Arrange
            VariableSymbol variable = new LocalVariableSymbol("test", false, TypeSymbol.Int);

            // Act & Assert
            variable.Should().BeAssignableTo<Symbol>();
        }

        [Fact]
        public void VariableSymbol_ReadOnlyProperty_IsReadOnly()
        {
            // Arrange
            VariableSymbol readOnlyVariable = new LocalVariableSymbol("readonly", true, TypeSymbol.String);
            VariableSymbol mutableVariable = new LocalVariableSymbol("mutable", false, TypeSymbol.String);

            // Act & Assert
            readOnlyVariable.IsReadOnly.Should().BeTrue();
            mutableVariable.IsReadOnly.Should().BeFalse();
        }

        [Fact]
        public void VariableSymbol_TypeProperty_IsReadOnly()
        {
            // Arrange
            var type = TypeSymbol.Int;
            VariableSymbol variable = new LocalVariableSymbol("var", false, type);

            // Act & Assert
            variable.Type.Should().Be(type);
            // Type property should be read-only (no setter)
        }

        [Fact]
        public void VariableSymbol_NameProperty_IsReadOnly()
        {
            // Arrange
            const string name = "variableName";
            VariableSymbol variable = new LocalVariableSymbol(name, false, TypeSymbol.Bool);

            // Act & Assert
            variable.Name.Should().Be(name);
            // Name property should be read-only (inherited from Symbol)
        }

        [Fact]
        public void VariableSymbol_ToString_ContainsVariableInfo()
        {
            // Arrange
            VariableSymbol variable = new LocalVariableSymbol("myVar", false, TypeSymbol.Int);

            // Act
            var result = variable.ToString();

            // Assert
            result.Should().NotBeEmpty();
            result.Should().Contain("myVar");
        }

        [Fact]
        public void VariableSymbol_WriteTo_ProducesOutput()
        {
            // Arrange
            VariableSymbol variable = new LocalVariableSymbol("value", true, TypeSymbol.String);
            using var writer = new System.IO.StringWriter();

            // Act
            variable.WriteTo(writer);
            var output = writer.ToString();

            // Assert
            output.Should().NotBeEmpty();
            output.Should().Contain("value");
        }

        [Fact]
        public void VariableSymbol_DifferentImplementations_LocalVariable()
        {
            // Arrange
            VariableSymbol localVar = new LocalVariableSymbol("local", false, TypeSymbol.Int);

            // Act & Assert
            localVar.Should().BeOfType<LocalVariableSymbol>();
            localVar.Kind.Should().Be(SymbolKind.LocalVariable);
        }

        [Fact]
        public void VariableSymbol_DifferentImplementations_Parameter()
        {
            // Arrange
            VariableSymbol parameter = new ParameterSymbol("param", TypeSymbol.String);

            // Act & Assert
            parameter.Should().BeOfType<ParameterSymbol>();
            parameter.Kind.Should().Be(SymbolKind.Parameter);
            parameter.IsReadOnly.Should().BeTrue(); // Parameters are always read-only
        }

        [Fact]
        public void VariableSymbol_Polymorphism_WorksCorrectly()
        {
            // Arrange
            VariableSymbol[] variables = 
            {
                new LocalVariableSymbol("local", false, TypeSymbol.Int),
                new ParameterSymbol("param", TypeSymbol.String),
                new LocalVariableSymbol("readonly", true, TypeSymbol.Bool)
            };

            // Act & Assert
            variables[0].Should().BeOfType<LocalVariableSymbol>();
            variables[0].Kind.Should().Be(SymbolKind.LocalVariable);
            variables[0].IsReadOnly.Should().BeFalse();

            variables[1].Should().BeOfType<ParameterSymbol>();
            variables[1].Kind.Should().Be(SymbolKind.Parameter);
            variables[1].IsReadOnly.Should().BeTrue();

            variables[2].Should().BeOfType<LocalVariableSymbol>();
            variables[2].Kind.Should().Be(SymbolKind.LocalVariable);
            variables[2].IsReadOnly.Should().BeTrue();
        }

        [Fact]
        public void VariableSymbol_SameInstance_EqualsItself()
        {
            // Arrange
            VariableSymbol variable = new LocalVariableSymbol("test", false, TypeSymbol.Int);

            // Act & Assert
            variable.Equals(variable).Should().BeTrue();
        }

        [Fact]
        public void VariableSymbol_DifferentInstances_AreDifferentReferences()
        {
            // Arrange
            VariableSymbol variable1 = new LocalVariableSymbol("test", false, TypeSymbol.Int);
            VariableSymbol variable2 = new LocalVariableSymbol("test", false, TypeSymbol.Int);

            // Act & Assert
            ReferenceEquals(variable1, variable2).Should().BeFalse();
        }

        [Fact]
        public void VariableSymbol_DifferentNames_AreDifferent()
        {
            // Arrange
            VariableSymbol variable1 = new LocalVariableSymbol("var1", false, TypeSymbol.Int);
            VariableSymbol variable2 = new LocalVariableSymbol("var2", false, TypeSymbol.Int);

            // Act & Assert
            variable1.Name.Should().NotBe(variable2.Name);
        }

        [Fact]
        public void VariableSymbol_DifferentTypes_AreDifferent()
        {
            // Arrange
            VariableSymbol variable1 = new LocalVariableSymbol("var", false, TypeSymbol.Int);
            VariableSymbol variable2 = new LocalVariableSymbol("var", false, TypeSymbol.String);

            // Act & Assert
            variable1.Type.Should().NotBe(variable2.Type);
        }

        [Fact]
        public void VariableSymbol_DifferentReadOnlyFlags_AreDifferent()
        {
            // Arrange
            VariableSymbol variable1 = new LocalVariableSymbol("var", true, TypeSymbol.Int);
            VariableSymbol variable2 = new LocalVariableSymbol("var", false, TypeSymbol.Int);

            // Act & Assert
            variable1.IsReadOnly.Should().NotBe(variable2.IsReadOnly);
        }

        [Fact]
        public void VariableSymbol_WithErrorType_IsValid()
        {
            // Arrange & Act
            VariableSymbol variable = new LocalVariableSymbol("errorVar", false, TypeSymbol.Error);

            // Assert
            variable.Type.Should().Be(TypeSymbol.Error);
            variable.Name.Should().Be("errorVar");
            variable.IsReadOnly.Should().BeFalse();
        }

        [Fact]
        public void VariableSymbol_WithVoidType_IsValid()
        {
            // Arrange & Act
            VariableSymbol variable = new LocalVariableSymbol("voidVar", true, TypeSymbol.Void);

            // Assert
            variable.Type.Should().Be(TypeSymbol.Void);
            variable.Name.Should().Be("voidVar");
            variable.IsReadOnly.Should().BeTrue();
        }
    }
}
