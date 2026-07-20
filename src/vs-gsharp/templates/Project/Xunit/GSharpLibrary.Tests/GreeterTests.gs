package $ext_safeprojectname$.Tests

import Xunit
import $ext_safeprojectname$

class GreeterTests {
    @Fact
    func Greet_Returns_Hello() {
        Assert.Equal("Hello, World!", Greeter().Greet("World"))
    }
}
