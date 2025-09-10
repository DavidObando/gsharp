// <copyright file="BuiltinFunctionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.CodeAnalysis
{
    using System.Collections.Immutable;
    using System.Linq;
    using FluentAssertions;
    using GSharp.Core.CodeAnalysis;
    using GSharp.Core.CodeAnalysis.Symbols;
    using Xunit;

    public class BuiltinFunctionsTests
    {
        [Fact]
        public void Print_Function_HasCorrectSignature()
        {
            // Act
            var printFunction = BuiltinFunctions.Print;

            // Assert
            printFunction.Name.Should().Be("print");
            printFunction.Type.Should().Be(TypeSymbol.Void);
            printFunction.Parameters.Should().HaveCount(1);
            printFunction.Parameters[0].Name.Should().Be("text");
            printFunction.Parameters[0].Type.Should().Be(TypeSymbol.String);
        }

        [Fact]
        public void Input_Function_HasCorrectSignature()
        {
            // Act
            var inputFunction = BuiltinFunctions.Input;

            // Assert
            inputFunction.Name.Should().Be("input");
            inputFunction.Type.Should().Be(TypeSymbol.String);
            inputFunction.Parameters.Should().BeEmpty();
        }

        [Fact]
        public void Rnd_Function_HasCorrectSignature()
        {
            // Act
            var rndFunction = BuiltinFunctions.Rnd;

            // Assert
            rndFunction.Name.Should().Be("rnd");
            rndFunction.Type.Should().Be(TypeSymbol.Int);
            rndFunction.Parameters.Should().HaveCount(1);
            rndFunction.Parameters[0].Name.Should().Be("max");
            rndFunction.Parameters[0].Type.Should().Be(TypeSymbol.Int);
        }

        [Fact]
        public void GetAll_ReturnsAllBuiltinFunctions()
        {
            // Act
            var allFunctions = BuiltinFunctions.GetAll().ToList();

            // Assert
            allFunctions.Should().HaveCount(3);
            allFunctions.Should().Contain(BuiltinFunctions.Print);
            allFunctions.Should().Contain(BuiltinFunctions.Input);
            allFunctions.Should().Contain(BuiltinFunctions.Rnd);
        }

        [Fact]
        public void GetAll_ReturnsDistinctFunctions()
        {
            // Act
            var allFunctions = BuiltinFunctions.GetAll().ToList();

            // Assert
            allFunctions.Should().OnlyHaveUniqueItems();
        }

        [Fact]
        public void GetAll_AllFunctionsHaveUniqueNames()
        {
            // Act
            var allFunctions = BuiltinFunctions.GetAll().ToList();
            var functionNames = allFunctions.Select(f => f.Name);

            // Assert
            functionNames.Should().OnlyHaveUniqueItems();
        }

        [Fact]
        public void Print_Function_IsNotNull()
        {
            // Assert
            BuiltinFunctions.Print.Should().NotBeNull();
        }

        [Fact]
        public void Input_Function_IsNotNull()
        {
            // Assert
            BuiltinFunctions.Input.Should().NotBeNull();
        }

        [Fact]
        public void Rnd_Function_IsNotNull()
        {
            // Assert
            BuiltinFunctions.Rnd.Should().NotBeNull();
        }

        [Theory]
        [InlineData("print")]
        [InlineData("input")]
        [InlineData("rnd")]
        public void GetAll_ContainsFunctionWithName(string expectedName)
        {
            // Act
            var allFunctions = BuiltinFunctions.GetAll();

            // Assert
            allFunctions.Should().Contain(f => f.Name == expectedName);
        }

        [Fact]
        public void BuiltinFunctions_AreConsistentlyDefined()
        {
            // Act
            var allFunctions = BuiltinFunctions.GetAll().ToList();

            // Assert
            foreach (var function in allFunctions)
            {
                function.Name.Should().NotBeNullOrWhiteSpace("function name should be defined");
                function.Type.Should().NotBeNull("function return type should be defined");
                function.Parameters.Should().NotBeNull("function parameters should be defined");
                
                // All parameter names should be unique within a function
                var parameterNames = function.Parameters.Select(p => p.Name);
                parameterNames.Should().OnlyHaveUniqueItems("parameter names should be unique within a function");
            }
        }

        [Fact]
        public void Print_Function_HasVoidReturnType()
        {
            // Assert
            BuiltinFunctions.Print.Type.Should().Be(TypeSymbol.Void, "print function should not return a value");
        }

        [Fact]
        public void Input_Function_HasStringReturnType()
        {
            // Assert
            BuiltinFunctions.Input.Type.Should().Be(TypeSymbol.String, "input function should return a string");
        }

        [Fact]
        public void Rnd_Function_HasIntReturnType()
        {
            // Assert
            BuiltinFunctions.Rnd.Type.Should().Be(TypeSymbol.Int, "rnd function should return an integer");
        }

        [Fact]
        public void Functions_ParameterTypes_AreBuiltinTypes()
        {
            // Act
            var allFunctions = BuiltinFunctions.GetAll();

            // Assert
            var builtinTypes = new[] { TypeSymbol.Void, TypeSymbol.Bool, TypeSymbol.Int, TypeSymbol.String };
            
            foreach (var function in allFunctions)
            {
                function.Type.Should().BeOneOf(builtinTypes, $"function {function.Name} should return a builtin type");
                
                foreach (var parameter in function.Parameters)
                {
                    parameter.Type.Should().BeOneOf(builtinTypes, 
                        $"parameter {parameter.Name} in function {function.Name} should be a builtin type");
                }
            }
        }
    }
}
