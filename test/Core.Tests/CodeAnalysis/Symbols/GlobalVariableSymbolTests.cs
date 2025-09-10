// <copyright file="GlobalVariableSymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis.Symbols
{
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis.Symbols;
    using Xunit;

    public class GlobalVariableSymbolTests
    {
        [Fact]
        public void Constructor_ValidParameters_CreatesGlobalVariable()
        {
            // Arrange
            const string name = "globalVar";
            const bool isReadOnly = false;
            var type = TypeSymbol.Int;

            // Act
            var globalVar = new GlobalVariableSymbol(name, isReadOnly, type);

            // Assert
            globalVar.Name.Should().Be(name);
            globalVar.IsReadOnly.Should().Be(isReadOnly);
            globalVar.Type.Should().Be(type);
            globalVar.Kind.Should().Be(SymbolKind.GlobalVariable);
        }

        [Fact]
        public void Constructor_ReadOnlyGlobalVariable_CreatesReadOnlyGlobalVariable()
        {
            // Arrange
            const string name = "readOnlyGlobal";
            const bool isReadOnly = true;
            var type = TypeSymbol.String;

            // Act
            var globalVar = new GlobalVariableSymbol(name, isReadOnly, type);

            // Assert
            globalVar.Name.Should().Be(name);
            globalVar.IsReadOnly.Should().BeTrue();
            globalVar.Type.Should().Be(type);
            globalVar.Kind.Should().Be(SymbolKind.GlobalVariable);
        }

        [Theory]
        [InlineData("GLOBAL_CONSTANT")]
        [InlineData("globalVariable")]
        [InlineData("g_var")]
        [InlineData("_privateGlobal")]
        [InlineData("PascalCaseGlobal")]
        public void Constructor_VariousNames_SetsNameCorrectly(string variableName)
        {
            // Arrange & Act
            var globalVar = new GlobalVariableSymbol(variableName, false, TypeSymbol.Bool);

            // Assert
            globalVar.Name.Should().Be(variableName);
        }

        [Theory]
        [MemberData(nameof(GetAllTypeSymbols))]
        public void Constructor_VariousTypes_SetsTypeCorrectly(TypeSymbol type)
        {
            // Arrange & Act
            var globalVar = new GlobalVariableSymbol("global", false, type);

            // Assert
            globalVar.Type.Should().Be(type);
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
            var globalVar = new GlobalVariableSymbol("global", isReadOnly, TypeSymbol.Int);

            // Assert
            globalVar.IsReadOnly.Should().Be(isReadOnly);
        }

        [Fact]
        public void Kind_Property_ReturnsGlobalVariableKind()
        {
            // Arrange
            var globalVar = new GlobalVariableSymbol("test", false, TypeSymbol.String);

            // Act & Assert
            globalVar.Kind.Should().Be(SymbolKind.GlobalVariable);
        }

        [Fact]
        public void GlobalVariableSymbol_InheritsFromVariableSymbol()
        {
            // Arrange
            var globalVar = new GlobalVariableSymbol("test", false, TypeSymbol.Int);

            // Act & Assert
            globalVar.Should().BeAssignableTo<VariableSymbol>();
            globalVar.Should().BeAssignableTo<Symbol>();
        }

        [Fact]
        public void GlobalVariableSymbol_ToString_ContainsVariableInfo()
        {
            // Arrange
            var globalVar = new GlobalVariableSymbol("myGlobal", false, TypeSymbol.Int);

            // Act
            var result = globalVar.ToString();

            // Assert
            result.Should().NotBeEmpty();
            result.Should().Contain("myGlobal");
        }

        [Fact]
        public void GlobalVariableSymbol_WriteTo_ProducesOutput()
        {
            // Arrange
            var globalVar = new GlobalVariableSymbol("value", true, TypeSymbol.String);
            using var writer = new System.IO.StringWriter();

            // Act
            globalVar.WriteTo(writer);
            var output = writer.ToString();

            // Assert
            output.Should().NotBeEmpty();
            output.Should().Contain("value");
        }

        [Fact]
        public void GlobalVariableSymbol_Equality_SameInstance()
        {
            // Arrange
            var globalVar = new GlobalVariableSymbol("test", false, TypeSymbol.Bool);

            // Act & Assert
            globalVar.Equals(globalVar).Should().BeTrue();
        }

        [Fact]
        public void GlobalVariableSymbol_Equality_DifferentInstances()
        {
            // Arrange
            var globalVar1 = new GlobalVariableSymbol("test", false, TypeSymbol.Bool);
            var globalVar2 = new GlobalVariableSymbol("test", false, TypeSymbol.Bool);

            // Act & Assert
            // They are different instances even with same properties
            ReferenceEquals(globalVar1, globalVar2).Should().BeFalse();
        }

        [Fact]
        public void GlobalVariableSymbol_DifferentNames_AreDifferent()
        {
            // Arrange
            var globalVar1 = new GlobalVariableSymbol("global1", false, TypeSymbol.Int);
            var globalVar2 = new GlobalVariableSymbol("global2", false, TypeSymbol.Int);

            // Act & Assert
            globalVar1.Name.Should().NotBe(globalVar2.Name);
        }

        [Fact]
        public void GlobalVariableSymbol_DifferentTypes_AreDifferent()
        {
            // Arrange
            var globalVar1 = new GlobalVariableSymbol("global", false, TypeSymbol.Int);
            var globalVar2 = new GlobalVariableSymbol("global", false, TypeSymbol.String);

            // Act & Assert
            globalVar1.Type.Should().NotBe(globalVar2.Type);
        }

        [Fact]
        public void GlobalVariableSymbol_DifferentReadOnlyFlags_AreDifferent()
        {
            // Arrange
            var globalVar1 = new GlobalVariableSymbol("global", true, TypeSymbol.Int);
            var globalVar2 = new GlobalVariableSymbol("global", false, TypeSymbol.Int);

            // Act & Assert
            globalVar1.IsReadOnly.Should().NotBe(globalVar2.IsReadOnly);
        }

        [Fact]
        public void GlobalVariableSymbol_ComparedToLocalVariable_DifferentKinds()
        {
            // Arrange
            var globalVar = new GlobalVariableSymbol("global", false, TypeSymbol.Int);
            var localVar = new LocalVariableSymbol("local", false, TypeSymbol.Int);

            // Act & Assert
            globalVar.Kind.Should().Be(SymbolKind.GlobalVariable);
            localVar.Kind.Should().Be(SymbolKind.LocalVariable);
            globalVar.Kind.Should().NotBe(localVar.Kind);
        }

        [Fact]
        public void GlobalVariableSymbol_ComparedToParameter_DifferentKinds()
        {
            // Arrange
            var globalVar = new GlobalVariableSymbol("global", false, TypeSymbol.Int);
            var parameter = new ParameterSymbol("param", TypeSymbol.Int);

            // Act & Assert
            globalVar.Kind.Should().Be(SymbolKind.GlobalVariable);
            parameter.Kind.Should().Be(SymbolKind.Parameter);
            globalVar.Kind.Should().NotBe(parameter.Kind);
        }

        [Fact]
        public void GlobalVariableSymbol_ReadOnlyGlobal_CannotBeModified()
        {
            // Arrange
            var readOnlyGlobal = new GlobalVariableSymbol("CONSTANT", true, TypeSymbol.String);
            var mutableGlobal = new GlobalVariableSymbol("mutable", false, TypeSymbol.String);

            // Act & Assert
            readOnlyGlobal.IsReadOnly.Should().BeTrue();
            mutableGlobal.IsReadOnly.Should().BeFalse();
        }

        [Fact]
        public void GlobalVariableSymbol_WithErrorType_IsValid()
        {
            // Arrange & Act
            var globalVar = new GlobalVariableSymbol("errorGlobal", false, TypeSymbol.Error);

            // Assert
            globalVar.Type.Should().Be(TypeSymbol.Error);
            globalVar.Kind.Should().Be(SymbolKind.GlobalVariable);
        }

        [Fact]
        public void GlobalVariableSymbol_WithVoidType_IsValid()
        {
            // Arrange & Act
            var globalVar = new GlobalVariableSymbol("voidGlobal", false, TypeSymbol.Void);

            // Assert
            globalVar.Type.Should().Be(TypeSymbol.Void);
            globalVar.Kind.Should().Be(SymbolKind.GlobalVariable);
        }

        [Fact]
        public void GlobalVariableSymbol_AsVariableSymbol_WorksPolymorphically()
        {
            // Arrange
            VariableSymbol variable = new GlobalVariableSymbol("polymorphic", true, TypeSymbol.Bool);

            // Act & Assert
            variable.Should().BeOfType<GlobalVariableSymbol>();
            variable.Kind.Should().Be(SymbolKind.GlobalVariable);
            variable.IsReadOnly.Should().BeTrue();
            variable.Type.Should().Be(TypeSymbol.Bool);
            variable.Name.Should().Be("polymorphic");
        }

        [Fact]
        public void GlobalVariableSymbol_SealedClass_CannotBeInherited()
        {
            // Arrange & Act
            var globalVar = new GlobalVariableSymbol("sealed", false, TypeSymbol.Int);

            // Assert
            globalVar.GetType().IsSealed.Should().BeTrue();
        }
    }
}
