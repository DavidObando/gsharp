package Website.Nullable

import System

func greet(name string?) string {
    if let person = name {
        return "Hello, $person!"
    }
    return "Hello, world!"
}

Console.WriteLine(greet("Ada"))
Console.WriteLine(greet(nil))
