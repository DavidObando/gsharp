// file: ZeroValues.gs
// Demonstrates `var` declarations without an initializer. When an explicit type
// clause is present the variable takes that type's default (zero) value, and it
// can be assigned afterwards.

package GSharp.Example.ZeroValues

import System

var x int32
var flag bool
var text string

Console.WriteLine("x=${x} flag=${flag} text=[${text}]")

x = 42
flag = true
text = "set"

Console.WriteLine("x=${x} flag=${flag} text=[${text}]")
