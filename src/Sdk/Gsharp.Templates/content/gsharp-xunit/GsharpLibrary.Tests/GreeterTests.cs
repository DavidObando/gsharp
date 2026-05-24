// <copyright file="GreeterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GsharpLibrary;
using Xunit;

namespace GsharpLibrary.Tests;

public class GreeterTests
{
    [Fact]
    public void Greet_Returns_Hello_With_Name()
    {
        var greeter = new Greeter();

        Assert.Equal("Hello, World!", greeter.Greet("World"));
    }

    [Theory]
    [InlineData("Alice", "Hello, Alice!")]
    [InlineData("Bob", "Hello, Bob!")]
    public void Greet_Formats_Each_Name(string name, string expected)
    {
        var greeter = new Greeter();

        Assert.Equal(expected, greeter.Greet(name));
    }
}
