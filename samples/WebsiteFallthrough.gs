package Examples.Fallthrough

import System

func trace(value int32) string {
    var result = ""
    switch value {
        case 1 {
            result += "one/"
            fallthrough
        }
        case 2 {
            result += "two/"
            fallthrough
        }
        default {
            result += "end"
        }
    }
    return result
}

Console.WriteLine(trace(1))
Console.WriteLine(trace(2))
Console.WriteLine(trace(3))

switch 1 {
    case 1 {
        Console.WriteLine("selected")
        fallthrough
    }
    case 99 {
        Console.WriteLine("explicit target")
    }
    default {
        Console.WriteLine("not reached")
    }
}
