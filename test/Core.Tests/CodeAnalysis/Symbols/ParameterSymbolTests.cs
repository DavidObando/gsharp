// <copyright file="ParameterSymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis.Symbols
{
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis.Symbols;
    using Xunit;

    public class ParameterSymbolTests
    {
        [Fact]
        public void Constructor_ValidNameAndType_CreatesParameter()
        {
            // Arrange
            const string name = "testParam";
            var type = TypeSymbol.Int;

            // Act
            var parameter = new ParameterSymbol(name, type);

            // Assert
            parameter.Name.Should().Be(name);
            parameter.Type.Should().Be(type);
            parameter.Kind.Should().Be(SymbolKind.Parameter);
            parameter.IsReadOnly.Should().BeTrue();
        }

        [Theory]
        [InlineData("x")]
        [InlineData("value")]
        [InlineData("param1")]
        [InlineData("_parameter")]
        [InlineData("parameterName")]
        public void Constructor_VariousNames_SetsNameCorrectly(string parameterName)
        {
            // Arrange & Act
            var parameter = new ParameterSymbol(parameterName, TypeSymbol.String);

            // Assert
            parameter.Name.Should().Be(parameterName);
        }

        [Theory]
        [MemberData(nameof(GetAllTypeSymbols))]
        public void Constructor_VariousTypes_SetsTypeCorrectly(TypeSymbol type)
        {
            // Arrange & Act
            var parameter = new ParameterSymbol("param", type);

            // Assert
            parameter.Type.Should().Be(type);
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

        [Fact]
        public void Kind_Property_ReturnsParameterKind()
        {
            // Arrange
            var parameter = new ParameterSymbol("test", TypeSymbol.Bool);

            // Act & Assert
            parameter.Kind.Should().Be(SymbolKind.Parameter);
        }

        [Fact]
        public void IsReadOnly_Property_AlwaysReturnsTrue()
        {
            // Arrange
            var parameter = new ParameterSymbol("test", TypeSymbol.Int);

            // Act & Assert
            parameter.IsReadOnly.Should().BeTrue();
        }

        [Fact]
        public void ParameterSymbol_InheritsFromLocalVariableSymbol()
        {
            // Arrange
            var parameter = new ParameterSymbol("test", TypeSymbol.String);

            // Act & Assert
            parameter.Should().BeAssignableTo<LocalVariableSymbol>();
            parameter.Should().BeAssignableTo<VariableSymbol>();
            parameter.Should().BeAssignableTo<Symbol>();
        }

        [Fact]
        public void ParameterSymbol_ToString_ContainsParameterInfo()
        {
            // Arrange
            var parameter = new ParameterSymbol("myParam", TypeSymbol.Int);

            // Act
            var result = parameter.ToString();

            // Assert
            result.Should().NotBeEmpty();
            // Should contain parameter information
            result.Should().Contain("myParam");
        }

        [Fact]
        public void ParameterSymbol_WriteTo_ProducesOutput()
        {
            // Arrange
            var parameter = new ParameterSymbol("value", TypeSymbol.String);
            using var writer = new System.IO.StringWriter();

            // Act
            parameter.WriteTo(writer);
            var output = writer.ToString();

            // Assert
            output.Should().NotBeEmpty();
            output.Should().Contain("value");
        }

        [Fact]
        public void ParameterSymbol_Equality_SameInstance()
        {
            // Arrange
            var parameter = new ParameterSymbol("test", TypeSymbol.Bool);

            // Act & Assert
            parameter.Equals(parameter).Should().BeTrue();
        }

        [Fact]
        public void ParameterSymbol_Equality_DifferentInstances()
        {
            // Arrange
            var parameter1 = new ParameterSymbol("test", TypeSymbol.Bool);
            var parameter2 = new ParameterSymbol("test", TypeSymbol.Bool);

            // Act & Assert
            // They are different instances even with same properties
            ReferenceEquals(parameter1, parameter2).Should().BeFalse();
        }

        [Fact]
        public void ParameterSymbol_DifferentNames_AreDifferent()
        {
            // Arrange
            var parameter1 = new ParameterSymbol("param1", TypeSymbol.Int);
            var parameter2 = new ParameterSymbol("param2", TypeSymbol.Int);

            // Act & Assert
            parameter1.Name.Should().NotBe(parameter2.Name);
        }

        [Fact]
        public void ParameterSymbol_DifferentTypes_AreDifferent()
        {
            // Arrange
            var parameter1 = new ParameterSymbol("param", TypeSymbol.Int);
            var parameter2 = new ParameterSymbol("param", TypeSymbol.String);

            // Act & Assert
            parameter1.Type.Should().NotBe(parameter2.Type);
        }

        [Fact]
        public void ParameterSymbol_SameNameDifferentType_StillDifferent()
        {
            // Arrange
            var parameter1 = new ParameterSymbol("value", TypeSymbol.Int);
            var parameter2 = new ParameterSymbol("value", TypeSymbol.Bool);

            // Act & Assert
            parameter1.Type.Should().NotBe(parameter2.Type);
            parameter1.Name.Should().Be(parameter2.Name);
        }

        [Fact]
        public void ParameterSymbol_SameTypeDifferentName_StillDifferent()
        {
            // Arrange
            var parameter1 = new ParameterSymbol("x", TypeSymbol.String);
            var parameter2 = new ParameterSymbol("y", TypeSymbol.String);

            // Act & Assert
            parameter1.Name.Should().NotBe(parameter2.Name);
            parameter1.Type.Should().Be(parameter2.Type);
        }

        [Fact]
        public void ParameterSymbol_ReadOnlyBehavior_ConsistentWithLocalVariable()
        {
            // Arrange
            var parameter = new ParameterSymbol("readonly_param", TypeSymbol.Int);
            var localVar = new LocalVariableSymbol("local_var", false, TypeSymbol.Int);

            // Act & Assert
            parameter.IsReadOnly.Should().BeTrue();
            localVar.IsReadOnly.Should().BeFalse();
            // Parameters are always read-only, regular local variables are not
        }

        [Fact]
        public void ParameterSymbol_MultipleParametersForFunction_EachHasCorrectProperties()
        {
            // Arrange
            var param1 = new ParameterSymbol("first", TypeSymbol.Int);
            var param2 = new ParameterSymbol("second", TypeSymbol.String);
            var param3 = new ParameterSymbol("third", TypeSymbol.Bool);

            // Act & Assert
            param1.Name.Should().Be("first");
            param1.Type.Should().Be(TypeSymbol.Int);
            param1.IsReadOnly.Should().BeTrue();
            param1.Kind.Should().Be(SymbolKind.Parameter);

            param2.Name.Should().Be("second");
            param2.Type.Should().Be(TypeSymbol.String);
            param2.IsReadOnly.Should().BeTrue();
            param2.Kind.Should().Be(SymbolKind.Parameter);

            param3.Name.Should().Be("third");
            param3.Type.Should().Be(TypeSymbol.Bool);
            param3.IsReadOnly.Should().BeTrue();
            param3.Kind.Should().Be(SymbolKind.Parameter);
        }
    }
}
