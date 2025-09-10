// <copyright file="LocalVariableSymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis.Symbols
{
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis.Symbols;
    using Xunit;

    public class LocalVariableSymbolTests
    {
        [Fact]
        public void Constructor_ValidParameters_CreatesLocalVariable()
        {
            // Arrange
            const string name = "localVar";
            const bool isReadOnly = false;
            var type = TypeSymbol.Int;

            // Act
            var localVar = new LocalVariableSymbol(name, isReadOnly, type);

            // Assert
            localVar.Name.Should().Be(name);
            localVar.IsReadOnly.Should().Be(isReadOnly);
            localVar.Type.Should().Be(type);
            localVar.Kind.Should().Be(SymbolKind.LocalVariable);
        }

        [Fact]
        public void Constructor_ReadOnlyVariable_CreatesReadOnlyLocalVariable()
        {
            // Arrange
            const string name = "readOnlyVar";
            const bool isReadOnly = true;
            var type = TypeSymbol.String;

            // Act
            var localVar = new LocalVariableSymbol(name, isReadOnly, type);

            // Assert
            localVar.Name.Should().Be(name);
            localVar.IsReadOnly.Should().BeTrue();
            localVar.Type.Should().Be(type);
            localVar.Kind.Should().Be(SymbolKind.LocalVariable);
        }

        [Theory]
        [InlineData("x")]
        [InlineData("variable")]
        [InlineData("localVar1")]
        [InlineData("_localVariable")]
        [InlineData("camelCaseVariable")]
        public void Constructor_VariousNames_SetsNameCorrectly(string variableName)
        {
            // Arrange & Act
            var localVar = new LocalVariableSymbol(variableName, false, TypeSymbol.Bool);

            // Assert
            localVar.Name.Should().Be(variableName);
        }

        [Theory]
        [MemberData(nameof(GetAllTypeSymbols))]
        public void Constructor_VariousTypes_SetsTypeCorrectly(TypeSymbol type)
        {
            // Arrange & Act
            var localVar = new LocalVariableSymbol("var", false, type);

            // Assert
            localVar.Type.Should().Be(type);
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
        public void Constructor_ReadOnlyFlag_SetsReadOnlyCorrectly(bool isReadOnly)
        {
            // Arrange & Act
            var localVar = new LocalVariableSymbol("var", isReadOnly, TypeSymbol.Int);

            // Assert
            localVar.IsReadOnly.Should().Be(isReadOnly);
        }

        [Fact]
        public void Kind_Property_ReturnsLocalVariableKind()
        {
            // Arrange
            var localVar = new LocalVariableSymbol("test", false, TypeSymbol.String);

            // Act & Assert
            localVar.Kind.Should().Be(SymbolKind.LocalVariable);
        }

        [Fact]
        public void LocalVariableSymbol_InheritsFromVariableSymbol()
        {
            // Arrange
            var localVar = new LocalVariableSymbol("test", false, TypeSymbol.Int);

            // Act & Assert
            localVar.Should().BeAssignableTo<VariableSymbol>();
            localVar.Should().BeAssignableTo<Symbol>();
        }

        [Fact]
        public void LocalVariableSymbol_ToString_ContainsVariableInfo()
        {
            // Arrange
            var localVar = new LocalVariableSymbol("myVar", false, TypeSymbol.Int);

            // Act
            var result = localVar.ToString();

            // Assert
            result.Should().NotBeEmpty();
            result.Should().Contain("myVar");
        }

        [Fact]
        public void LocalVariableSymbol_WriteTo_ProducesOutput()
        {
            // Arrange
            var localVar = new LocalVariableSymbol("value", true, TypeSymbol.String);
            using var writer = new System.IO.StringWriter();

            // Act
            localVar.WriteTo(writer);
            var output = writer.ToString();

            // Assert
            output.Should().NotBeEmpty();
            output.Should().Contain("value");
        }

        [Fact]
        public void LocalVariableSymbol_Equality_SameInstance()
        {
            // Arrange
            var localVar = new LocalVariableSymbol("test", false, TypeSymbol.Bool);

            // Act & Assert
            localVar.Equals(localVar).Should().BeTrue();
        }

        [Fact]
        public void LocalVariableSymbol_Equality_DifferentInstances()
        {
            // Arrange
            var localVar1 = new LocalVariableSymbol("test", false, TypeSymbol.Bool);
            var localVar2 = new LocalVariableSymbol("test", false, TypeSymbol.Bool);

            // Act & Assert
            // They are different instances even with same properties
            ReferenceEquals(localVar1, localVar2).Should().BeFalse();
        }

        [Fact]
        public void LocalVariableSymbol_DifferentNames_AreDifferent()
        {
            // Arrange
            var localVar1 = new LocalVariableSymbol("var1", false, TypeSymbol.Int);
            var localVar2 = new LocalVariableSymbol("var2", false, TypeSymbol.Int);

            // Act & Assert
            localVar1.Name.Should().NotBe(localVar2.Name);
        }

        [Fact]
        public void LocalVariableSymbol_DifferentTypes_AreDifferent()
        {
            // Arrange
            var localVar1 = new LocalVariableSymbol("var", false, TypeSymbol.Int);
            var localVar2 = new LocalVariableSymbol("var", false, TypeSymbol.String);

            // Act & Assert
            localVar1.Type.Should().NotBe(localVar2.Type);
        }

        [Fact]
        public void LocalVariableSymbol_DifferentReadOnlyFlags_AreDifferent()
        {
            // Arrange
            var localVar1 = new LocalVariableSymbol("var", true, TypeSymbol.Int);
            var localVar2 = new LocalVariableSymbol("var", false, TypeSymbol.Int);

            // Act & Assert
            localVar1.IsReadOnly.Should().NotBe(localVar2.IsReadOnly);
        }

        [Fact]
        public void LocalVariableSymbol_ReadOnlyVariable_CannotBeModified()
        {
            // Arrange
            var readOnlyVar = new LocalVariableSymbol("const", true, TypeSymbol.String);
            var mutableVar = new LocalVariableSymbol("mutable", false, TypeSymbol.String);

            // Act & Assert
            readOnlyVar.IsReadOnly.Should().BeTrue();
            mutableVar.IsReadOnly.Should().BeFalse();
        }

        [Fact]
        public void LocalVariableSymbol_ComparedToParameterSymbol_DifferentKinds()
        {
            // Arrange
            var localVar = new LocalVariableSymbol("local", false, TypeSymbol.Int);
            var parameter = new ParameterSymbol("param", TypeSymbol.Int);

            // Act & Assert
            localVar.Kind.Should().Be(SymbolKind.LocalVariable);
            parameter.Kind.Should().Be(SymbolKind.Parameter);
            localVar.Kind.Should().NotBe(parameter.Kind);
        }

        [Fact]
        public void LocalVariableSymbol_WithErrorType_IsValid()
        {
            // Arrange & Act
            var localVar = new LocalVariableSymbol("errorVar", false, TypeSymbol.Error);

            // Assert
            localVar.Type.Should().Be(TypeSymbol.Error);
            localVar.Kind.Should().Be(SymbolKind.LocalVariable);
        }

        [Fact]
        public void LocalVariableSymbol_WithVoidType_IsValid()
        {
            // Arrange & Act
            var localVar = new LocalVariableSymbol("voidVar", false, TypeSymbol.Void);

            // Assert
            localVar.Type.Should().Be(TypeSymbol.Void);
            localVar.Kind.Should().Be(SymbolKind.LocalVariable);
        }
    }
}
