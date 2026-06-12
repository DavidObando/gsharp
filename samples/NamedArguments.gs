// file: NamedArguments.gs
// Issue #343 sample: named arguments at call sites. Demonstrates the
// `name: value` form across:
//   - user-defined free functions
//   - user class primary constructors
//   - imported CLR static methods (Math.Max)
//   - imported CLR instance methods (string.IndexOf)
//   - mixing positional + named arguments (positional must precede named)

package GSharp.Example.NamedArguments

import System

class Point(X int32, Y int32) {
    func Sum() int32 {
        return X + Y
    }
}

func sub(x int32, y int32) int32 {
    return x - y
}

// Pure positional, all named, and mixed positional + named.
Console.WriteLine(sub(10, 3))
Console.WriteLine(sub(y: 3, x: 10))
Console.WriteLine(sub(10, y: 3))

// User class primary ctor reordered by name.
let p = Point(Y: 7, X: 3)
Console.WriteLine(p.X)
Console.WriteLine(p.Y)
Console.WriteLine(p.Sum())

// CLR static method with named argument.
Console.WriteLine(Math.Max(val1: 4, val2: 9))

// CLR instance method with named argument.
let s = "hello world"
Console.WriteLine(s.IndexOf(value: "world", startIndex: 0))
