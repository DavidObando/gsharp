// file: Greeter.gs
//
// Exposed as a class (rather than a free function) so consumers in other .NET
// languages can instantiate the type and call the method through ordinary
// member dispatch. Free GSharp functions are emitted on a synthesized
// <Program> type whose name is not a valid C# identifier; classes are the
// stable cross-language entry point until GSharp grows top-level interop.

package GsharpLibrary

import System

type Greeter class {
    func Greet(name string) string {
        return "Hello, " + name + "!"
    }
}
