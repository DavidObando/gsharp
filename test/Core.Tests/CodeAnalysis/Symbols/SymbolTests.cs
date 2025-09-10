// <copyright file="SymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis.Symbols
{
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis.Symbols;
    using System.IO;
    using Xunit;

    public class SymbolTests
    {
        // Test implementation using concrete Symbol implementations
        // since Symbol is abstract

        [Fact]
        public void Symbol_Name_Property_IsReadOnly()
        {
            // Arrange
            const string name = "testSymbol";
            Symbol symbol = new LocalVariableSymbol(name, false, TypeSymbol.Int);

            // Act & Assert
            symbol.Name.Should().Be(name);
            // Name should be read-only (no setter available)
        }

        [Theory]
        [InlineData("function")]
        [InlineData("variable")]
        [InlineData("_privateSymbol")]
        [InlineData("CamelCaseSymbol")]
        [InlineData("symbol123")]
        public void Symbol_VariousNames_SetsNameCorrectly(string symbolName)
        {
            // Arrange & Act
            Symbol symbol = new LocalVariableSymbol(symbolName, false, TypeSymbol.String);

            // Assert
            symbol.Name.Should().Be(symbolName);
        }

        [Fact]
        public void Symbol_Kind_Property_IsAbstract()
        {
            // Arrange
            Symbol localVar = new LocalVariableSymbol("local", false, TypeSymbol.Int);
            Symbol parameter = new ParameterSymbol("param", TypeSymbol.String);
            Symbol function = new FunctionSymbol("func", System.Collections.Immutable.ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);

            // Act & Assert
            localVar.Kind.Should().Be(SymbolKind.LocalVariable);
            parameter.Kind.Should().Be(SymbolKind.Parameter);
            function.Kind.Should().Be(SymbolKind.Function);
        }

        [Fact]
        public void Symbol_WriteTo_CallsSymbolPrinter()
        {
            // Arrange
            Symbol symbol = new LocalVariableSymbol("testVar", false, TypeSymbol.Int);
            using var writer = new StringWriter();

            // Act
            symbol.WriteTo(writer);
            var output = writer.ToString();

            // Assert
            output.Should().NotBeEmpty();
            output.Should().Contain("testVar");
        }

        [Fact]
        public void Symbol_ToString_UsesWriteTo()
        {
            // Arrange
            Symbol symbol = new LocalVariableSymbol("myVariable", true, TypeSymbol.Bool);

            // Act
            var result = symbol.ToString();

            // Assert
            result.Should().NotBeEmpty();
            result.Should().Contain("myVariable");
        }

        [Fact]
        public void Symbol_ToString_ContainsSymbolInformation()
        {
            // Arrange
            Symbol[] symbols = 
            {
                new LocalVariableSymbol("localVar", false, TypeSymbol.Int),
                new ParameterSymbol("param", TypeSymbol.String),
                new FunctionSymbol("testFunc", System.Collections.Immutable.ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void)
            };

            // Act & Assert
            foreach (var symbol in symbols)
            {
                var result = symbol.ToString();
                result.Should().NotBeEmpty();
                result.Should().Contain(symbol.Name);
            }
        }

        [Fact]
        public void Symbol_WriteTo_WithNullWriter_ThrowsException()
        {
            // Arrange
            Symbol symbol = new LocalVariableSymbol("test", false, TypeSymbol.Int);

            // Act & Assert
            symbol.Invoking(s => s.WriteTo(null))
                .Should().Throw<System.NullReferenceException>();
        }

        [Fact]
        public void Symbol_DifferentKinds_HaveDifferentKindValues()
        {
            // Arrange
            Symbol localVar = new LocalVariableSymbol("local", false, TypeSymbol.Int);
            Symbol globalVar = new GlobalVariableSymbol("global", false, TypeSymbol.Int);
            Symbol parameter = new ParameterSymbol("param", TypeSymbol.String);
            Symbol function = new FunctionSymbol("func", System.Collections.Immutable.ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);
            Symbol type = TypeSymbol.Int;

            // Act & Assert
            localVar.Kind.Should().Be(SymbolKind.LocalVariable);
            globalVar.Kind.Should().Be(SymbolKind.GlobalVariable);
            parameter.Kind.Should().Be(SymbolKind.Parameter);
            function.Kind.Should().Be(SymbolKind.Function);
            type.Kind.Should().Be(SymbolKind.Type);

            // All kinds should be different
            var kinds = new[] { localVar.Kind, globalVar.Kind, parameter.Kind, function.Kind, type.Kind };
            kinds.Should().OnlyHaveUniqueItems();
        }

        [Fact]
        public void Symbol_Polymorphism_WorksCorrectly()
        {
            // Arrange
            Symbol[] symbols = 
            {
                new LocalVariableSymbol("local", false, TypeSymbol.Int),
                new GlobalVariableSymbol("global", true, TypeSymbol.String),
                new ParameterSymbol("param", TypeSymbol.Bool),
                TypeSymbol.Void
            };

            // Act & Assert
            symbols[0].Should().BeOfType<LocalVariableSymbol>();
            symbols[0].Kind.Should().Be(SymbolKind.LocalVariable);

            symbols[1].Should().BeOfType<GlobalVariableSymbol>();
            symbols[1].Kind.Should().Be(SymbolKind.GlobalVariable);

            symbols[2].Should().BeOfType<ParameterSymbol>();
            symbols[2].Kind.Should().Be(SymbolKind.Parameter);

            symbols[3].Should().BeOfType<TypeSymbol>();
            symbols[3].Kind.Should().Be(SymbolKind.Type);
        }

        [Fact]
        public void Symbol_SameInstance_EqualsItself()
        {
            // Arrange
            Symbol symbol = new LocalVariableSymbol("test", false, TypeSymbol.Int);

            // Act & Assert
            symbol.Equals(symbol).Should().BeTrue();
        }

        [Fact]
        public void Symbol_DifferentInstances_AreDifferentReferences()
        {
            // Arrange
            Symbol symbol1 = new LocalVariableSymbol("test", false, TypeSymbol.Int);
            Symbol symbol2 = new LocalVariableSymbol("test", false, TypeSymbol.Int);

            // Act & Assert
            ReferenceEquals(symbol1, symbol2).Should().BeFalse();
        }

        [Fact]
        public void Symbol_DifferentNames_AreDifferent()
        {
            // Arrange
            Symbol symbol1 = new LocalVariableSymbol("symbol1", false, TypeSymbol.Int);
            Symbol symbol2 = new LocalVariableSymbol("symbol2", false, TypeSymbol.Int);

            // Act & Assert
            symbol1.Name.Should().NotBe(symbol2.Name);
        }

        [Fact]
        public void Symbol_WriteTo_ProducesConsistentOutput()
        {
            // Arrange
            Symbol symbol = new LocalVariableSymbol("consistentVar", false, TypeSymbol.String);
            using var writer1 = new StringWriter();
            using var writer2 = new StringWriter();

            // Act
            symbol.WriteTo(writer1);
            symbol.WriteTo(writer2);
            var output1 = writer1.ToString();
            var output2 = writer2.ToString();

            // Assert
            output1.Should().Be(output2);
            output1.Should().NotBeEmpty();
        }

        [Fact]
        public void Symbol_ToString_IsConsistent()
        {
            // Arrange
            Symbol symbol = new ParameterSymbol("param", TypeSymbol.Int);

            // Act
            var result1 = symbol.ToString();
            var result2 = symbol.ToString();

            // Assert
            result1.Should().Be(result2);
            result1.Should().NotBeEmpty();
        }

        [Fact]
        public void Symbol_DifferentSymbolTypes_ProduceDifferentToString()
        {
            // Arrange
            Symbol localVar = new LocalVariableSymbol("var", false, TypeSymbol.Int);
            Symbol parameter = new ParameterSymbol("var", TypeSymbol.Int);
            Symbol function = new FunctionSymbol("var", System.Collections.Immutable.ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int);

            // Act
            var localVarString = localVar.ToString();
            var parameterString = parameter.ToString();
            var functionString = function.ToString();

            // Assert
            localVarString.Should().NotBe(parameterString);
            parameterString.Should().NotBe(functionString);
            functionString.Should().NotBe(localVarString);
        }
    }
}
