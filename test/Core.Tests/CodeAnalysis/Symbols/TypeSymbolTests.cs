// <copyright file="TypeSymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis.Symbols
{
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis.Symbols;
    using Xunit;

    public class TypeSymbolTests
    {
        [Fact]
        public void Error_TypeSymbol_HasCorrectProperties()
        {
            // Act
            var errorType = TypeSymbol.Error;

            // Assert
            errorType.Name.Should().Be("?");
            errorType.Kind.Should().Be(SymbolKind.Type);
        }

        [Fact]
        public void Bool_TypeSymbol_HasCorrectProperties()
        {
            // Act
            var boolType = TypeSymbol.Bool;

            // Assert
            boolType.Name.Should().Be("bool");
            boolType.Kind.Should().Be(SymbolKind.Type);
        }

        [Fact]
        public void Int_TypeSymbol_HasCorrectProperties()
        {
            // Act
            var intType = TypeSymbol.Int;

            // Assert
            intType.Name.Should().Be("int");
            intType.Kind.Should().Be(SymbolKind.Type);
        }

        [Fact]
        public void String_TypeSymbol_HasCorrectProperties()
        {
            // Act
            var stringType = TypeSymbol.String;

            // Assert
            stringType.Name.Should().Be("string");
            stringType.Kind.Should().Be(SymbolKind.Type);
        }

        [Fact]
        public void Void_TypeSymbol_HasCorrectProperties()
        {
            // Act
            var voidType = TypeSymbol.Void;

            // Assert
            voidType.Name.Should().Be("void");
            voidType.Kind.Should().Be(SymbolKind.Type);
        }

        [Fact]
        public void All_TypeSymbols_AreUnique()
        {
            // Act
            var types = new[] 
            {
                TypeSymbol.Error,
                TypeSymbol.Bool,
                TypeSymbol.Int,
                TypeSymbol.String,
                TypeSymbol.Void
            };

            // Assert
            types.Should().OnlyHaveUniqueItems();
        }

        [Fact]
        public void All_TypeSymbols_HaveUniqueNames()
        {
            // Act
            var typeNames = new[]
            {
                TypeSymbol.Error.Name,
                TypeSymbol.Bool.Name,
                TypeSymbol.Int.Name,
                TypeSymbol.String.Name,
                TypeSymbol.Void.Name
            };

            // Assert
            typeNames.Should().OnlyHaveUniqueItems();
        }

        [Fact]
        public void TypeSymbol_Kind_IsConsistent()
        {
            // Act & Assert
            TypeSymbol.Error.Kind.Should().Be(SymbolKind.Type);
            TypeSymbol.Bool.Kind.Should().Be(SymbolKind.Type);
            TypeSymbol.Int.Kind.Should().Be(SymbolKind.Type);
            TypeSymbol.String.Kind.Should().Be(SymbolKind.Type);
            TypeSymbol.Void.Kind.Should().Be(SymbolKind.Type);
        }

        [Theory]
        [InlineData("bool")]
        [InlineData("int")]
        [InlineData("string")]
        [InlineData("void")]
        [InlineData("?")]
        public void TypeSymbol_Names_AreCorrect(string expectedName)
        {
            // Act
            var allTypes = new[]
            {
                TypeSymbol.Bool,
                TypeSymbol.Int,
                TypeSymbol.String,
                TypeSymbol.Void,
                TypeSymbol.Error
            };

            // Assert
            allTypes.Should().Contain(t => t.Name == expectedName);
        }

        [Fact]
        public void TypeSymbol_ToString_ReturnsSymbolName()
        {
            // Assert
            TypeSymbol.Bool.ToString().Should().Contain("bool");
            TypeSymbol.Int.ToString().Should().Contain("int");
            TypeSymbol.String.ToString().Should().Contain("string");
            TypeSymbol.Void.ToString().Should().Contain("void");
            TypeSymbol.Error.ToString().Should().Contain("?");
        }

        [Fact]
        public void TypeSymbol_WriteTo_ProducesOutput()
        {
            // Arrange
            using var writer = new System.IO.StringWriter();

            // Act
            TypeSymbol.Int.WriteTo(writer);
            var output = writer.ToString();

            // Assert
            output.Should().NotBeEmpty();
            output.Should().Contain("int");
        }

        [Fact]
        public void TypeSymbol_Instances_AreSingleton()
        {
            // This tests that the static instances are singletons
            // Act & Assert
            ReferenceEquals(TypeSymbol.Bool, TypeSymbol.Bool).Should().BeTrue();
            ReferenceEquals(TypeSymbol.Int, TypeSymbol.Int).Should().BeTrue();
            ReferenceEquals(TypeSymbol.String, TypeSymbol.String).Should().BeTrue();
            ReferenceEquals(TypeSymbol.Void, TypeSymbol.Void).Should().BeTrue();
            ReferenceEquals(TypeSymbol.Error, TypeSymbol.Error).Should().BeTrue();
        }

        [Fact]
        public void TypeSymbol_Equality_WorksCorrectly()
        {
            // Act & Assert
            TypeSymbol.Bool.Equals(TypeSymbol.Bool).Should().BeTrue();
            TypeSymbol.Int.Equals(TypeSymbol.String).Should().BeFalse();
            TypeSymbol.Void.Equals(null).Should().BeFalse();
        }

        [Fact]
        public void TypeSymbol_NotNull()
        {
            // Assert
            TypeSymbol.Error.Should().NotBeNull();
            TypeSymbol.Bool.Should().NotBeNull();
            TypeSymbol.Int.Should().NotBeNull();
            TypeSymbol.String.Should().NotBeNull();
            TypeSymbol.Void.Should().NotBeNull();
        }
    }
}
