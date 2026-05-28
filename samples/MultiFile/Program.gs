package MultiFile

import System

var greeter = Greeter("multi-file")
var greeting = greeter.Greet()
Console.WriteLine(FormatGreeting(greeting))
