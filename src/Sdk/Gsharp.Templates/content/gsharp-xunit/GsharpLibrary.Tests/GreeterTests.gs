// file: GreeterTests.gs
//
// xUnit tests written in GSharp. Test methods live inside a public class and
// carry Kotlin-style attribute applications (@Fact, @Theory, @InlineData) that
// gsc emits as the corresponding xUnit attributes, so the standard VSTest
// runner discovers and executes them through `dotnet test`.

package GsharpLibrary.Tests

import Xunit
import GsharpLibrary

class GreeterTests {
    @Fact
    func Greet_Returns_Hello_With_Name() {
        var greeter = Greeter()

        Assert.Equal("Hello, World!", greeter.Greet("World"))
    }

    @Theory
    @InlineData("Alice", "Hello, Alice!")
    @InlineData("Bob", "Hello, Bob!")
    func Greet_Formats_Each_Name(name string, expected string) {
        var greeter = Greeter()

        Assert.Equal(expected, greeter.Greet(name))
    }
}
